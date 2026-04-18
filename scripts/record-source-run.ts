#!/usr/bin/env npx tsx
/**
 * Registra uma execução de source-researcher (ou discovery-searcher).
 * Faz DUAS coisas:
 *
 *   1. Atualiza `data/source-health.json` com contadores agregados.
 *   2. Anexa uma linha JSONL ao log individual da fonte em `data/sources/{slug}.jsonl`
 *      para auditoria fina (o usuário pode inspecionar tudo que uma fonte específica
 *      retornou ao longo do tempo).
 *
 * Uso:
 *   npx tsx scripts/record-source-run.ts \
 *     --source "MIT Technology Review" \
 *     --edition 260418 \
 *     --outcome ok|fail|timeout \
 *     --duration-ms 45123 \
 *     --query-used "site:technologyreview.com AI OR ..." \
 *     --articles-json '[{"title":"...","url":"...","published_at":"..."}]' \
 *     --reason "consecutive_fetch_errors"   (opcional)
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

type Outcome = "ok" | "fail" | "timeout";

interface OutcomeEntry {
  outcome: Outcome;
  timestamp: string;
}

interface SourceEntry {
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

interface HealthFile {
  sources: Record<string, SourceEntry>;
  notes?: string;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        out[key] = "true";
      } else {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const args = parseArgs(process.argv.slice(2));

if (!args.source) {
  console.error("--source é obrigatório");
  process.exit(2);
}
const outcome = args.outcome as Outcome;
if (!["ok", "fail", "timeout"].includes(outcome)) {
  console.error(`--outcome deve ser ok|fail|timeout (recebido: ${outcome})`);
  process.exit(2);
}

const now = new Date().toISOString();
const src = args.source;
const slug = slugify(src);
const durationMs = args["duration-ms"] ? Number(args["duration-ms"]) : null;
const articlesCount = (() => {
  if (!args["articles-json"]) return 0;
  try {
    return JSON.parse(args["articles-json"]).length ?? 0;
  } catch {
    return 0;
  }
})();

// ===== 1. Atualiza source-health.json =====

const healthPath = resolve(process.cwd(), "data/source-health.json");
let health: HealthFile = { sources: {} };
if (existsSync(healthPath)) {
  try {
    health = JSON.parse(readFileSync(healthPath, "utf8"));
    if (!health.sources) health.sources = {};
  } catch (e) {
    console.error(`health file corrompido, recriando: ${(e as Error).message}`);
    health = { sources: {} };
  }
}

const entry: SourceEntry = health.sources[src] ?? {
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

entry.attempts += 1;
if (durationMs !== null) entry.last_duration_ms = durationMs;

if (outcome === "ok") {
  entry.successes += 1;
  entry.last_success_iso = now;
  entry.total_articles += articlesCount;
} else if (outcome === "fail") {
  entry.failures += 1;
  entry.last_failure_iso = now;
} else if (outcome === "timeout") {
  entry.timeouts += 1;
  entry.last_failure_iso = now;
}

entry.recent_outcomes.push({ outcome, timestamp: now });
if (entry.recent_outcomes.length > 10) {
  entry.recent_outcomes.splice(0, entry.recent_outcomes.length - 10);
}

health.sources[src] = entry;
writeFileSync(healthPath, JSON.stringify(health, null, 2) + "\n", "utf8");

// ===== 2. Anexa log individual por fonte =====

const sourceLogPath = resolve(process.cwd(), `data/sources/${slug}.jsonl`);
mkdirSync(dirname(sourceLogPath), { recursive: true });

let articles: Array<{ title?: string; url?: string; published_at?: string }> = [];
if (args["articles-json"]) {
  try {
    articles = JSON.parse(args["articles-json"]);
  } catch (e) {
    console.error(`articles-json inválido, log individual sem detalhe: ${(e as Error).message}`);
  }
}

const logEntry = {
  timestamp: now,
  source: src,
  edition: args.edition ?? null,
  outcome,
  duration_ms: durationMs,
  reason: args.reason ?? null,
  query_used: args["query-used"] ?? null,
  articles_count: articlesCount,
  articles: articles.map((a) => ({
    title: a.title ?? null,
    url: a.url ?? null,
    published_at: a.published_at ?? null,
  })),
};

appendFileSync(sourceLogPath, JSON.stringify(logEntry) + "\n", "utf8");

// Calcular failure streak para retornar ao orchestrator
const reversed = entry.recent_outcomes.slice().reverse();
const streak = reversed.findIndex((e) => e.outcome === "ok");
const consecutive_failures = streak === -1 ? entry.recent_outcomes.length : streak;
const failure_timestamps = reversed
  .slice(0, streak === -1 ? undefined : streak)
  .map((e) => e.timestamp)
  .reverse();

console.log(
  JSON.stringify({
    source: src,
    slug,
    outcome,
    attempts: entry.attempts,
    consecutive_failures,
    failure_timestamps,
    log_path: sourceLogPath,
  }),
);
