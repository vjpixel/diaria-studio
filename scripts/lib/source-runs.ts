/**
 * lib/source-runs.ts
 *
 * Lógica compartilhada por `record-source-run.ts` (single) e
 * `record-source-runs.ts` (batch). Mantém escrita em disco desacoplada
 * da lógica pura, facilitando testes com fixtures.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

// `empty` = fetch/SERP teve sucesso mas retornou zero artigos (sem novidade na
// janela, ou query/feed sem hit). NÃO é falha — distinto de `fail` (erro HTTP/
// parse) e `timeout`. Emitido por fetch-rss-batch.ts / fetch-websearch-batch.ts.
export type Outcome = "ok" | "empty" | "fail" | "timeout";

/** Falhas "duras": fetch quebrado (HTTP/parse) ou timeout. `empty`/`ok` não. */
export function isHardFailure(outcome: string): boolean {
  return outcome === "fail" || outcome === "timeout";
}

export interface OutcomeEntry {
  outcome: Outcome;
  timestamp: string;
}

export interface SourceEntry {
  attempts: number;
  successes: number;
  failures: number;
  timeouts: number;
  last_success_iso: string | null;
  last_failure_iso: string | null;
  last_duration_ms: number | null;
  recent_outcomes: OutcomeEntry[];
  total_articles: number;
}

export interface HealthFile {
  sources: Record<string, SourceEntry>;
  notes?: string;
}

export interface RunRecord {
  source: string;
  edition?: string;
  outcome: Outcome;
  duration_ms?: number | null;
  query_used?: string | null;
  articles?: Array<{ title?: string; url?: string; published_at?: string }>;
  reason?: string | null;
}

export interface RunResult {
  source: string;
  slug: string;
  outcome: Outcome;
  attempts: number;
  consecutive_failures: number;
  failure_timestamps: string[];
  log_path: string;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function emptyEntry(): SourceEntry {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    last_success_iso: null,
    last_failure_iso: null,
    last_duration_ms: null,
    recent_outcomes: [],
    total_articles: 0,
  };
}

/**
 * Aplica um RunRecord a uma SourceEntry, retornando nova entry atualizada.
 * Pura: sem I/O.
 */
export function applyRun(
  prev: SourceEntry,
  run: RunRecord,
  now: string,
): SourceEntry {
  const entry: SourceEntry = {
    ...prev,
    recent_outcomes: [...prev.recent_outcomes],
  };
  entry.attempts += 1;
  if (run.duration_ms !== null && run.duration_ms !== undefined) {
    entry.last_duration_ms = run.duration_ms;
  }
  const articlesCount = run.articles?.length ?? 0;
  if (run.outcome === "ok") {
    entry.successes += 1;
    entry.last_success_iso = now;
    entry.total_articles += articlesCount;
  } else if (run.outcome === "fail") {
    entry.failures += 1;
    entry.last_failure_iso = now;
  } else if (run.outcome === "timeout") {
    entry.timeouts += 1;
    entry.last_failure_iso = now;
  }
  entry.recent_outcomes.push({ outcome: run.outcome, timestamp: now });
  if (entry.recent_outcomes.length > 10) {
    entry.recent_outcomes.splice(0, entry.recent_outcomes.length - 10);
  }
  return entry;
}

/**
 * Deriva consecutive_failures + failure_timestamps do `recent_outcomes`
 * (streak de falhas DURAS — `fail`/`timeout` — a partir do mais recente).
 *
 * `empty` (fetch OK, zero artigos) e `ok` encerram o streak: nenhum dos dois é
 * falha. Antes (#1576) qualquer não-`ok` contava, o que inflava o streak de
 * blogs de baixa frequência que só retornaram `empty` por falta de novidade.
 */
export function computeFailureStreak(entry: SourceEntry): {
  consecutive_failures: number;
  failure_timestamps: string[];
} {
  const failure_timestamps: string[] = [];
  for (let i = entry.recent_outcomes.length - 1; i >= 0; i--) {
    const e = entry.recent_outcomes[i];
    if (!isHardFailure(e.outcome)) break;
    failure_timestamps.unshift(e.timestamp);
  }
  return {
    consecutive_failures: failure_timestamps.length,
    failure_timestamps,
  };
}

// -------------------- I/O wrappers --------------------

export function loadHealth(healthPath: string): HealthFile {
  if (!existsSync(healthPath)) return { sources: {} };
  try {
    const parsed = JSON.parse(readFileSync(healthPath, "utf8"));
    if (!parsed.sources) parsed.sources = {};
    return parsed as HealthFile;
  } catch {
    return { sources: {} };
  }
}

export function saveHealth(healthPath: string, health: HealthFile): void {
  mkdirSync(dirname(healthPath), { recursive: true });
  // #1269: usar writeFileAtomic (com retry em EPERM no Windows + OneDrive
  // race). Antes usava renameSync direto, crashava intermitente em test runs.
  writeFileAtomic(healthPath, JSON.stringify(health, null, 2) + "\n");
}

/**
 * #1374: retry-with-backoff em appendFileSync. Windows + OneDrive Files
 * On-Demand pode retornar UNKNOWN (errno=-4094) ou EPERM/EBUSY quando o
 * sync agent tem o arquivo locked durante hidratação. Caso real 260519:
 * 22 de 49 slugs falharam no primeiro run; passaram após probe que forçou
 * download.
 *
 * Retry só em codes transientes do Windows. Outros erros (ENOENT, EACCES
 * permanente, etc) propagam imediato.
 *
 * Backoff: [0, 200, 500, 1500]ms — busy-wait sync (mesma pattern do
 * renameWithRetry em atomic-write.ts:122).
 *
 * Helper exportado pra teste de injection.
 */
export function appendFileWithRetry(
  filePath: string,
  data: string,
  attempts: number[] = [0, 200, 500, 1500],
  appendFn: (p: string, d: string, enc: "utf8") => void = (p, d, enc) =>
    appendFileSync(p, d, enc),
): void {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i] > 0) {
      const deadline = Date.now() + attempts[i];
      while (Date.now() < deadline) {
        /* spin */
      }
    }
    try {
      appendFn(filePath, data, "utf8");
      return;
    } catch (err) {
      lastErr = err;
      const e = err as NodeJS.ErrnoException;
      const code = e?.code;
      const errno = e?.errno;
      // UNKNOWN errno=-4094 (OneDrive race), EPERM, EBUSY, EACCES → retry.
      // Outros codes propagam imediato.
      const isTransient =
        code === "UNKNOWN" ||
        code === "EPERM" ||
        code === "EBUSY" ||
        code === "EACCES" ||
        errno === -4094;
      if (!isTransient) throw err;
      if (i === attempts.length - 1) throw err;
    }
  }
  throw lastErr; // unreachable mas TS feliz
}

export function appendSourceLog(
  rootDir: string,
  slug: string,
  logEntry: unknown,
): string {
  const sourceLogPath = resolve(rootDir, `data/sources/${slug}.jsonl`);
  mkdirSync(dirname(sourceLogPath), { recursive: true });
  // #1374: retry-with-backoff cobre OneDrive Files On-Demand race
  appendFileWithRetry(sourceLogPath, JSON.stringify(logEntry) + "\n");
  return sourceLogPath;
}

/**
 * Executa um RunRecord: atualiza health.json + anexa log individual.
 * Retorna resultado resumido.
 */
export function recordRun(
  rootDir: string,
  run: RunRecord,
  now: string = new Date().toISOString(),
): RunResult {
  const healthPath = resolve(rootDir, "data/source-health.json");
  const health = loadHealth(healthPath);
  const prev = health.sources[run.source] ?? emptyEntry();
  const entry = applyRun(prev, run, now);
  health.sources[run.source] = entry;
  saveHealth(healthPath, health);

  const slug = slugify(run.source);
  const logEntry = {
    timestamp: now,
    source: run.source,
    edition: run.edition ?? null,
    outcome: run.outcome,
    duration_ms: run.duration_ms ?? null,
    reason: run.reason ?? null,
    query_used: run.query_used ?? null,
    articles_count: run.articles?.length ?? 0,
    articles: (run.articles ?? []).map((a) => ({
      title: a.title ?? null,
      url: a.url ?? null,
      published_at: a.published_at ?? null,
    })),
  };
  const log_path = appendSourceLog(rootDir, slug, logEntry);

  const { consecutive_failures, failure_timestamps } = computeFailureStreak(entry);
  return {
    source: run.source,
    slug,
    outcome: run.outcome,
    attempts: entry.attempts,
    consecutive_failures,
    failure_timestamps,
    log_path,
  };
}

export function recordRunsBatch(
  rootDir: string,
  runs: RunRecord[],
  now: string = new Date().toISOString(),
): RunResult[] {
  return runs.map((run) => recordRun(rootDir, run, now));
}
