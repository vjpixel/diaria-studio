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
import { computeFailureStreak } from "./lib/source-runs.ts";
import { parseArgs } from "./lib/cli-args.ts"; // #2834 — substitui parseArgs local

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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface RunReport {
  source: string;
  slug: string;
  outcome: Outcome;
  attempts: number;
  consecutive_failures: number;
  failure_timestamps: string[];
  log_path: string;
}

/**
 * #1683: build do report de saída (stdout do CLI) a partir do entry agregado.
 * Pura/testável — delega o streak ao helper compartilhado computeFailureStreak
 * (#1665). A lógica inline antiga (findIndex outcome==="ok") contava `empty`
 * (fetch OK, zero artigos) como falha, inflando o streak; computeFailureStreak
 * conta só falhas DURAS (fail/timeout). Antes top-level (não-testável); extraída.
 */
export function buildRunReport(
  entry: SourceEntry,
  ctx: { source: string; slug: string; outcome: Outcome; logPath: string },
): RunReport {
  const { consecutive_failures, failure_timestamps } = computeFailureStreak(entry);
  return {
    source: ctx.source,
    slug: ctx.slug,
    outcome: ctx.outcome,
    attempts: entry.attempts,
    consecutive_failures,
    failure_timestamps,
    log_path: ctx.logPath,
  };
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));

  if (!values["source"]) {
    console.error("--source é obrigatório");
    process.exit(2);
  }
  const outcome = values["outcome"] as Outcome;
  if (!["ok", "fail", "timeout"].includes(outcome)) {
    console.error(`--outcome deve ser ok|fail|timeout (recebido: ${outcome})`);
    process.exit(2);
  }

  const now = new Date().toISOString();
  const src = values["source"];
  const slug = slugify(src);
  const durationMs = values["duration-ms"] ? Number(values["duration-ms"]) : null;
  const articlesCount = (() => {
    if (!values["articles-json"]) return 0;
    try {
      return JSON.parse(values["articles-json"]).length ?? 0;
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
  if (values["articles-json"]) {
    try {
      articles = JSON.parse(values["articles-json"]);
    } catch (e) {
      console.error(`articles-json inválido, log individual sem detalhe: ${(e as Error).message}`);
    }
  }

  const logEntry = {
    timestamp: now,
    source: src,
    edition: values["edition"] ?? null,
    outcome,
    duration_ms: durationMs,
    reason: values["reason"] ?? null,
    query_used: values["query-used"] ?? null,
    articles_count: articlesCount,
    articles: articles.map((a) => ({
      title: a.title ?? null,
      url: a.url ?? null,
      published_at: a.published_at ?? null,
    })),
  };

  appendFileSync(sourceLogPath, JSON.stringify(logEntry) + "\n", "utf8");

  console.log(JSON.stringify(buildRunReport(entry, { source: src, slug, outcome, logPath: sourceLogPath })));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
