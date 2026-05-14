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

export type Outcome = "ok" | "fail" | "timeout";

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
 * (streak de não-ok a partir do mais recente).
 */
export function computeFailureStreak(entry: SourceEntry): {
  consecutive_failures: number;
  failure_timestamps: string[];
} {
  const reversed = entry.recent_outcomes.slice().reverse();
  const streak = reversed.findIndex((e) => e.outcome === "ok");
  const consecutive_failures =
    streak === -1 ? entry.recent_outcomes.length : streak;
  const failure_timestamps = reversed
    .slice(0, streak === -1 ? undefined : streak)
    .map((e) => e.timestamp)
    .reverse();
  return { consecutive_failures, failure_timestamps };
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

export function appendSourceLog(
  rootDir: string,
  slug: string,
  logEntry: unknown,
): string {
  const sourceLogPath = resolve(rootDir, `data/sources/${slug}.jsonl`);
  mkdirSync(dirname(sourceLogPath), { recursive: true });
  appendFileSync(sourceLogPath, JSON.stringify(logEntry) + "\n", "utf8");
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
