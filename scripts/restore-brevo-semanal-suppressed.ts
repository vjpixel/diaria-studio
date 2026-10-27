#!/usr/bin/env node
/**
 * scripts/restore-brevo-semanal-suppressed.ts (#11226, item 6 da decisão)
 *
 * Devolve à semanal da Brevo quem foi SUPRIMIDO POR SCORE e tinha aberto ao
 * menos uma vez (os ~113 da medição de 27/10/2026, menos os 6 de origem
 * `kit-sem-abertura:`, que voltam pro Kit com a tag `frio` pelo
 * `restore-kit-sem-abertura-frio.ts`, #11221). Os que nunca abriram seguem
 * suprimidos.
 *
 * Elegível (todas):
 *  - store: `status: "suppressed"`, `resolution_reason: "score_threshold"`,
 *    origem diferente de `kit-sem-abertura:`;
 *  - Brevo ao vivo (`GET /contacts/{email}`): NENHUM sinal de saída da
 *    pessoa — sem `userUnsubscription`, sem hard bounce, sem reclamação de
 *    spam. O `emailBlacklisted` desses é o da NOSSA supressão
 *    (`suppressInBrevo`), não um descadastro. A abertura vem do store
 *    (`opens_count`/`ever_opened`) OU da estatística: a da Brevo cobre só os
 *    últimos 90 dias por padrão (doc do `GET /contacts/{identifier}`), então
 *    abertura antiga só aparece no store. Contato inexistente na Brevo (404)
 *    ⇒ `contato_ausente_na_brevo`; outro status ⇒ falha;
 *  - estado no Kit (por e-mail, QUALQUER origem): só volta quem está
 *    `inactive` no Kit ou não existe lá. `active` ⇒ fora (já recebe a diária
 *    por lá: canal duplo); `cancelled`/`bounced`/`complained` ⇒ fora (saiu).
 *
 * `--apply`: `PUT /contacts/{email}` com `emailBlacklisted: false` +
 * `listIds: [list_id]`, RELÊ (lista e blacklist precisam conferir) e só então
 * grava o store (`applyRestoredToSemanal`). Exige o regime semanal EFETIVO
 * (`resolveBrevoEffectiveMode`): flag ligada E nenhum `kit-sem-abertura:`
 * ainda `in_brevo` — com esse resíduo a Brevo segue diária (#10533) e eles
 * voltariam a receber todo dia. Idempotente: quem já voltou não está mais
 * `suppressed`.
 *
 *   npx tsx scripts/restore-brevo-semanal-suppressed.ts            # dry-run (lê Brevo/Kit, não escreve)
 *   npx tsx scripts/restore-brevo-semanal-suppressed.ts --apply
 *
 * Log: `data/brevo-diaria/restore-semanal-log.jsonl`.
 * Exit: 0 ok; 1 falha em algum contato; 2 precondição.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { brevoGet, brevoPut } from "./lib/brevo-client.ts";
import {
  DEFAULT_STORE_PATH,
  applyRestoredToSemanal,
  readStore,
  writeStore,
  type BrevoDiariaContact,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";
import { ORIGIN_PREFIX } from "./lib/shared/brevo-diaria-origin.ts";
import { countKitSemAberturaInBrevo, parseBrevoDiariaSemanal, resolveBrevoEffectiveMode } from "./lib/brevo-diaria-semanal.ts";
import { getKitSubscriberByEmail } from "./lib/kit-subscribers.ts";
import { appendFileWithRetry } from "./lib/source-runs.ts";
import { hasComplaint, hasHardBounce, hasUserUnsubscription, type BrevoContactStatistics } from "./evaluate-brevo-diaria.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = resolve(ROOT, "data/brevo-diaria/restore-semanal-log.jsonl");

/** Pura — candidatos pelo store (antes de qualquer leitura de rede). */
export function selectRestoreCandidates(contacts: readonly BrevoDiariaContact[]): BrevoDiariaContact[] {
  return contacts.filter(
    (c) =>
      c.status === "suppressed" &&
      c.resolution_reason === "score_threshold" &&
      !c.beehiiv_subscription_id.startsWith(ORIGIN_PREFIX.KIT_SEM_ABERTURA) &&
      (c.opens_count >= 1 || c.ever_opened === true),
  );
}

export type RestoreVerdict =
  | { restore: true }
  | {
      restore: false;
      reason: "nunca_abriu" | "descadastrou" | "bounce" | "reclamou_spam" | "ativo_no_kit" | "saiu_do_kit" | "contato_ausente_na_brevo";
    };

/**
 * Pura — decide pela leitura ao vivo. `kitState`: estado do e-mail no Kit
 * (`null` = não existe lá). Só `inactive`/`null` voltam.
 */
export function decideRestore(input: {
  brevoFound: boolean;
  statistics: BrevoContactStatistics & { opened?: unknown[] } | undefined;
  /** Abertura registrada no store (`opens_count >= 1` ou `ever_opened`) — a estatística da Brevo cobre só 90 dias. */
  openedInStore?: boolean;
  kitState: string | null;
}): RestoreVerdict {
  if (!input.brevoFound) return { restore: false, reason: "contato_ausente_na_brevo" };
  const st = input.statistics;
  if (hasUserUnsubscription(st)) return { restore: false, reason: "descadastrou" };
  if (hasComplaint(st)) return { restore: false, reason: "reclamou_spam" };
  if (hasHardBounce(st)) return { restore: false, reason: "bounce" };
  const openedInStats = Array.isArray(st?.opened) && st!.opened!.length > 0;
  if (!openedInStats && input.openedInStore !== true) return { restore: false, reason: "nunca_abriu" };
  if (input.kitState === "active") return { restore: false, reason: "ativo_no_kit" };
  if (input.kitState !== null && input.kitState !== "inactive") return { restore: false, reason: "saiu_do_kit" };
  return { restore: true };
}

export interface RestoreDeps {
  log: (msg: string) => void;
  readStore: () => BrevoDiariaStore;
  writeStore: (s: BrevoDiariaStore) => void;
  getBrevoContact: (email: string) => Promise<{ status: number; body?: { statistics?: BrevoContactStatistics; emailBlacklisted?: boolean; listIds?: number[] } }>;
  putBrevoContact: (email: string, body: Record<string, unknown>) => Promise<void>;
  /** Estado do e-mail no Kit; `null` se não existe lá. */
  kitStateByEmail: (email: string) => Promise<string | null>;
  appendLog: (line: string) => void;
  nowIso: () => string;
}

export async function runRestoreSemanal(
  opts: { apply: boolean; listId: number; semanal: ReturnType<typeof parseBrevoDiariaSemanal> },
  deps: RestoreDeps,
): Promise<{ code: 0 | 1 | 2; restored: number; eligible: number; skipped: Record<string, number>; failed: number }> {
  const { log } = deps;
  const skipped: Record<string, number> = {};
  let store = deps.readStore();
  if (opts.apply) {
    const eff = resolveBrevoEffectiveMode(opts.semanal, countKitSemAberturaInBrevo(store.contacts, ORIGIN_PREFIX.KIT_SEM_ABERTURA));
    if ("error" in eff || eff.mode !== "semanal") {
      log(
        "ERRO: --apply exige o regime semanal EFETIVO (brevo_diaria.semanal.enabled e nenhum kit-sem-abertura: ainda in_brevo) — " +
          `sem isso eles voltariam a receber a diária todo dia (#11226). ${"error" in eff ? eff.error : (eff.warning ?? "brevo_diaria.semanal desligado.")}`,
      );
      return { code: 2, restored: 0, eligible: 0, skipped, failed: 0 };
    }
  }
  const candidates = selectRestoreCandidates(store.contacts);
  log(`${candidates.length} suprimido(s) por score com >= 1 abertura no store (fora kit-sem-abertura:).`);
  let eligible = 0;
  let restored = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      const res = await deps.getBrevoContact(c.email);
      if (res.status !== 200 && res.status !== 404) throw new Error(`GET /contacts respondeu HTTP ${res.status}`);
      const kitState = res.status === 404 ? null : await deps.kitStateByEmail(c.email);
      const verdict = decideRestore({
        brevoFound: res.status === 200,
        statistics: res.body?.statistics as never,
        openedInStore: c.opens_count >= 1 || c.ever_opened === true,
        kitState,
      });
      if (!verdict.restore) {
        skipped[verdict.reason] = (skipped[verdict.reason] ?? 0) + 1;
        continue;
      }
      eligible++;
      if (!opts.apply) continue;
      await deps.putBrevoContact(c.email, { emailBlacklisted: false, listIds: [opts.listId] });
      const check = await deps.getBrevoContact(c.email);
      const ok = check.status === 200 && check.body?.emailBlacklisted !== true && Array.isArray(check.body?.listIds) && check.body!.listIds!.includes(opts.listId);
      if (!ok) {
        failed++;
        log(`FALHA: ${c.email} — releitura não confirma (blacklist=${check.body?.emailBlacklisted}, listIds=${JSON.stringify(check.body?.listIds)}).`);
        continue;
      }
      store = applyRestoredToSemanal(store, c.email, deps.nowIso());
      deps.writeStore(store);
      restored++;
      try {
        deps.appendLog(JSON.stringify({ ts: deps.nowIso(), event: "restored_to_semanal", email: c.email }) + "\n");
      } catch (e) {
        log(`aviso: log de ${c.email} não gravado (${(e as Error).message}).`);
      }
    } catch (e) {
      failed++;
      log(`FALHA em ${c.email}: ${(e as Error).message}`);
    }
  }
  log(
    `${opts.apply ? "" : "[dry-run] "}${eligible} elegível(is), ${restored} devolvido(s) à semanal, ${failed} falha(s). Fora: ` +
      Object.entries(skipped).map(([k, v]) => `${k}=${v}`).join(", "),
  );
  return { code: failed > 0 ? 1 : 0, restored, eligible, skipped, failed };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "apply");
  const log = (msg: string) => process.stderr.write(`[restore-brevo-semanal-suppressed] ${msg}\n`);
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as {
    brevo_diaria?: { api_key_env: string; list_id: number | null; semanal?: unknown };
  };
  const brevo = cfg.brevo_diaria;
  if (!brevo || brevo.list_id == null) {
    log("ERRO: brevo_diaria.list_id não configurado.");
    process.exitCode = 2;
    return;
  }
  const apiKey = process.env[brevo.api_key_env];
  if (!apiKey) {
    log(`ERRO: ${brevo.api_key_env} ausente no ambiente.`);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(DEFAULT_STORE_PATH)) {
    log(`ERRO: store ausente (${DEFAULT_STORE_PATH}).`);
    process.exitCode = 2;
    return;
  }
  const semanal = parseBrevoDiariaSemanal(brevo.semanal);
  if ("error" in semanal) {
    log(`ERRO: ${semanal.error}`);
    process.exitCode = 2;
    return;
  }
  const listId = brevo.list_id;
  const result = await runRestoreSemanal(
    { apply, listId, semanal },
    {
      log,
      readStore: () => readStore(DEFAULT_STORE_PATH),
      writeStore: (s) => writeStore(s, DEFAULT_STORE_PATH),
      getBrevoContact: async (email) => {
        const r = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
        return { status: r.status, body: r.body as never };
      },
      putBrevoContact: async (email, body) => {
        await brevoPut(apiKey, `/contacts/${encodeURIComponent(email)}`, body);
      },
      kitStateByEmail: async (email) => (await getKitSubscriberByEmail(email))?.state ?? null,
      appendLog: (line) => appendFileWithRetry(LOG_PATH, line),
      nowIso: () => new Date().toISOString(),
    },
  );
  console.log(JSON.stringify(result));
  process.exitCode = result.code;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[restore-brevo-semanal-suppressed] erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
