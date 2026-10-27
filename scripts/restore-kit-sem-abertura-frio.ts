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
 * encontra o assinante `active` e aplica as tags. Idempotente.
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
  normalizeEmail,
  readStore,
  writeStore,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";
import { ORIGIN_PREFIX } from "./lib/shared/brevo-diaria-origin.ts";
import { KIT_ENVIO_BREVO_TAG_NAME } from "./lib/kit-diaria-audience.ts";
import { DEFAULT_KIT_SEM_ABERTURA_LOG_PATH, formatKitSemAberturaLogLine } from "./lib/kit-sem-abertura.ts";
import { KIT_FRIO_TAG_NAME } from "./lib/kit-frio.ts";
import { appendFileWithRetry } from "./lib/source-runs.ts";
import { createRequestPacer } from "./kit-provider-split.ts";
import { KIT_MIN_INTERVAL_MS, tagAndConfirm, untagAndConfirm } from "./sync-kit-sem-abertura-to-brevo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_LIST_PATH = resolve(ROOT, "data/kit-frio/reativar-no-painel.csv");

export interface RestoreTarget {
  email: string;
  kitSubscriberId: number;
  source: "descadastrado_2510" | "in_brevo";
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
      if (!byEmail.has(email)) byEmail.set(email, { email, kitSubscriberId: j.kit_subscriber_id, source: "descadastrado_2510" });
    }
  }
  for (const c of contacts) {
    if (c.status !== "in_brevo" || !c.beehiiv_subscription_id.startsWith(ORIGIN_PREFIX.KIT_SEM_ABERTURA)) continue;
    const raw = c.beehiiv_subscription_id.slice(ORIGIN_PREFIX.KIT_SEM_ABERTURA.length);
    const id = /^[0-9]+$/.test(raw) ? Number(raw) : 0;
    if (id > 0) byEmail.set(normalizeEmail(c.email), { email: normalizeEmail(c.email), kitSubscriberId: id, source: "in_brevo" });
  }
  return { targets: [...byEmail.values()], badLines };
}

export type RestoreStep = "ja_ok" | "tags" | "painel" | "estado_nao_reativavel";

/** Pura — o que fazer com o assinante, pelo estado e tags atuais no Kit. */
export function decideKitRestore(state: string, tagNames: readonly string[]): RestoreStep {
  if (state === "cancelled") return "painel";
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
  opts: { apply: boolean },
  deps: KitRestoreDeps,
): Promise<{ code: 0 | 1 | 2; counts: Record<RestoreStep | "aplicado" | "falha", number> }> {
  const { log } = deps;
  const counts: Record<RestoreStep | "aplicado" | "falha", number> = {
    ja_ok: 0,
    tags: 0,
    painel: 0,
    estado_nao_reativavel: 0,
    aplicado: 0,
    falha: 0,
  };
  let frioId: number | null = null;
  let envioId: number | null = null;
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
    const step = decideKitRestore(kit.state, kit.tagNames);
    counts[step]++;
    if (step === "painel") panel.push(t);
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
      if (step === "tags" || (step === "ja_ok" && t.source === "in_brevo")) {
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
  };
  const brevoKey = cfg.brevo_diaria ? process.env[cfg.brevo_diaria.api_key_env] : undefined;
  const listId = cfg.brevo_diaria?.list_id;
  const store = readStore(DEFAULT_STORE_PATH);
  const { targets, badLines } = collectRestoreTargets(readKitSemAberturaLogs(), store.contacts);
  if (badLines > 0) log(`aviso: ${badLines} linha(s) ilegível(is) nos logs (ignoradas).`);
  log(
    `${targets.filter((t) => t.source === "descadastrado_2510").length} descadastrado(s) por supressão no log, ` +
      `${targets.filter((t) => t.source === "in_brevo").length} kit-sem-abertura: ainda in_brevo.`,
  );
  if (apply && targets.some((t) => t.source === "in_brevo") && (!brevoKey || listId == null)) {
    log("ERRO: há kit-sem-abertura: in_brevo e a chave/lista da Brevo diária não está disponível — não dá pra desvinculá-los.");
    process.exitCode = 2;
    return;
  }
  const pace = createRequestPacer(KIT_MIN_INTERVAL_MS);
  const result = await runKitSemAberturaRestore(targets, { apply }, {
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
