#!/usr/bin/env node
/**
 * scripts/sync-kit-envio-brevo-orphans.ts (#11431)
 *
 * Varredura dos ÓRFÃOS do #10437 com o Passo 3c desligado. Órfão = ativo no
 * Kit com a tag `envio-brevo` e SEM entrada no store da Brevo diária
 * (`data/brevo-diaria/contacts.json`), tipicamente uma gravação do store que
 * falhou depois de a tag pegar.
 *
 * Até o #11221 o único reparo era o próprio Passo 3c
 * (`sync-kit-sem-abertura-to-brevo.ts`, bloco `sync_orphan`). Com
 * `brevo_diaria.kit_sem_abertura.enabled = false` (27/10/2026) ele nem roda, e
 * o órfão fica sem edição nenhuma, sem prazo: a tag o tira do segmento da
 * diária no Kit, o `evaluate-brevo-diaria` e o `restore-kit-sem-abertura-frio`
 * não o veem (só leem store e log), e o `sync-kit-frio` o pula pela tag.
 *
 * ## O que faz com cada órfão
 *
 * Lê o contato na conta Brevo da diária (só leitura) e:
 *
 *  - está na lista `brevo_diaria.list_id` e NÃO está `emailBlacklisted` ⇒
 *    recebe pela Brevo; grava a entrada que faltava no store
 *    (`kit-sem-abertura:{id}`, `in_brevo`), sem ingerir nada. A partir daí o
 *    caminho é o dos demais movidos (evaluate, restore com o frio ligado).
 *  - qualquer outro caso (fora da lista, blacklisted, contato inexistente) ⇒
 *    tira `envio-brevo` no Kit com releitura: volta à diária do Kit. Nunca
 *    descadastra, e nunca põe ninguém novo na Brevo ("ninguém novo do Kit vai
 *    pra Brevo", #11295).
 *
 * Leitura da Brevo que falhar adia o contato (conta falha, a próxima rodada
 * retenta). Com o 3c LIGADO este script não faz nada: o 3c já reconcilia os
 * órfãos do jeito dele (re-ingere), e dois reparos com regras diferentes no
 * mesmo contato só confundiriam.
 *
 * ## Store ausente ou vazio aborta
 *
 * Com o store ilegível, TODO portador da tag pareceria órfão (e um store
 * vazio regravado apagaria o real). Sem o arquivo, ou com zero contatos,
 * sai 2 sem tocar em nada.
 *
 * ## Uso
 *
 *   npx tsx scripts/sync-kit-envio-brevo-orphans.ts          # dry-run (conta e classifica, não escreve)
 *   npx tsx scripts/sync-kit-envio-brevo-orphans.ts --push
 *
 * Chamado como Passo 3e de `brevo-diaria-run.ts` quando o 3c está desligado.
 *
 * Exit: 0 ok (inclui 3c ligado = nada a fazer); 1 falha em algum órfão (os
 * demais seguem); 2 precondição (config, chave, store ausente/vazio, tag
 * `envio-brevo` inexistente).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { findTagIdByName } from "./lib/kit-broadcasts.ts";
import { brevoGet } from "./lib/brevo-client.ts";
import {
  DEFAULT_STORE_PATH,
  normalizeEmail,
  readStore,
  upsertIngested,
  writeStore,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";
import { buildOrigin } from "./lib/shared/brevo-diaria-origin.ts";
import { KIT_ENVIO_BREVO_TAG_NAME } from "./lib/kit-diaria-audience.ts";
import { isKitSemAberturaEnabled } from "./lib/kit-sem-abertura.ts";
import { appendFileWithRetry } from "./lib/source-runs.ts";
import { createRequestPacer } from "./kit-provider-split.ts";
import {
  KIT_MIN_INTERVAL_MS,
  listKitActiveCandidates,
  untagAndConfirm,
  type KitSemAberturaPlatformConfig,
} from "./sync-kit-sem-abertura-to-brevo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ENVIO_BREVO_ORPHANS_LOG_PATH = resolve(ROOT, "data/brevo-diaria/envio-brevo-orphans-log.jsonl");

/** Estado do contato na conta Brevo da diária. */
export interface BrevoOrphanContact {
  exists: boolean;
  blacklisted: boolean;
  listIds: readonly number[];
}

export type EnvioBrevoOrphanAction = "reconcile_store" | "return_to_kit";

/** Pura — o órfão recebe pela Brevo (fica, só falta o store) ou está sem canal (volta ao Kit)? */
export function decideEnvioBrevoOrphan(contact: BrevoOrphanContact, listId: number): EnvioBrevoOrphanAction {
  return contact.exists && !contact.blacklisted && contact.listIds.includes(listId) ? "reconcile_store" : "return_to_kit";
}

/** Pura — ativos do Kit com a tag `envio-brevo` e sem entrada no store (qualquer status). */
export function findEnvioBrevoOrphans<T extends { email: string; tagNames: readonly string[] }>(
  actives: readonly T[],
  store: BrevoDiariaStore,
): T[] {
  const storeEmails = new Set(store.contacts.map((c) => normalizeEmail(c.email)));
  return actives.filter((a) => a.tagNames.includes(KIT_ENVIO_BREVO_TAG_NAME) && !storeEmails.has(normalizeEmail(a.email)));
}

export interface EnvioBrevoOrphanCandidate {
  id: number;
  email: string;
  tagNames: readonly string[];
}

export interface EnvioBrevoOrphanDeps {
  nowMs: number;
  log: (msg: string) => void;
  /** `null` = arquivo do store ausente. */
  readStore: () => BrevoDiariaStore | null;
  writeStore: (store: BrevoDiariaStore) => void;
  listKitActive: () => Promise<EnvioBrevoOrphanCandidate[]>;
  /** Lança se a leitura falhar (o contato é adiado). */
  readBrevoContact: (email: string) => Promise<BrevoOrphanContact>;
  findEnvioBrevoTagId: () => Promise<number | null>;
  /** Remove a tag e RELÊ (lança se a releitura ainda mostrar). */
  untagKit: (tagId: number, subscriberId: number) => Promise<void>;
  appendLog: (line: string) => void;
}

export interface EnvioBrevoOrphanRunResult {
  code: 0 | 1 | 2;
  /** 3c ligado: ele cobre os órfãos, este script não faz nada. */
  coveredBy3c?: boolean;
  dryRun: boolean;
  orphans: number;
  returnedToKit: number;
  reconciledInStore: number;
  failed: number;
  summary: string;
}

export async function runEnvioBrevoOrphanSweep(
  cfg: KitSemAberturaPlatformConfig,
  opts: { push: boolean },
  deps: EnvioBrevoOrphanDeps,
): Promise<EnvioBrevoOrphanRunResult> {
  const { log } = deps;
  const { push } = opts;
  const base = { dryRun: !push, orphans: 0, returnedToKit: 0, reconciledInStore: 0, failed: 0 };
  const brevo = cfg.brevo_diaria;
  if (isKitSemAberturaEnabled(brevo?.kit_sem_abertura)) {
    return { code: 0, coveredBy3c: true, ...base, summary: "brevo_diaria.kit_sem_abertura ligado — o Passo 3c reconcilia os órfãos (#11431)." };
  }
  if (!brevo || brevo.list_id == null) return { code: 2, ...base, summary: "brevo_diaria.list_id não configurado." };
  const listId = brevo.list_id;

  let store: BrevoDiariaStore | null;
  try {
    store = deps.readStore();
  } catch (e) {
    return { code: 2, ...base, summary: `store da Brevo diária ilegível (${(e as Error).message}) — nada tocado.` };
  }
  if (store === null || store.contacts.length === 0) {
    return {
      code: 2,
      ...base,
      summary: `store da Brevo diária ${store === null ? "ausente" : "vazio"} — todo portador da tag ${KIT_ENVIO_BREVO_TAG_NAME} pareceria órfão; nada tocado.`,
    };
  }

  const actives = await deps.listKitActive();
  const orphans = findEnvioBrevoOrphans(actives, store);
  const holders = actives.filter((a) => a.tagNames.includes(KIT_ENVIO_BREVO_TAG_NAME)).length;
  log(`${holders} ativo(s) com a tag ${KIT_ENVIO_BREVO_TAG_NAME} no Kit; ${orphans.length} órfão(s) (fora do store).`);

  const nowIso = new Date(deps.nowMs).toISOString();
  let current = store;
  let failed = 0;
  let returnedToKit = 0;
  let reconciledInStore = 0;
  let tagId: number | null | undefined;
  const appendLogSafe = (entry: Record<string, unknown>) => {
    try {
      deps.appendLog(JSON.stringify(entry) + "\n");
    } catch (e) {
      log(`aviso: falha ao gravar o log de ${String(entry.email)} (${(e as Error).message}).`);
    }
  };

  for (const o of orphans) {
    let contact: BrevoOrphanContact;
    try {
      contact = await deps.readBrevoContact(o.email);
    } catch (e) {
      failed++;
      log(`FALHA ao ler ${o.email} na Brevo (${(e as Error).message}) — órfão fica pra próxima rodada.`);
      continue;
    }
    const action = decideEnvioBrevoOrphan(contact, listId);
    const why = !contact.exists ? "sem contato na Brevo" : contact.blacklisted ? "blacklisted na Brevo" : contact.listIds.includes(listId) ? "na lista da Brevo" : `fora da lista ${listId}`;
    if (!push) {
      log(`  [dry-run] ${o.email}: ${why} ⇒ ${action === "reconcile_store" ? "grava no store (segue na Brevo)" : `tira ${KIT_ENVIO_BREVO_TAG_NAME} (volta à diária do Kit)`}.`);
      if (action === "reconcile_store") reconciledInStore++;
      else returnedToKit++;
      continue;
    }
    if (action === "reconcile_store") {
      const origin = buildOrigin("kit-sem-abertura", String(o.id));
      const next = upsertIngested(current, { email: o.email, beehiiv_subscription_id: origin }, nowIso);
      try {
        deps.writeStore(next);
      } catch (e) {
        failed++;
        log(`FALHA ao gravar o store pro órfão ${o.email} (${(e as Error).message}) — retenta na próxima rodada.`);
        continue;
      }
      current = next;
      reconciledInStore++;
      log(`  ${o.email}: ${why} — entrada gravada no store (${origin}).`);
      appendLogSafe({ ts: nowIso, event: "orphan_store_reconciled", email: normalizeEmail(o.email), kit_subscriber_id: o.id, origin });
      continue;
    }
    if (tagId === undefined) tagId = await deps.findEnvioBrevoTagId();
    if (tagId === null) {
      return {
        code: 2,
        dryRun: false,
        orphans: orphans.length,
        returnedToKit,
        reconciledInStore,
        failed,
        summary: `tag "${KIT_ENVIO_BREVO_TAG_NAME}" não achada no Kit — ${orphans.length - returnedToKit - reconciledInStore} órfão(s) sem reparo nesta rodada.`,
      };
    }
    try {
      await deps.untagKit(tagId, o.id);
    } catch (e) {
      failed++;
      log(`FALHA: ${o.email} (${why}) — tag ${KIT_ENVIO_BREVO_TAG_NAME} NÃO removida (${(e as Error).message}) — retenta na próxima rodada.`);
      continue;
    }
    returnedToKit++;
    log(`  ${o.email}: ${why} — tag ${KIT_ENVIO_BREVO_TAG_NAME} removida, volta à diária do Kit.`);
    appendLogSafe({ ts: nowIso, event: "orphan_returned_to_kit", email: normalizeEmail(o.email), kit_subscriber_id: o.id, reason: why });
  }

  return {
    code: failed > 0 ? 1 : 0,
    dryRun: !push,
    orphans: orphans.length,
    returnedToKit,
    reconciledInStore,
    failed,
    summary:
      `${push ? "" : "[dry-run] "}${orphans.length} órfão(s) da tag ${KIT_ENVIO_BREVO_TAG_NAME}: ${returnedToKit} de volta à diária do Kit, ` +
      `${reconciledInStore} gravado(s) no store (seguem na Brevo), ${failed} falha(s).`,
  };
}

// ── I/O de produção ──────────────────────────────────────────────────────

/** Contato na conta Brevo da diária; 404 = inexistente. Lança em outro status. */
async function readBrevoOrphanContact(apiKey: string, email: string): Promise<BrevoOrphanContact> {
  const res = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
  if (res.status === 404) return { exists: false, blacklisted: false, listIds: [] };
  if (res.status !== 200) throw new Error(`GET /contacts falhou (HTTP ${res.status})`);
  const body = res.body as { emailBlacklisted?: unknown; listIds?: unknown } | undefined;
  const listIds = Array.isArray(body?.listIds) ? body!.listIds.filter((x): x is number => typeof x === "number") : [];
  return { exists: true, blacklisted: body?.emailBlacklisted === true, listIds };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const log = (msg: string) => process.stderr.write(`[sync-kit-envio-brevo-orphans] ${msg}\n`);
  let cfg: KitSemAberturaPlatformConfig;
  try {
    cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as KitSemAberturaPlatformConfig;
  } catch (e) {
    log(`ERRO: platform.config.json ilegível (${(e as Error).message}).`);
    process.exitCode = 2;
    return;
  }
  if (isKitSemAberturaEnabled(cfg.brevo_diaria?.kit_sem_abertura)) {
    log("brevo_diaria.kit_sem_abertura ligado — o Passo 3c reconcilia os órfãos; nada a fazer (#11431).");
    console.log(JSON.stringify({ code: 0, coveredBy3c: true }));
    return;
  }
  const kitCfg = resolveKitConfig();
  if (!kitCfg.ok) {
    log(`ERRO: ${kitCfg.reason}`);
    process.exitCode = 2;
    return;
  }
  const apiKeyEnv = cfg.brevo_diaria?.api_key_env;
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  if (!apiKey) {
    log(`ERRO: ${apiKeyEnv ?? "brevo_diaria.api_key_env"} não definido no ambiente.`);
    process.exitCode = 2;
    return;
  }
  const pace = createRequestPacer(KIT_MIN_INTERVAL_MS);
  const result = await runEnvioBrevoOrphanSweep(cfg, { push }, {
    nowMs: Date.now(),
    log,
    readStore: () => (existsSync(DEFAULT_STORE_PATH) ? readStore(DEFAULT_STORE_PATH) : null),
    writeStore: (s) => writeStore(s, DEFAULT_STORE_PATH),
    listKitActive: () => listKitActiveCandidates(log, pace),
    readBrevoContact: (email) => readBrevoOrphanContact(apiKey, email),
    findEnvioBrevoTagId: async () => {
      await pace();
      return findTagIdByName(KIT_ENVIO_BREVO_TAG_NAME);
    },
    untagKit: (tagId, id) => untagAndConfirm(tagId, id, pace),
    appendLog: (line) => appendFileWithRetry(DEFAULT_ENVIO_BREVO_ORPHANS_LOG_PATH, line),
  });
  log(result.summary);
  console.log(JSON.stringify(result));
  process.exitCode = result.code;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sync-kit-envio-brevo-orphans] erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
