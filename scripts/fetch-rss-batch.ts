#!/usr/bin/env tsx
/**
 * fetch-rss-batch.ts (#1209)
 *
 * Dispatcha fetchRss + fetchSitemap em paralelo pra N fontes via
 * Promise.all + concurrency limit. Output direto no formato esperado por
 * `record-source-runs.ts` (RunRecord array).
 *
 * Substitui o ad-hoc loop inline que /diaria-test 260517 usou (rss-runner.cjs
 * gerado em runtime em data/editions/{AAMMDD}/_internal/). Centraliza
 * orchestration de RSS-only mode num script reutilizável.
 *
 * Uso:
 *   npx tsx scripts/fetch-rss-batch.ts \
 *     --sources data/editions/{AAMMDD}/_internal/rss-batch.json \
 *     --out data/editions/{AAMMDD}/_internal/researcher-results.json \
 *     [--days 3] [--timeout-per-feed 60000] [--concurrency 35]
 *
 * Sources input shape:
 *   [{ "name": "Canaltech (IA)", "rss": "https://...", "filter"?: "AI,IA,..." }, ...]
 *
 * Marca `method: "sitemap"` se `rss` termina em `sitemap.xml` — encaminha
 * pra `fetchSitemap` em vez de `fetchRss`.
 *
 * Output shape (RunRecord[]):
 *   [{ source, outcome: "ok"|"empty"|"fail"|"timeout", duration_ms,
 *      query_used, method, articles, reason? }, ...]
 *
 * Compatível com:
 *   `npx tsx scripts/record-source-runs.ts --runs <out> --edition <AAMMDD>`
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRss, type Article } from "./fetch-rss.ts";
import { fetchSitemapEntries } from "./lib/fetch-sitemap.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface SourceSpec {
  name: string;
  rss: string;
  filter?: string;
}

export type Outcome = "ok" | "empty" | "fail" | "timeout";

export interface RunRecord {
  source: string;
  outcome: Outcome;
  duration_ms: number;
  query_used: string;
  method: "rss" | "sitemap";
  articles: Article[];
  reason?: string;
  filtered_by_topic?: number;
  truncated_by_cap?: number;
}

export interface BatchSummary {
  total_sources: number;
  total_articles: number;
  total_ms: number;
  ok: number;
  empty: number;
  fail: number;
  timeout: number;
}

async function runOne(
  src: SourceSpec,
  days: number,
  timeoutMs: number,
): Promise<RunRecord> {
  const startedAt = Date.now();
  const isSitemap = src.rss.endsWith("sitemap.xml");
  const method: "rss" | "sitemap" = isSitemap ? "sitemap" : "rss";
  const topicFilter = src.filter
    ? src.filter.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  try {
    // Promise.race com timeout custom
    const fetchPromise = isSitemap
      ? fetchSitemapEntries({ url: src.rss, sourceName: src.name, days })
      : fetchRss({ url: src.rss, sourceName: src.name, days, topicFilter });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout_60s")), timeoutMs),
    );
    const result = await Promise.race([fetchPromise, timeoutPromise]);

    const duration_ms = Date.now() - startedAt;
    const articles = result.articles ?? [];

    if (result.error) {
      return {
        source: src.name,
        outcome: "fail",
        duration_ms,
        query_used: src.rss,
        method,
        articles: [],
        reason: result.error.slice(0, 200),
      };
    }

    const out: RunRecord = {
      source: src.name,
      outcome: articles.length > 0 ? "ok" : "empty",
      duration_ms,
      query_used: src.rss,
      method,
      articles: articles.map((a) => ({ ...a, source: src.name })),
    };
    // filtered_by_topic só existe em RSS results; truncated_by_cap em ambos.
    if ("filtered_by_topic" in result && typeof result.filtered_by_topic === "number") {
      out.filtered_by_topic = result.filtered_by_topic;
    }
    if (typeof result.truncated_by_cap === "number") {
      out.truncated_by_cap = result.truncated_by_cap;
    }
    return out;
  } catch (err) {
    const duration_ms = Date.now() - startedAt;
    const reason = err instanceof Error ? err.message : String(err);
    const isTimeout = reason === "timeout_60s";
    return {
      source: src.name,
      outcome: isTimeout ? "timeout" : "fail",
      duration_ms,
      query_used: src.rss,
      method,
      articles: [],
      reason: reason.slice(0, 200),
    };
  }
}

/**
 * Roda fetchRss/fetchSitemap pra todas as sources em paralelo.
 *
 * Concurrency: default = sources.length (full parallel). Pode ser limitado
 * via opcional `concurrency` pra evitar throttle em casos extremos.
 */
export async function runBatch(
  sources: SourceSpec[],
  opts: { days: number; timeoutPerFeedMs: number; concurrency?: number },
): Promise<{ results: RunRecord[]; summary: BatchSummary }> {
  const startTotal = Date.now();
  const concurrency = opts.concurrency ?? sources.length;

  // Simple concurrency limit via batched Promise.all
  const results: RunRecord[] = [];
  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((src) => runOne(src, opts.days, opts.timeoutPerFeedMs)),
    );
    results.push(...batchResults);
  }

  const total_ms = Date.now() - startTotal;
  const total_articles = results.reduce((acc, r) => acc + r.articles.length, 0);
  const summary: BatchSummary = {
    total_sources: sources.length,
    total_articles,
    total_ms,
    ok: results.filter((r) => r.outcome === "ok").length,
    empty: results.filter((r) => r.outcome === "empty").length,
    fail: results.filter((r) => r.outcome === "fail").length,
    timeout: results.filter((r) => r.outcome === "timeout").length,
  };
  return { results, summary };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sources || !args.out) {
    console.error(
      "Uso: fetch-rss-batch.ts --sources <sources.json> --out <results.json> [--days 3] [--timeout-per-feed 60000] [--concurrency N]",
    );
    process.exit(2);
  }
  const sourcesPath = resolve(args.sources);
  const outPath = resolve(args.out);
  if (!existsSync(sourcesPath)) {
    console.error(`Arquivo não existe: ${sourcesPath}`);
    process.exit(2);
  }

  const sources: SourceSpec[] = JSON.parse(readFileSync(sourcesPath, "utf8"));
  if (!Array.isArray(sources) || sources.length === 0) {
    console.error(`sources.json deve ser array não-vazio de { name, rss, filter? }`);
    process.exit(2);
  }

  const days = args.days ? parseInt(args.days, 10) : 3;
  const timeoutPerFeedMs = args["timeout-per-feed"]
    ? parseInt(args["timeout-per-feed"], 10)
    : 60000;
  const concurrency = args.concurrency ? parseInt(args.concurrency, 10) : undefined;

  const { results, summary } = await runBatch(sources, {
    days,
    timeoutPerFeedMs,
    concurrency,
  });

  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

const _argv1 = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (/\/scripts\/fetch-rss-batch\.ts$/.test(_argv1)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
