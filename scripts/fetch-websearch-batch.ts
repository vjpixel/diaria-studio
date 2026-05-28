#!/usr/bin/env npx tsx
/**
 * fetch-websearch-batch.ts (#1555 — P0 full)
 *
 * Substitui os agents `source-researcher` (Haiku) e `discovery-searcher` (Haiku)
 * por dispatch determinístico via Brave Search API + filtros TS. Quando
 * `BRAVE_API_KEY` está no env, este script roda step 1f inteiro de uma vez.
 * Quando ausente, orchestrator deve fallback pros agents.
 *
 * Economia: ~8-12min/edição vs 16 agents Haiku sequenciais.
 *
 * Uso:
 *   npx tsx scripts/fetch-websearch-batch.ts \
 *     --sources data/editions/{AAMMDD}/_internal/websearch-batch.json \
 *     --discovery data/editions/{AAMMDD}/_internal/inbox-topics.json \
 *     --cutoff-iso 2026-05-25 \
 *     --window-days 3 \
 *     --out data/editions/{AAMMDD}/_internal/websearch-results.json
 *
 * Sources input (mesmo shape de list-active-sources.ts):
 *   [{ "name": "OpenAI", "site_query": "openai.com" }, ...]
 *
 * Discovery topics input:
 *   [{ "query": "open source LLM benchmark" }, ...]
 *   OU array de strings: ["open source LLM benchmark", ...]
 *
 * Output (RunRecord[] compatível com researcher-results.json):
 *   [{ source, outcome, duration_ms, query_used, method, articles[], reason? }, ...]
 *
 * Variáveis de ambiente:
 *   BRAVE_API_KEY (obrigatória) — gerar em https://brave.com/search/api/
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { braveSearch, freshnessForWindow, type BraveWebResult } from "./lib/brave-search.ts";
import { isAggregator } from "./lib/aggregator-blocklist.ts";
import { containsAITerms } from "./lib/ai-relevance.ts";
import { isNonEditorialPath } from "./lib/non-editorial-paths.ts"; // #1559 A
import { fetchOgMetadata } from "./lib/extract-og.ts"; // #1559 B
import { recordBraveCredit } from "./lib/brave-credits.ts"; // #1558

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Brave free tier: 1 query/segundo. Adicionar buffer pra evitar 429.
const BRAVE_RATE_LIMIT_MS = 1100;

// #1559 B: top-N candidatos por query são enriquecidos com OG tags.
// Default 5 — top 5 results provavelmente contêm o highlight; resto fica
// com snippet da Brave (suficiente pra scorer descartar baixa relevância).
const OG_ENRICH_TOP_N = 5;
const OG_FETCH_CONCURRENCY = 5;

export interface SourceSpec {
  name: string;
  site_query?: string;
}

export interface DiscoveryTopic {
  query: string;
}

export interface BatchArticle {
  url: string;
  title: string;
  summary: string;
  source: string;
  date?: string;
  type_hint?: string;
  discovered_source?: boolean;
}

export interface RunRecord {
  source: string;
  outcome: "ok" | "empty" | "fail";
  duration_ms: number;
  query_used: string;
  method: "websearch_brave";
  articles: BatchArticle[];
  reason?: string;
  filtered_by_date?: number;
  filtered_by_aggregator?: number;
  filtered_by_relevance?: number;
  filtered_by_non_editorial_path?: number; // #1559 A
  og_enriched?: number; // #1559 B
  og_failed?: number; // #1559 B
}

interface Args {
  sources?: string;
  discovery?: string;
  cutoffIso: string;
  windowDays: number;
  out: string;
  edition?: string; // #1558: AAMMDD pra tracking de credits por edição
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--sources") args.sources = argv[++i];
    else if (k === "--discovery") args.discovery = argv[++i];
    else if (k === "--cutoff-iso") args.cutoffIso = argv[++i];
    else if (k === "--window-days") args.windowDays = Number(argv[++i]);
    else if (k === "--out") args.out = argv[++i];
    else if (k === "--edition") args.edition = argv[++i]; // #1558
  }
  if (!args.cutoffIso || args.windowDays === undefined || !args.out) {
    console.error(
      "Uso: fetch-websearch-batch.ts --cutoff-iso <YYYY-MM-DD> --window-days <N> --out <path> [--sources <path>] [--discovery <path>]",
    );
    process.exit(2);
  }
  return args as Args;
}

/**
 * Pure: converte uma Brave search result + source name num BatchArticle,
 * aplicando filtros (data, aggregator, relevância).
 *
 * Retorna `{ kept: BatchArticle | null, reason?: "filtered_by_date" | ... }`
 * pra caller acumular contadores.
 */
export function processResult(
  r: BraveWebResult,
  sourceName: string,
  cutoffIso: string,
  discovered = false,
): { kept: BatchArticle | null; reason?: "date" | "aggregator" | "relevance" | "non_editorial_path" } {
  // 1. Aggregator check
  const aggCheck = isAggregator(r.url);
  if (aggCheck.blocked) {
    return { kept: null, reason: "aggregator" };
  }

  // 2. Non-editorial path check (#1559) — drop help/FAQ/about/legal pages
  // que vêm pelo site:query mas não são conteúdo editorial. Caso real 260529:
  // site:openai.com retornou help.openai.com/articles/... como artigo.
  if (isNonEditorialPath(r.url)) {
    return { kept: null, reason: "non_editorial_path" };
  }

  // 3. AI relevance check (title + description)
  const text = `${r.title} ${r.description}`;
  if (!containsAITerms(text)) {
    return { kept: null, reason: "relevance" };
  }

  // 3. Date filter — usar page_age quando disponível
  let date: string | undefined;
  if (r.page_age) {
    const d = new Date(r.page_age);
    if (!isNaN(d.getTime())) {
      date = d.toISOString().split("T")[0];
      if (date && date < cutoffIso) {
        return { kept: null, reason: "date" };
      }
    }
  }
  // Se page_age ausente, deixar passar — verify-dates corrige downstream

  return {
    kept: {
      url: r.url,
      title: r.title.replace(/<\/?strong>/g, ""), // Brave às vezes adiciona highlight tags
      summary: r.description.replace(/<\/?strong>/g, ""),
      source: sourceName,
      ...(date ? { date } : {}),
      type_hint: "noticia",
      ...(discovered ? { discovered_source: true } : {}),
    },
  };
}

/**
 * Roda uma query Brave + processa resultados.
 * Caller deve respeitar rate limit antes de chamar.
 */
async function runQuery(
  query: string,
  sourceName: string,
  args: Args,
  apiKey: string,
  discovered = false,
): Promise<RunRecord> {
  const startedAt = Date.now();
  const freshness = freshnessForWindow(args.windowDays);
  const response = await braveSearch(query, {
    apiKey,
    count: 15,
    freshness,
  });

  const duration_ms = Date.now() - startedAt;

  // #1558: log credit usage (apenas pra status que CONTAM contra free tier)
  if (response.status === "ok" || response.status === "rate_limited") {
    recordBraveCredit({
      edition: args.edition,
      query,
      status: response.status,
      http_status: response.http_status,
    });
  }

  if (response.status !== "ok") {
    return {
      source: sourceName,
      outcome: "fail",
      duration_ms,
      query_used: query,
      method: "websearch_brave",
      articles: [],
      reason: `${response.status}: ${response.error_message ?? "unknown"}`,
    };
  }

  const articles: BatchArticle[] = [];
  let filtered_by_date = 0;
  let filtered_by_aggregator = 0;
  let filtered_by_relevance = 0;
  let filtered_by_non_editorial_path = 0;

  for (const r of response.results) {
    const { kept, reason } = processResult(r, sourceName, args.cutoffIso, discovered);
    if (kept) {
      articles.push(kept);
    } else if (reason === "date") filtered_by_date++;
    else if (reason === "aggregator") filtered_by_aggregator++;
    else if (reason === "non_editorial_path") filtered_by_non_editorial_path++;
    else if (reason === "relevance") filtered_by_relevance++;
  }

  // #1559 B: enriquecer top-N com OG tags (parallel fetches)
  let og_enriched = 0;
  let og_failed = 0;
  if (articles.length > 0) {
    const enrichResult = await enrichWithOgTags(articles);
    og_enriched = enrichResult.enriched;
    og_failed = enrichResult.failed;
  }

  return {
    source: sourceName,
    outcome: articles.length > 0 ? "ok" : "empty",
    duration_ms: Date.now() - startedAt, // recalcular após OG enrich
    query_used: query,
    method: "websearch_brave",
    articles,
    filtered_by_date,
    filtered_by_aggregator,
    filtered_by_relevance,
    filtered_by_non_editorial_path,
    og_enriched,
    og_failed,
  };
}

/**
 * #1559 B: enriquece top-N articles com OG metadata via fetch direto.
 * Brave snippet às vezes é pobre (FAQ truncado, sem date). OG tags do HTML
 * têm title/description/published_time de melhor qualidade.
 *
 * Falha de fetch (timeout, 4xx) → mantém snippet original. Defensive.
 * Atualiza article in-place quando OG retorna dados melhores.
 */
async function enrichWithOgTags(
  articles: BatchArticle[],
  topN: number = OG_ENRICH_TOP_N,
): Promise<{ enriched: number; failed: number }> {
  const targets = articles.slice(0, topN);
  let enriched = 0;
  let failed = 0;
  // Bounded concurrency via batches
  for (let i = 0; i < targets.length; i += OG_FETCH_CONCURRENCY) {
    const batch = targets.slice(i, i + OG_FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map((a) => fetchOgMetadata(a.url)));
    for (let j = 0; j < batch.length; j++) {
      const og = results[j];
      const article = batch[j];
      if (!og) {
        failed++;
        continue;
      }
      let updated = false;
      // Só sobrescrever se OG retornou algo melhor (não-vazio + não-trivial)
      if (og.title && og.title.length > 5 && og.title !== article.title) {
        article.title = og.title;
        updated = true;
      }
      if (og.description && og.description.length > 20 && og.description !== article.summary) {
        article.summary = og.description;
        updated = true;
      }
      if (og.publishedTime && !article.date) {
        const d = new Date(og.publishedTime);
        if (!isNaN(d.getTime())) {
          article.date = d.toISOString().split("T")[0];
          updated = true;
        }
      }
      if (updated) enriched++;
    }
  }
  return { enriched, failed };
}

/**
 * Builds the site: query from source spec. If `site_query` already starts
 * with "site:", uses as-is; otherwise prefixes.
 */
export function buildSourceQuery(src: SourceSpec): string {
  const sq = src.site_query ?? "";
  const sitePart = sq.startsWith("site:") ? sq : `site:${sq}`;
  return `${sitePart} AI OR "inteligência artificial" OR "artificial intelligence"`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    console.error("[fetch-websearch-batch] BRAVE_API_KEY ausente — caller deve fallback pra agents");
    process.exit(3); // exit code 3 = "no api key, fallback"
  }

  // Load sources
  const sources: SourceSpec[] = args.sources && existsSync(resolve(ROOT, args.sources))
    ? JSON.parse(readFileSync(resolve(ROOT, args.sources), "utf8"))
    : [];

  // Load discovery topics (aceita ambos shapes: array de strings ou array de {query})
  let discoveryTopics: DiscoveryTopic[] = [];
  if (args.discovery && existsSync(resolve(ROOT, args.discovery))) {
    const raw = JSON.parse(readFileSync(resolve(ROOT, args.discovery), "utf8"));
    if (Array.isArray(raw)) {
      discoveryTopics = raw.map((item) =>
        typeof item === "string" ? { query: item } : item,
      );
    }
  }

  const totalQueries = sources.length + discoveryTopics.length;
  console.error(
    `[fetch-websearch-batch] ${sources.length} fontes + ${discoveryTopics.length} discovery queries = ${totalQueries} total`,
  );

  // Rate-limited serial dispatch (Brave free tier: 1 req/sec)
  const results: RunRecord[] = [];
  const startBatch = Date.now();
  let queryIdx = 0;

  for (const src of sources) {
    if (queryIdx > 0) await sleep(BRAVE_RATE_LIMIT_MS);
    queryIdx++;
    const query = buildSourceQuery(src);
    const result = await runQuery(query, src.name, args, apiKey, false);
    results.push(result);
    console.error(
      `[fetch-websearch-batch] ${queryIdx}/${totalQueries} ${src.name}: ${result.outcome} (${result.articles.length} articles, ${result.duration_ms}ms)`,
    );
  }

  for (const topic of discoveryTopics) {
    if (queryIdx > 0) await sleep(BRAVE_RATE_LIMIT_MS);
    queryIdx++;
    const sourceName = `discovery: ${topic.query.slice(0, 40)}`;
    const result = await runQuery(topic.query, sourceName, args, apiKey, true);
    results.push(result);
    console.error(
      `[fetch-websearch-batch] ${queryIdx}/${totalQueries} ${sourceName}: ${result.outcome} (${result.articles.length} articles, ${result.duration_ms}ms)`,
    );
  }

  const totalMs = Date.now() - startBatch;
  const totalArticles = results.reduce((s, r) => s + r.articles.length, 0);
  const ok = results.filter((r) => r.outcome === "ok").length;
  const empty = results.filter((r) => r.outcome === "empty").length;
  const fail = results.filter((r) => r.outcome === "fail").length;

  // Atomic write
  const outAbs = resolve(ROOT, args.out);
  const tmpPath = outAbs + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(results, null, 2), "utf8");
  const { renameSync } = await import("node:fs");
  renameSync(tmpPath, outAbs);

  console.error(
    `[fetch-websearch-batch] done in ${(totalMs / 1000).toFixed(1)}s: ${ok} ok, ${empty} empty, ${fail} fail, ${totalArticles} articles total → ${args.out}`,
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[fetch-websearch-batch] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
