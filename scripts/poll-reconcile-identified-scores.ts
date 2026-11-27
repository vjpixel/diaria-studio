/**
 * scripts/poll-reconcile-identified-scores.ts (#14222)
 *
 * Reconcilia os scores do É IA? (`/jogar`, brand `web`) inflados no KV de
 * PRODUÇÃO do Worker `poll` pelo re-sync silencioso de `/jogar/identify`
 * (causa corrigida na #14225). A regra de reconstrução e os limites estão no
 * docblock de `scripts/lib/poll-reconcile-identified-scores.ts`.
 *
 * Uso:
 *   # Dry-run (default): só lê o KV, imprime totais sem e-mail e grava o
 *   # relatório completo (com e-mails) em --out.
 *   npx tsx scripts/poll-reconcile-identified-scores.ts --out <arquivo.json>
 *
 *   # Escrita: só com o hash do dry-run. Recalcula o plano na hora; se o KV
 *   # mudou desde o dry-run, o hash não bate e nada é gravado.
 *   npx tsx scripts/poll-reconcile-identified-scores.ts --apply --confirm-dry-run-hash <hash> \
 *     [--backup-dir data/poll-reconcile] [--out <arquivo.json>]
 *
 * O `--apply`, nesta ordem: (1) grava o backup JSON dos valores antigos de
 * toda chave que vai mudar (falha no backup aborta antes de qualquer escrita);
 * (2) grava `score:*`, `score-by-month:*` e os marcadores `identify-migrated*`;
 * (3) apaga `leaderboard-snapshot:{M}` dos meses tocados; (4) purga o DO
 * ScoreCounter dos e-mails com voto direto que mudaram (`/admin/purge-score-do`,
 * assinado com ADMIN_SECRET), senão o próximo voto direto regrava o valor
 * inflado que o DO guarda.
 *
 * Credenciais (as mesmas do backend REST de `purge-leaderboard.ts`, #11253):
 * CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (leitura; escrita no --apply),
 * ADMIN_SECRET ou POLL_ADMIN_SECRET (só no --apply, para o purge do DO).
 * `.env` via dotenv; em worktree, apontar com DOTENV_CONFIG_PATH.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKvRestOps, kvRestBulkGet, KV_BULK_GET_MAX_KEYS, type KvRestConfig } from "./lib/cloudflare-kv-rest.ts";
import {
  reconcileIdentifiedScores,
  redactReport,
  selectKeysToRead,
  RECONCILE_KEY_PREFIXES,
  type ReconcileReport,
} from "./lib/poll-reconcile-identified-scores.ts";
import { purgeScoreCounterDo } from "./lib/purge-score-counter-do.ts";
import { dohFetch } from "./lib/doh-fetch.ts";
import { DIARIA_EIA_URL } from "./lib/canonical-urls.ts";

const NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6"; // POLL (workers/poll/wrangler.toml)
const BRAND_PREFIX = "web:";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** ~4 req/s: abaixo do limite global da API (~1.200 requests / 5 min). */
const THROTTLE_MS = 260;

const args = process.argv.slice(2);
function flag(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
}
const apply = args.includes("--apply");
const confirmHash = flag("--confirm-dry-run-hash");
const outPath = flag("--out");
const backupDir = flag("--backup-dir") ?? resolve(ROOT, "data", "poll-reconcile");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const v = await fn();
      await sleep(THROTTLE_MS);
      return v;
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt >= 5 || !/HTTP (429|5\d\d)|timeout|aborted/i.test(msg)) throw e;
      const wait = 2000 * attempt;
      console.error(`[reconcile] ${label}: ${msg.slice(0, 120)} — nova tentativa em ${wait} ms`);
      await sleep(wait);
    }
  }
}

async function loadKv(cfg: KvRestConfig): Promise<Map<string, string>> {
  const ops = createKvRestOps(cfg);
  const names: string[] = [];
  for (const p of RECONCILE_KEY_PREFIXES) {
    const got = await withRetry(`list ${p}`, () => ops.list(BRAND_PREFIX + p));
    for (const n of got) if (n.startsWith(BRAND_PREFIX)) names.push(n.slice(BRAND_PREFIX.length));
    console.error(`[reconcile] list ${BRAND_PREFIX}${p}: ${got.length} chaves`);
  }
  const toRead = selectKeysToRead(names);
  console.error(`[reconcile] lendo ${toRead.length} valores (bulk get de ${KV_BULK_GET_MAX_KEYS})`);
  const kv = new Map<string, string>();
  for (let i = 0; i < toRead.length; i += KV_BULK_GET_MAX_KEYS) {
    const chunk = toRead.slice(i, i + KV_BULK_GET_MAX_KEYS);
    const got = await withRetry(`bulk get ${i}`, () => kvRestBulkGet(cfg, chunk.map((k) => BRAND_PREFIX + k)));
    for (const k of chunk) {
      const v = got.get(BRAND_PREFIX + k);
      if (v != null) kv.set(k, v);
    }
  }
  return kv;
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function applyPlan(cfg: KvRestConfig, report: ReconcileReport): Promise<number> {
  const secret = process.env.ADMIN_SECRET ?? process.env.POLL_ADMIN_SECRET ?? null;
  if (report.doPurgeEmails.length > 0 && !secret) {
    console.error("[reconcile] --apply precisa de ADMIN_SECRET (ou POLL_ADMIN_SECRET) para purgar o DO ScoreCounter; nada gravado");
    return 1;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve(backupDir, `poll-reconcile-14222-${stamp}.json`);
  writeJson(backupPath, {
    issue: 14222,
    created_at: new Date().toISOString(),
    hash: report.hash,
    brand_prefix: BRAND_PREFIX,
    entries: report.writes.map((w) => ({ key: BRAND_PREFIX + w.key, kind: w.kind, old: w.old, new: w.new })),
  });
  console.error(`[reconcile] backup: ${backupPath} (${report.writes.length} chaves)`);

  const ops = createKvRestOps(cfg);
  let done = 0;
  for (const w of report.writes) {
    await withRetry(`put ${w.kind}`, () => ops.put(BRAND_PREFIX + w.key, w.new));
    done += 1;
  }
  console.error(`[reconcile] gravadas ${done} chaves`);
  for (const m of report.snapshotMonths) {
    await withRetry("delete snapshot", () => ops.delete(`${BRAND_PREFIX}leaderboard-snapshot:${m}`));
  }
  console.error(`[reconcile] snapshots invalidados: ${report.snapshotMonths.length}`);
  let doFail = 0;
  for (const email of report.doPurgeEmails) {
    const r = await purgeScoreCounterDo(email, "web", secret!, process.env.POLL_WORKER_URL ?? DIARIA_EIA_URL, dohFetch);
    if (!r.ok) {
      doFail += 1;
      console.error(`[reconcile] purge do DO falhou (status ${r.status}): ${r.error ?? ""}`);
    }
    await sleep(THROTTLE_MS);
  }
  console.error(`[reconcile] DO purgados: ${report.doPurgeEmails.length - doFail}/${report.doPurgeEmails.length}`);
  return doFail > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  if (apply && !confirmHash) {
    console.error("[reconcile] --apply exige --confirm-dry-run-hash <hash do dry-run>; nada gravado");
    return 2;
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !token) {
    console.error("[reconcile] faltam CLOUDFLARE_ACCOUNT_ID e/ou CLOUDFLARE_API_TOKEN no ambiente (.env via DOTENV_CONFIG_PATH)");
    return 1;
  }
  const cfg: KvRestConfig = { accountId, token, namespaceId: NAMESPACE_ID };
  const kv = await loadKv(cfg);
  const report = reconcileIdentifiedScores(kv);
  if (outPath) {
    writeJson(resolve(outPath), { generated_at: new Date().toISOString(), mode: apply ? "apply" : "dry-run", ...report });
    console.error(`[reconcile] relatório completo: ${resolve(outPath)}`);
  }
  console.log(JSON.stringify(redactReport(report), null, 2));
  if (!apply) {
    console.error(`[reconcile] dry-run: nada gravado. Para gravar: --apply --confirm-dry-run-hash ${report.hash}`);
    return 0;
  }
  if (confirmHash !== report.hash) {
    console.error(`[reconcile] hash do plano atual (${report.hash}) difere de --confirm-dry-run-hash (${confirmHash}): o KV mudou desde o dry-run. Nada gravado; rode o dry-run de novo.`);
    return 1;
  }
  return applyPlan(cfg, report);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[reconcile] erro: ${(e as Error).message}`);
    process.exit(1);
  },
);
