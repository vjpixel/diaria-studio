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
 *   npx tsx scripts/poll-reconcile-identified-scores.ts [--dry-run] --out <arquivo.json>
 *
 *   # Escrita: só com o hash do dry-run (16 hex das escritas planejadas).
 *   # Recalcula o plano na hora; KV mudou desde o dry-run ⇒ hash diverge e
 *   # nada é gravado. Rodar em janela de pouco tráfego do /jogar.
 *   npx tsx scripts/poll-reconcile-identified-scores.ts --apply --confirm-dry-run-hash <hash> \
 *     [--backup-dir data/poll-reconcile] [--out <arquivo.json>]
 *
 *   # Retomar só a purga do DO que falhou (arquivo gravado pelo --apply):
 *   npx tsx scripts/poll-reconcile-identified-scores.ts --purge-do-from <backupDir>/...-pending-do-purge.json
 *
 * O `--apply`:
 *   1. ADMIN_SECRET (ou POLL_ADMIN_SECRET) ausente com purga de DO planejada
 *      ⇒ aborta antes de tudo. Sem purga planejada, o secret não é exigido.
 *   2. Grava o backup JSON dos valores antigos e o relê (parse + contagem);
 *      falha ⇒ nenhuma escrita.
 *   3. Por e-mail: marcadores, depois score e mensal (cada chave relida antes
 *      do `put`; se mudou desde o dry-run, pula e reporta), depois a purga do
 *      DO ScoreCounter desse e-mail (com retry em status 0/429/5xx). Progresso
 *      chave a chave em `{backupDir}/...-progress.json`.
 *   4. Erro numa escrita: para, imprime done/total, a chave e o backup, e
 *      ainda invalida os snapshots e purga o DO de quem já teve `score:`
 *      gravado. Purga que falhou vai para `...-pending-do-purge.json` (lista
 *      no arquivo, não no terminal); retomar com `--purge-do-from`.
 *   5. Relê `score:` dos purgados e grava divergências em `...-divergences.json`.
 *   6. Espera ~90 s (consistência eventual da API REST do KV), invalida os
 *      snapshots de novo e roda um dry-run de verificação: exit 0 só com 0
 *      escritas planejadas, nada pulado e nenhuma purga pendente.
 *
 * Credenciais (as mesmas do backend REST de `purge-leaderboard.ts`, #11253):
 * CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID; ADMIN_SECRET só se houver
 * purga de DO. `.env` via dotenv; em worktree, apontar com DOTENV_CONFIG_PATH.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKvRestOps, kvRestBulkGet, KV_BULK_GET_MAX_KEYS, type KvOps } from "./lib/cloudflare-kv-rest.ts";
import {
  reconcileIdentifiedScores,
  redactReport,
  selectKeysToRead,
  RECONCILE_KEY_PREFIXES,
  type PlannedWrite,
  type ReconcileReport,
} from "./lib/poll-reconcile-identified-scores.ts";
import { purgeScoreCounterDo, type PurgeScoreCounterDoResult } from "./lib/purge-score-counter-do.ts";
import { dohFetch } from "./lib/doh-fetch.ts";
import { DIARIA_EIA_URL } from "./lib/canonical-urls.ts";

const NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6"; // POLL (workers/poll/wrangler.toml)
export const BRAND_PREFIX = "web:";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 260 ms ≈ 3,8 req/s, perto do limite global da API (~1.200 requests / 5 min = 4 req/s). */
const THROTTLE_MS = 260;
/** Espera antes do dry-run de verificação (consistência eventual da REST do KV). */
export const VERIFY_WAIT_MS = 90_000;

export interface ReconcileDeps {
  ops: Pick<KvOps, "list" | "get" | "put" | "delete">;
  bulkGet: (keys: string[]) => Promise<Map<string, string | null>>;
  purge: (email: string, secret: string) => Promise<PurgeScoreCounterDoResult>;
  fs: { mkdir: (dir: string) => void; writeFile: (path: string, data: string) => void; readFile: (path: string) => string };
  env: Record<string, string | undefined>;
  sleep: (ms: number) => Promise<void>;
  /** stderr (progresso, erros). */
  log: (line: string) => void;
  /** stdout (relatório redigido). */
  out: (line: string) => void;
  now: () => Date;
}

export interface CliOptions {
  apply: boolean;
  confirmHash: string | null;
  outPath: string | null;
  backupDir: string;
  purgeDoFrom: string | null;
}

const VALUE_FLAGS = new Set(["--confirm-dry-run-hash", "--out", "--backup-dir", "--purge-do-from", "--purge-do-only"]);
const BOOL_FLAGS = new Set(["--apply", "--dry-run"]);

export function parseArgs(argv: readonly string[]): { ok: true; opts: CliOptions } | { ok: false; error: string } {
  const opts: CliOptions = { apply: false, confirmHash: null, outPath: null, backupDir: resolve(ROOT, "data", "poll-reconcile"), purgeDoFrom: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.has(a)) {
      if (a === "--apply") opts.apply = true;
      continue;
    }
    if (!VALUE_FLAGS.has(a)) return { ok: false, error: `flag desconhecida: ${a}` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { ok: false, error: `${a} exige um valor` };
    i++;
    if (a === "--confirm-dry-run-hash") opts.confirmHash = v;
    else if (a === "--out") opts.outPath = resolve(v);
    else if (a === "--backup-dir") opts.backupDir = resolve(v);
    else opts.purgeDoFrom = resolve(v);
  }
  if (opts.apply && argv.includes("--dry-run")) return { ok: false, error: "--apply e --dry-run são exclusivos" };
  if (opts.purgeDoFrom && opts.apply) return { ok: false, error: "--purge-do-from não combina com --apply" };
  return { ok: true, opts };
}

async function withRetry<T>(deps: ReconcileDeps, label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const v = await fn();
      await deps.sleep(THROTTLE_MS);
      return v;
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt >= 5 || !/HTTP (429|5\d\d)|timeout|aborted/i.test(msg)) throw e;
      const wait = 2000 * attempt;
      deps.log(`[reconcile] ${label}: ${msg.slice(0, 120)} — nova tentativa em ${wait} ms`);
      await deps.sleep(wait);
    }
  }
}

/** Purga com retry para status 0 (rede), 429 e 5xx. */
async function purgeWithRetry(deps: ReconcileDeps, email: string, secret: string): Promise<PurgeScoreCounterDoResult> {
  let last: PurgeScoreCounterDoResult = { ok: false, status: 0, error: "não tentado" };
  for (let attempt = 1; attempt <= 4; attempt++) {
    last = await deps.purge(email, secret);
    if (last.ok) break;
    if (!(last.status === 0 || last.status === 429 || last.status >= 500)) break;
    await deps.sleep(2000 * attempt);
  }
  await deps.sleep(THROTTLE_MS);
  return last;
}

export async function loadKv(deps: ReconcileDeps): Promise<{ kv: Map<string, string>; listed: string[] }> {
  const names: string[] = [];
  for (const p of RECONCILE_KEY_PREFIXES) {
    const got = await withRetry(deps, `list ${p}`, () => deps.ops.list(BRAND_PREFIX + p));
    for (const n of got) if (n.startsWith(BRAND_PREFIX)) names.push(n.slice(BRAND_PREFIX.length));
    deps.log(`[reconcile] list ${BRAND_PREFIX}${p}: ${got.length} chaves`);
  }
  const listed = selectKeysToRead(names);
  deps.log(`[reconcile] lendo ${listed.length} valores (bulk get de ${KV_BULK_GET_MAX_KEYS})`);
  const kv = new Map<string, string>();
  const missing: string[] = [];
  for (let i = 0; i < listed.length; i += KV_BULK_GET_MAX_KEYS) {
    const chunk = listed.slice(i, i + KV_BULK_GET_MAX_KEYS);
    const got = await withRetry(deps, `bulk get ${i}`, () => deps.bulkGet(chunk.map((k) => BRAND_PREFIX + k)));
    for (const k of chunk) {
      const v = got.get(BRAND_PREFIX + k);
      if (v != null) kv.set(k, v);
      else missing.push(k);
    }
  }
  // Listada mas sem valor no bulk get: uma a uma; o que seguir faltando vira `ausente`.
  for (const k of missing) {
    const v = await withRetry(deps, "get", () => deps.ops.get(BRAND_PREFIX + k));
    if (v != null) kv.set(k, v);
  }
  return { kv, listed };
}

function writeJson(deps: ReconcileDeps, path: string, data: unknown): void {
  deps.fs.mkdir(dirname(path));
  deps.fs.writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

function groupByEmail(report: ReconcileReport): Array<{ email: string; writes: PlannedWrite[] }> {
  const order: string[] = [];
  const groups = new Map<string, PlannedWrite[]>();
  for (const w of report.writes) {
    if (!groups.has(w.email)) {
      groups.set(w.email, []);
      order.push(w.email);
    }
    groups.get(w.email)!.push(w);
  }
  for (const e of report.doPurgeEmails) {
    if (!groups.has(e)) {
      groups.set(e, []);
      order.push(e);
    }
  }
  return order.map((email) => ({ email, writes: groups.get(email)! }));
}

export interface ApplyOptions {
  backupDir: string;
}

export async function applyPlan(report: ReconcileReport, deps: ReconcileDeps, opts: ApplyOptions): Promise<number> {
  const secret = deps.env.ADMIN_SECRET ?? deps.env.POLL_ADMIN_SECRET ?? null;
  if (report.doPurgeEmails.length > 0 && !secret) {
    deps.log("[reconcile] --apply precisa de ADMIN_SECRET (ou POLL_ADMIN_SECRET) para purgar o DO ScoreCounter; nada gravado");
    return 1;
  }
  const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
  const base = resolve(opts.backupDir, `poll-reconcile-14222-${stamp}`);
  const backupPath = `${base}.json`;
  const progressPath = `${base}-progress.json`;
  const pendingPurgePath = `${base}-pending-do-purge.json`;
  const divergencesPath = `${base}-divergences.json`;

  try {
    writeJson(deps, backupPath, {
      issue: 14222,
      created_at: deps.now().toISOString(),
      hash: report.hash,
      brand_prefix: BRAND_PREFIX,
      entries: report.writes.map((w) => ({ key: BRAND_PREFIX + w.key, kind: w.kind, old: w.old, new: w.new })),
    });
    const reread = JSON.parse(deps.fs.readFile(backupPath)) as { entries?: unknown[] };
    if (!Array.isArray(reread.entries) || reread.entries.length !== report.writes.length) {
      throw new Error(`backup relido com ${Array.isArray(reread.entries) ? reread.entries.length : "?"} entradas, esperado ${report.writes.length}`);
    }
  } catch (e) {
    deps.log(`[reconcile] backup falhou (${(e as Error).message}); nada gravado`);
    return 1;
  }
  deps.log(`[reconcile] backup: ${backupPath} (${report.writes.length} chaves)`);

  const progress = {
    hash: report.hash,
    total: report.writes.length,
    done: [] as string[],
    skipped: [] as Array<{ key: string; reason: string }>,
    failed: null as null | { key: string; error: string },
    purged: [] as string[],
    purgeFailed: [] as Array<{ email: string; status: number; error?: string }>,
  };
  const saveProgress = () => writeJson(deps, progressPath, progress);
  const purgeOne = async (email: string) => {
    const r = await purgeWithRetry(deps, email, secret!);
    if (r.ok) progress.purged.push(email);
    else progress.purgeFailed.push({ email, status: r.status, error: r.error });
    saveProgress();
  };

  const groups = groupByEmail(report);
  const doPurge = new Set(report.doPurgeEmails);
  for (const g of groups) {
    let scoreSkipped = false;
    for (const w of g.writes) {
      try {
        const cur = await withRetry(deps, "reler", () => deps.ops.get(BRAND_PREFIX + w.key));
        if (cur !== w.old) {
          progress.skipped.push({ key: w.key, reason: "valor mudou desde o dry-run" });
          if (w.kind === "score") scoreSkipped = true;
          saveProgress();
          continue;
        }
        await withRetry(deps, `put ${w.kind}`, () => deps.ops.put(BRAND_PREFIX + w.key, w.new));
        progress.done.push(w.key);
        saveProgress();
      } catch (e) {
        progress.failed = { key: w.key, error: (e as Error).message };
        saveProgress();
        break;
      }
    }
    if (progress.failed) break;
    if (doPurge.has(g.email) && !scoreSkipped) await purgeOne(g.email);
  }

  if (progress.failed) {
    deps.log(`[reconcile] ERRO na escrita: ${progress.done.length}/${progress.total} gravadas; falhou em ${progress.failed.key}: ${progress.failed.error}`);
    deps.log(`[reconcile] backup dos valores antigos: ${backupPath}; progresso: ${progressPath}`);
    // Quem já teve `score:` gravado precisa do DO purgado, senão o próximo voto direto regrava o valor velho.
    const done = new Set(progress.done);
    for (const email of report.doPurgeEmails) {
      if (done.has(`score:${email}`) && !progress.purged.includes(email) && !progress.purgeFailed.some((f) => f.email === email)) await purgeOne(email);
    }
  }

  const invalidate = async () => {
    for (const m of report.snapshotMonths) await withRetry(deps, "delete snapshot", () => deps.ops.delete(`${BRAND_PREFIX}leaderboard-snapshot:${m}`));
  };
  await invalidate();
  deps.log(`[reconcile] snapshots invalidados: ${report.snapshotMonths.length}`);

  if (progress.purgeFailed.length > 0) {
    writeJson(deps, pendingPurgePath, { issue: 14222, emails: progress.purgeFailed.map((f) => f.email), failures: progress.purgeFailed });
    deps.log(`[reconcile] purga do DO falhou para ${progress.purgeFailed.length} e-mail(s); lista em ${pendingPurgePath} (retomar com --purge-do-from)`);
  }
  deps.log(`[reconcile] DO purgados: ${progress.purged.length}/${report.doPurgeEmails.length}`);

  // Relê `score:` dos purgados que tiveram score gravado: tem que ser o planejado.
  const planned = new Map(report.writes.filter((w) => w.kind === "score" && progress.done.includes(w.key)).map((w) => [w.email, w.new]));
  const divergences: Array<{ email: string; expected: string; found: string | null }> = [];
  for (const email of progress.purged) {
    const expected = planned.get(email);
    if (expected === undefined) continue;
    const found = await withRetry(deps, "reler score", () => deps.ops.get(`${BRAND_PREFIX}score:${email}`));
    if (found !== expected) divergences.push({ email, expected, found });
  }
  if (divergences.length > 0) {
    writeJson(deps, divergencesPath, { issue: 14222, divergences });
    deps.log(`[reconcile] ${divergences.length} score(s) divergem do planejado após a purga; detalhe em ${divergencesPath}`);
  }
  if (progress.skipped.length > 0) deps.log(`[reconcile] ${progress.skipped.length} chave(s) puladas por mudança concorrente (ver ${progressPath})`);

  if (progress.failed) return 1;

  deps.log(`[reconcile] esperando ${Math.round(VERIFY_WAIT_MS / 1000)} s antes do dry-run de verificação`);
  await deps.sleep(VERIFY_WAIT_MS);
  await invalidate();
  const { kv, listed } = await loadKv(deps);
  const verify = reconcileIdentifiedScores(kv, { listedKeys: listed });
  deps.log(`[reconcile] verificação: ${verify.writes.length} escrita(s) ainda planejada(s)`);
  const clean = verify.writes.length === 0 && progress.skipped.length === 0 && progress.purgeFailed.length === 0 && divergences.length === 0;
  return clean ? 0 : 1;
}

export async function purgeDoFrom(file: string, deps: ReconcileDeps, opts: ApplyOptions): Promise<number> {
  const secret = deps.env.ADMIN_SECRET ?? deps.env.POLL_ADMIN_SECRET ?? null;
  if (!secret) {
    deps.log("[reconcile] --purge-do-from precisa de ADMIN_SECRET (ou POLL_ADMIN_SECRET)");
    return 1;
  }
  let emails: string[];
  try {
    const parsed = JSON.parse(deps.fs.readFile(file)) as { emails?: unknown };
    if (!Array.isArray(parsed.emails) || !parsed.emails.every((e) => typeof e === "string")) throw new Error("campo emails ausente ou inválido");
    emails = parsed.emails as string[];
  } catch (e) {
    deps.log(`[reconcile] não li ${file}: ${(e as Error).message}`);
    return 1;
  }
  const failed: Array<{ email: string; status: number; error?: string }> = [];
  for (const email of emails) {
    const r = await purgeWithRetry(deps, email, secret);
    if (!r.ok) failed.push({ email, status: r.status, error: r.error });
  }
  deps.log(`[reconcile] DO purgados: ${emails.length - failed.length}/${emails.length}`);
  if (failed.length > 0) {
    const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
    const path = resolve(opts.backupDir, `poll-reconcile-14222-${stamp}-pending-do-purge.json`);
    writeJson(deps, path, { issue: 14222, emails: failed.map((f) => f.email), failures: failed });
    deps.log(`[reconcile] ${failed.length} purga(s) ainda falhando; lista em ${path}`);
    return 1;
  }
  return 0;
}

export async function main(argv: readonly string[], deps: ReconcileDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.log(`[reconcile] ${parsed.error}`);
    return 2;
  }
  const opts = parsed.opts;
  if (opts.purgeDoFrom) return purgeDoFrom(opts.purgeDoFrom, deps, opts);
  if (opts.apply && !opts.confirmHash) {
    deps.log("[reconcile] --apply exige --confirm-dry-run-hash <hash do dry-run>; nada gravado");
    return 2;
  }
  const { kv, listed } = await loadKv(deps);
  const report = reconcileIdentifiedScores(kv, { listedKeys: listed });

  let mode = "dry-run";
  let refusal: string | null = null;
  if (opts.apply) {
    if (opts.confirmHash !== report.hash) {
      mode = "apply-recusado-hash";
      refusal = `hash do plano atual (${report.hash}) difere de --confirm-dry-run-hash (${opts.confirmHash}): o KV mudou desde o dry-run. Nada gravado; rode o dry-run de novo.`;
    } else if (report.totals.missingKeys > 0) {
      mode = "apply-recusado-chaves-ausentes";
      refusal = `${report.totals.missingKeys} chave(s) listada(s) sem valor na leitura; plano abortado, nada gravado.`;
    } else {
      mode = "apply";
    }
  }
  if (opts.outPath) {
    writeJson(deps, opts.outPath, { generated_at: deps.now().toISOString(), mode, ...report });
    deps.log(`[reconcile] relatório completo: ${opts.outPath}`);
  }
  deps.out(JSON.stringify({ mode, ...redactReport(report) }, null, 2));
  if (!opts.apply) {
    deps.log(`[reconcile] dry-run: nada gravado. Para gravar: --apply --confirm-dry-run-hash ${report.hash}`);
    return 0;
  }
  if (refusal) {
    deps.log(`[reconcile] ${refusal}`);
    return 1;
  }
  return applyPlan(report, deps, opts);
}

function defaultDeps(): ReconcileDeps {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !token) {
    throw new Error("faltam CLOUDFLARE_ACCOUNT_ID e/ou CLOUDFLARE_API_TOKEN no ambiente (.env via DOTENV_CONFIG_PATH)");
  }
  const cfg = { accountId, token, namespaceId: NAMESPACE_ID };
  return {
    ops: createKvRestOps(cfg),
    bulkGet: (keys) => kvRestBulkGet(cfg, keys),
    purge: (email, secret) => purgeScoreCounterDo(email, "web", secret, process.env.POLL_WORKER_URL ?? DIARIA_EIA_URL, dohFetch),
    fs: {
      mkdir: (dir) => mkdirSync(dir, { recursive: true }),
      writeFile: (path, data) => writeFileSync(path, data, "utf8"),
      readFile: (path) => readFileSync(path, "utf8"),
    },
    env: process.env,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.error(line),
    out: (line) => console.log(line),
    now: () => new Date(),
  };
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
})();

if (invokedDirectly) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2), defaultDeps()))
    .then(
      (code) => process.exit(code),
      (e) => {
        console.error(`[reconcile] erro: ${(e as Error).message}`);
        process.exit(1);
      },
    );
}
