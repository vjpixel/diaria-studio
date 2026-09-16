#!/usr/bin/env node
/**
 * scripts/verify-kit-inactive-emails-mv.ts (#8192)
 *
 * Verifica no MillionVerifier os assinantes `inactive` do Kit que já
 * receberam o e-mail de confirmação (DOI) há mais de 72h e ainda não estão
 * no store da Brevo diária — os candidatos de `sync-kit-inactive-to-brevo.ts`.
 * Roda ANTES da ingestão, no mesmo fluxo automático (`brevo-diaria-run.ts
 * --apply`, chamado pelo dispatch da Etapa 5).
 *
 * Par do `verify-pending-emails-mv.ts` (pool Beehiiv Pending): reusa a
 * chamada à API com retry, a classificação e o guard de custo de lá, mas com
 * fonte (API do Kit, não CSV) e checkpoint próprios — populações diferentes,
 * verificação não é intercambiável.
 *
 * ## Pool verificado
 *
 * `selectKitInactivePastDoiWindow` (`lib/kit-inactive-reativacao.ts`, mesmo
 * filtro que o sync usa) menos quem já está no store
 * (`data/brevo-diaria/contacts.json`, qualquer status) — quem já foi tratado
 * nunca volta a ser ingerido, então verificar seria crédito jogado fora.
 *
 * ## Skip forever (#2886)
 *
 * E-mail já no checkpoint (`data/kit-inativos-reativacao/.mv-cache.json`)
 * nunca é re-verificado. Falha transitória não entra no checkpoint — a
 * próxima rodada tenta de novo.
 *
 * ## Saídas (`data/kit-inativos-reativacao/`)
 *
 *   .mv-cache.json    fonte de verdade — `sync-kit-inactive-to-brevo.ts` lê daqui
 *   mv-verified.csv   ok | catch_all  (materializado do checkpoint, pra inspeção)
 *   mv-rejected.csv   invalid | disposable
 *   mv-unknown.csv    inconclusivo
 *   mv-error.csv      falha transitória desta rodada
 *
 * ## Uso
 *
 *   npx tsx scripts/verify-kit-inactive-emails-mv.ts            # verifica (≤500 sem --confirm)
 *   npx tsx scripts/verify-kit-inactive-emails-mv.ts --dry-run  # só lista o pool, sem gastar crédito
 *   npx tsx scripts/verify-kit-inactive-emails-mv.ts --confirm --limit 50
 *
 * Env: KIT_API_KEY + MILLION_VERIFIER_API_KEY.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { listAllKitSubscribers } from "./lib/kit-subscribers.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { readStore, normalizeEmail, DEFAULT_STORE_PATH, type BrevoDiariaStore } from "./lib/brevo-diaria-store.ts";
import {
  selectKitInactivePastDoiWindow,
  formatKitInactiveSelection,
} from "./lib/kit-inactive-reativacao.ts";
import {
  verifyOne,
  classifyResult,
  checkMvCostGuard,
  loadCheckpoint,
  saveCheckpoint,
  parseLimitArg,
} from "./verify-pending-emails-mv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const KIT_INACTIVE_OUT_DIR = resolve(ROOT, "data/kit-inativos-reativacao");
export const KIT_INACTIVE_MV_CHECKPOINT_PATH = resolve(KIT_INACTIVE_OUT_DIR, ".mv-cache.json");

/**
 * Pura — e-mails (normalizados, dedup) do pool elegível que ainda não estão
 * no store. Mesma normalização do sync (`normalizeEmail`).
 */
export function computeKitMvCandidates(eligibleEmails: readonly string[], store: BrevoDiariaStore): string[] {
  const known = new Set(store.contacts.map((c) => c.email));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of eligibleEmails) {
    const email = normalizeEmail(raw);
    if (!email || known.has(email) || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function toCsv(emails: string[]): string {
  return Papa.unparse({ fields: ["email"], data: emails.map((email) => ({ email })) }) + "\n";
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const log = (msg: string) => process.stderr.write(`[verify-kit-inactive-emails-mv] ${msg}\n`);

  let limit: number | undefined;
  try {
    limit = parseLimitArg(argv);
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
    process.exit(2);
  }

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    log(`ERRO: ${kitConfigResult.reason}`);
    process.exit(2);
  }
  const apiKey = process.env.MILLION_VERIFIER_API_KEY;
  if (!dryRun && !apiKey) {
    log("ERRO: MILLION_VERIFIER_API_KEY não definido no ambiente.");
    process.exit(2);
  }
  if (!existsSync(DEFAULT_STORE_PATH)) {
    log(`ERRO: store ausente em ${DEFAULT_STORE_PATH} — sem ele não dá pra excluir quem já foi tratado.`);
    process.exit(2);
  }

  const raw = await listAllKitSubscribers(kitConfigResult.config, { status: "inactive" });
  const selection = selectKitInactivePastDoiWindow(raw, Date.now());
  log(formatKitInactiveSelection(selection));

  const candidates = computeKitMvCandidates(
    selection.eligible.map((s) => s.email_address),
    readStore(DEFAULT_STORE_PATH),
  );
  const checkpoint = loadCheckpoint(KIT_INACTIVE_MV_CHECKPOINT_PATH, "verify-kit-inactive-emails-mv");
  const todo = candidates.filter((e) => !(e in checkpoint));
  const limited = limit !== undefined ? todo.slice(0, limit) : todo;
  log(
    `${candidates.length} candidato(s) fora do store; ${todo.length} ainda não verificado(s) ` +
      `(skip-forever pelo checkpoint); processando ${limited.length} nesta rodada.`,
  );

  if (dryRun) {
    for (const e of limited) log(`  ? ${e}`);
    log("dry-run — nenhum crédito MV gasto.");
    return;
  }

  const guard = checkMvCostGuard(limited.length, hasFlag(argv, "confirm"));
  if (!guard.ok) {
    log(`ERRO: ${guard.message}`);
    process.exit(2);
  }
  mkdirSync(KIT_INACTIVE_OUT_DIR, { recursive: true });

  const counts = { verified: 0, rejected: 0, unknown: 0 };
  const errorEmails: string[] = [];
  for (const email of limited) {
    try {
      const res = await verifyOne(apiKey!, email, 20);
      checkpoint[email] = { result: res.result ?? "", resultcode: res.resultcode ?? 0, quality: res.quality ?? "" };
      counts[classifyResult(res.result)]++;
    } catch (e) {
      errorEmails.push(email);
      log(`FALHA TRANSITÓRIA em ${email}: ${(e as Error).message} — fica pra próxima rodada.`);
    }
    saveCheckpoint(KIT_INACTIVE_MV_CHECKPOINT_PATH, checkpoint);
  }

  const buckets: Record<"verified" | "rejected" | "unknown", string[]> = { verified: [], rejected: [], unknown: [] };
  for (const [email, cached] of Object.entries(checkpoint)) buckets[classifyResult(cached.result)].push(email);
  writeFileAtomic(resolve(KIT_INACTIVE_OUT_DIR, "mv-verified.csv"), toCsv(buckets.verified));
  writeFileAtomic(resolve(KIT_INACTIVE_OUT_DIR, "mv-rejected.csv"), toCsv(buckets.rejected));
  writeFileAtomic(resolve(KIT_INACTIVE_OUT_DIR, "mv-unknown.csv"), toCsv(buckets.unknown));
  writeFileAtomic(resolve(KIT_INACTIVE_OUT_DIR, "mv-error.csv"), toCsv(errorEmails));

  log(
    `rodada: ${counts.verified} verificado(s), ${counts.rejected} rejeitado(s), ${counts.unknown} inconclusivo(s), ` +
      `${errorEmails.length} falha(s) transitória(s).`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[verify-kit-inactive-emails-mv] erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
