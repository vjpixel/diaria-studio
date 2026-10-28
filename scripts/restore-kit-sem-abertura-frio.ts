#!/usr/bin/env node
/**
 * scripts/restore-kit-sem-abertura-frio.ts (#11221, itens 6 e 7 da decisão)
 *
 * Desfaz o "sai das duas bases" do #10437 para os frios do Kit:
 *
 *  A) os DESCADASTRADOS de 25/10/2026 — eventos `kit_unsubscribed` com
 *     `brevo_exit: "suppress"` em `data/brevo-diaria/kit-sem-abertura-log*.jsonl`
 *     (o glob pega também os `*-safeBackup-*` do OneDrive). Ficam ativos no
 *     Kit com a tag `frio` e SEM `envio-brevo`, entrando direto na semanal.
 *  B) os `kit-sem-abertura:` ainda `in_brevo` no store: voltam pro Kit com
 *     `frio`, saem da lista Brevo (sem blacklist) e o store grava
 *     `converted_to_kit` / `kit_sem_abertura_frio`.
 *  C) os `kit-sem-abertura:` que o `evaluate-brevo-diaria.ts` suprimiu SÓ na
 *     Brevo enquanto o frio não estava ligado (`suppressed` /
 *     `kit_sem_abertura_aguardando_frio`, premissa B do review): já fora da
 *     lista Brevo, ativos no Kit com `envio-brevo`; ganham `frio`, perdem
 *     `envio-brevo` e o store vira `converted_to_kit` / `kit_sem_abertura_frio`.
 *
 * ## Só com o frio plenamente ligado
 *
 * `--apply` exige `parseKitFrio().fullyOn` (flags + segmento da diária
 * confirmado excluindo `frio`): aplicar `frio` sem a semanal ligada, ou sem
 * o segmento, deixaria a pessoa sem edição ou com a de segunda em dobro.
 * O dry-run roda sempre.
 *
 * ## Reativar `cancelled` pela API: NÃO
 *
 * A doc do Kit v4 (`POST /v4/subscribers`, lida em 27/10/2026) diz que o
 * upsert de um e-mail existente "updates the first name" e que "Updating the
 * subscriber state with this endpoint is not supported"; o #8728 mediu ao
 * vivo que `state: "active"` é ignorado pra quem já existe não-ativo. A doc do
 * vínculo a form não promete reativar `cancelled`. Este script não tenta:
 * quem está `cancelled` vai pra lista `data/kit-frio/reativar-no-painel.csv`
 * (reativar à mão no painel do Kit) e, rodado de novo depois, o script
 * encontra o assinante `active` e aplica as tags. Idempotente. O CSV só é
 * gravado com `--apply` (o dry-run só informa a contagem no log).
 *
 * Só entra no CSV o `cancelled` que NÓS fizemos (`descadastrado_por_supressao`,
 * #11430). Nas origens `in_brevo`/`suprimido_aguardando_frio` o nosso fluxo
 * deixou a pessoa `active` no Kit: `cancelled` ali é opt-out da própria
 * pessoa (rodapé/preferências do Kit), e reativá-la seria voltar a enviar pra
 * quem pediu pra sair. Esses saem como `descadastro_proprio`, só no log.
 *
 * Ordem por assinante (nunca sem canal): `frio` aplicada e RELIDA antes de
 * tirar `envio-brevo` (relida também). Nunca descadastra ninguém.
 *
 *   npx tsx scripts/restore-kit-sem-abertura-frio.ts            # dry-run (lê Kit/store, não escreve)
 *   npx tsx scripts/restore-kit-sem-abertura-frio.ts --apply
 *
 * Exit: 0 ok; 1 falha em algum assinante; 2 precondição (tag `frio`/`envio-brevo`
 * inexistente, chave ausente).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { brevoPut } from "./lib/brevo-client.ts";
import { findTagIdByName } from "./lib/kit-broadcasts.ts";
import { getSubscriberById } from "./lib/kit-subscribers.ts";
import { listSubscriberTags } from "./lib/kit-broadcasts.ts";
import {
  DEFAULT_STORE_PATH,
  applyConvertedToKit,
  applyKitSemAberturaFrioFromSuppressed,
  normalizeEmail,
  readStore,
  writeStore,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";
import { ORIGIN_PREFIX } from "./lib/shared/brevo-diaria-origin.ts";
import { KIT_ENVIO_BREVO_TAG_NAME } from "./lib/kit-diaria-audience.ts";
import { DEFAULT_KIT_SEM_ABERTURA_LOG_PATH, formatKitSemAberturaLogLine } from "./lib/kit-sem-abertura.ts";
import { KIT_FRIO_TAG_NAME, kitFrioNotFullyOnReason, parseKitFrio, type KitFrioParse } from "./lib/kit-frio.ts";
import { appendFileWithRetry } from "./lib/source-runs.ts";
import { createRequestPacer } from "./kit-provider-split.ts";
import { KIT_MIN_INTERVAL_MS, tagAndConfirm, untagAndConfirm } from "./sync-kit-sem-abertura-to-brevo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_LIST_PATH = resolve(ROOT, "data/kit-frio/reativar-no-painel.csv");

export interface RestoreTarget {
  email: string;
  kitSubscriberId: number;
  /**
   * `descadastrado_por_supressao`: `kit_unsubscribed`+`suppress` no log (os
   * de 25/10/2026 e quaisquer outros do mesmo fluxo); `in_brevo`: resíduo do
   * #10437 no store; `suprimido_aguardando_frio`: premissa B (ver docstring).
   */
  source: "descadastrado_por_supressao" | "in_brevo" | "suprimido_aguardando_frio";
}

/**
 * Pura — alvos A (log) e B (store). O log pode ter linhas ilegíveis
 * (arquivo em conflito do OneDrive): contadas e ignoradas, nunca lançam.
 */
export function collectRestoreTargets(
  logTexts: readonly string[],
  contacts: BrevoDiariaStore["contacts"],
): { targets: RestoreTarget[]; badLines: number } {
  const byEmail = new Map<string, RestoreTarget>();
  let badLines = 0;
  for (const text of logTexts) {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let j: { event?: unknown; brevo_exit?: unknown; email?: unknown; kit_subscriber_id?: unknown };
      try {
        j = JSON.parse(line);
      } catch {
        badLines++;
        continue;
      }
      if (j.event !== "kit_unsubscribed" || j.brevo_exit !== "suppress") continue;
      if (typeof j.email !== "string" || typeof j.kit_subscriber_id !== "number") continue;
      const email = normalizeEmail(j.email);
      if (!byEmail.has(email)) byEmail.set(email, { email, kitSubscriberId: j.kit_subscriber_id, source: "descadastrado_por_supressao" });
    }
  }
  for (const c of contacts) {
    if (!c.beehiiv_subscription_id.startsWith(ORIGIN_PREFIX.KIT_SEM_ABERTURA)) continue;
    const source: RestoreTarget["source"] | null =
      c.status === "in_brevo"
        ? "in_brevo"
        : c.status === "suppressed" && c.resolution_reason === "kit_sem_abertura_aguardando_frio"
          ? "suprimido_aguardando_frio"
          : null;
    if (source === null) continue;
    const raw = c.beehiiv_subscription_id.slice(ORIGIN_PREFIX.KIT_SEM_ABERTURA.length);
    const id = /^[0-9]+$/.test(raw) ? Number(raw) : 0;
    if (id > 0) byEmail.set(normalizeEmail(c.email), { email: normalizeEmail(c.email), kitSubscriberId: id, source });
  }
  return { targets: [...byEmail.values()], badLines };
}

export type RestoreStep = "ja_ok" | "tags" | "painel" | "descadastro_proprio" | "estado_nao_reativavel";

/**
 * Pura — o que fazer com o assinante, pelo estado e tags atuais no Kit e pela
 * origem do alvo. `cancelled` só vai pro painel quando o descadastro foi nosso
 * (`descadastrado_por_supressao`); nas outras origens é opt-out da pessoa e
 * nunca se reativa (#11430).
 */
export function decideKitRestore(state: string, tagNames: readonly string[], source: RestoreTarget["source"]): RestoreStep {
  if (state === "cancelled") return source === "descadastrado_por_supressao" ? "painel" : "descadastro_proprio";
  if (state !== "active") return "estado_nao_reativavel"; // bounced/complained/inactive: não é o caso desta reparação
  if (tagNames.includes(KIT_FRIO_TAG_NAME) && !tagNames.includes(KIT_ENVIO_BREVO_TAG_NAME)) return "ja_ok";
  return "tags";
}

export interface KitRestoreDeps {
  log: (msg: string) => void;
  getKit: (id: number) => Promise<{ state: string; tagNames: string[] }>;
  findTagId: (name: string) => Promise<number | null>;
  tag: (tagId: number, id: number) => Promise<void>;
  untag: (tagId: number, id: number) => Promise<void>;
  unlinkBrevo: (email: string) => Promise<void>;
  readStore: () => BrevoDiariaStore;
  writeStore: (s: BrevoDiariaStore) => void;
  writePanelList: (rows: RestoreTarget[]) => void;
  appendLog: (line: string) => void;
  nowIso: () => string;
}

export async function runKitSemAberturaRestore(
  targets: readonly RestoreTarget[],
  opts: { apply: boolean; frio: KitFrioParse },
  deps: KitRestoreDeps,
): Promise<{ code: 0 | 1 | 2; counts: Record<RestoreStep | "aplicado" | "falha", number> }> {
  const { log } = deps;
  const counts: Record<RestoreStep | "aplicado" | "falha", number> = {
    ja_ok: 0,
    tags: 0,
    painel: 0,
    descadastro_proprio: 0,
    estado_nao_reativavel: 0,
    aplicado: 0,
    falha: 0,
  };
  let frioId: number | null = null;
  let envioId: number | null = null;
  if (opts.apply && ("error" in opts.frio || !opts.frio.fullyOn)) {
    log(
      `ERRO: --apply exige kit.frio plenamente ligado (${kitFrioNotFullyOnReason(opts.frio)}) — ` +
        "frio sem a semanal/segmento deixaria a pessoa sem edição ou com a de segunda em dobro (#11221).",
    );
    return { code: 2, counts };
  }
  if (opts.apply) {
    frioId = await deps.findTagId(KIT_FRIO_TAG_NAME);
    envioId = await deps.findTagId(KIT_ENVIO_BREVO_TAG_NAME);
    if (frioId === null || envioId === null) {
      log(`ERRO: tag "${frioId === null ? KIT_FRIO_TAG_NAME : KIT_ENVIO_BREVO_TAG_NAME}" não existe no Kit — crie no painel antes (#11221).`);
      return { code: 2, counts };
    }
  }
  const panel: RestoreTarget[] = [];
  let store = deps.readStore();
  for (const t of targets) {
    let kit: { state: string; tagNames: string[] };
    try {
      kit = await deps.getKit(t.kitSubscriberId);
    } catch (e) {
      counts.falha++;
      log(`FALHA ao ler ${t.email} no Kit: ${(e as Error).message}`);
      continue;
    }
    const step = decideKitRestore(kit.state, kit.tagNames, t.source);
    counts[step]++;
    if (step === "painel") panel.push(t);
    if (step === "descadastro_proprio") log(`${t.email}: cancelled no Kit por opt-out próprio (origem ${t.source}) — não reativar (#11430).`);
    if (step === "estado_nao_reativavel") log(`${t.email}: estado '${kit.state}' no Kit — fora desta reparação.`);
    if (!opts.apply) continue;
    try {
      if (step === "tags") {
        // `frio` primeiro (relida), depois tira `envio-brevo` (relida): cair no
        // meio deixa as duas tags (fora da diária, na semanal), nunca sem canal.
        if (!kit.tagNames.includes(KIT_FRIO_TAG_NAME)) await deps.tag(frioId!, t.kitSubscriberId);
        if (kit.tagNames.includes(KIT_ENVIO_BREVO_TAG_NAME)) await deps.untag(envioId!, t.kitSubscriberId);
      }
      if ((step === "tags" || step === "ja_ok") && t.source === "in_brevo") {
        await deps.unlinkBrevo(t.email);
        store = applyConvertedToKit(store, t.email, deps.nowIso(), "kit_sem_abertura_frio");
        deps.writeStore(store);
      }
      if ((step === "tags" || step === "ja_ok") && t.source === "suprimido_aguardando_frio") {
        // Já fora da lista Brevo (o evaluate desvinculou); só o store muda.
        store = applyKitSemAberturaFrioFromSuppressed(store, t.email, deps.nowIso());
        deps.writeStore(store);
      }
      if (step === "tags" || (step === "ja_ok" && t.source !== "descadastrado_por_supressao")) {
        counts.aplicado++;
        try {
          deps.appendLog(
            formatKitSemAberturaLogLine({ ts: deps.nowIso(), event: "kit_returned_frio", email: t.email, kit_subscriber_id: t.kitSubscriberId, step: "restore" }),
          );
        } catch (e) {
          log(`aviso: log de ${t.email} não gravado (${(e as Error).message}).`);
        }
      }
    } catch (e) {
      counts.falha++;
      log(`FALHA ao devolver ${t.email} ao Kit com ${KIT_FRIO_TAG_NAME}: ${(e as Error).message}`);
    }
  }
  if (panel.length > 0) {
    log(`${panel.length} assinante(s) cancelled no Kit: a API não reativa — reativar no PAINEL do Kit e rodar este script de novo.`);
    if (opts.apply) deps.writePanelList(panel);
  }
  log(`${opts.apply ? "" : "[dry-run] "}${JSON.stringify(counts)}`);
  return { code: counts.falha > 0 ? 1 : 0, counts };
}

/** Lê todos os `kit-sem-abertura-log*.jsonl` (inclui os `-safeBackup-*` do OneDrive). */
export function readKitSemAberturaLogs(dir: string = dirname(DEFAULT_KIT_SEM_ABERTURA_LOG_PATH)): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^kit-sem-abertura-log.*\.jsonl$/.test(f))
    .sort()
    .map((f) => readFileSync(resolve(dir, f), "utf8"));
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "apply");
  const log = (msg: string) => process.stderr.write(`[restore-kit-sem-abertura-frio] ${msg}\n`);
  const kitCfg = resolveKitConfig();
  if (!kitCfg.ok) {
    log(`ERRO: ${kitCfg.reason}`);
    process.exitCode = 2;
    return;
  }
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as {
    brevo_diaria?: { api_key_env: string; list_id: number | null };
    kit?: unknown;
  };
  const frio = parseKitFrio(cfg.kit);
  const brevoKey = cfg.brevo_diaria ? process.env[cfg.brevo_diaria.api_key_env] : undefined;
  const listId = cfg.brevo_diaria?.list_id;
  const store = readStore(DEFAULT_STORE_PATH);
  const { targets, badLines } = collectRestoreTargets(readKitSemAberturaLogs(), store.contacts);
  if (badLines > 0) log(`aviso: ${badLines} linha(s) ilegível(is) nos logs (ignoradas).`);
  log(
    `${targets.filter((t) => t.source === "descadastrado_por_supressao").length} descadastrado(s) por supressão no log, ` +
      `${targets.filter((t) => t.source === "in_brevo").length} kit-sem-abertura: ainda in_brevo, ` +
      `${targets.filter((t) => t.source === "suprimido_aguardando_frio").length} suprimido(s) só na Brevo aguardando o frio.`,
  );
  if (apply && targets.some((t) => t.source === "in_brevo") && (!brevoKey || listId == null)) {
    log("ERRO: há kit-sem-abertura: in_brevo e a chave/lista da Brevo diária não está disponível — não dá pra desvinculá-los.");
    process.exitCode = 2;
    return;
  }
  const pace = createRequestPacer(KIT_MIN_INTERVAL_MS);
  const result = await runKitSemAberturaRestore(targets, { apply, frio }, {
    log,
    getKit: async (id) => {
      await pace();
      const s = await getSubscriberById(id);
      await pace();
      const tags = await listSubscriberTags(id);
      return { state: s.state, tagNames: tags.map((t) => t.name) };
    },
    findTagId: async (name) => {
      await pace();
      return findTagIdByName(name);
    },
    tag: (tagId, id) => tagAndConfirm(tagId, id, pace),
    untag: (tagId, id) => untagAndConfirm(tagId, id, pace),
    unlinkBrevo: async (email) => {
      await brevoPut(brevoKey!, `/contacts/${encodeURIComponent(email)}`, { unlinkListIds: [listId as number] });
    },
    readStore: () => readStore(DEFAULT_STORE_PATH),
    writeStore: (s) => writeStore(s, DEFAULT_STORE_PATH),
    writePanelList: (rows) => {
      mkdirSync(dirname(PANEL_LIST_PATH), { recursive: true });
      writeFileSync(PANEL_LIST_PATH, "email,kit_subscriber_id\n" + rows.map((r) => `${r.email},${r.kitSubscriberId}`).join("\n") + "\n");
      log(`lista pra reativação no painel: ${PANEL_LIST_PATH}`);
    },
    appendLog: (line) => appendFileWithRetry(DEFAULT_KIT_SEM_ABERTURA_LOG_PATH, line),
    nowIso: () => new Date().toISOString(),
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.code;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[restore-kit-sem-abertura-frio] erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
