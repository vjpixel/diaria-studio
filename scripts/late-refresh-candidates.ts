#!/usr/bin/env tsx
/**
 * late-refresh-candidates.ts (#9370)
 *
 * Refresh tardio pré-gate-4: lista o que saiu DEPOIS da pesquisa do Stage 1
 * nas fontes oficiais de laboratório de fronteira e nas newsletters que
 * chegaram depois da captura do Stage 0 — deduplicado contra a edição atual
 * (`02-reviewed.md` + pool do `01-categorized.json`) e as anteriores
 * (`data/past-editions.md`), com sugestão de substituição.
 *
 * SÓ LEITURA da edição: nunca altera `02-reviewed.md`/`01-approved.json`. O
 * resultado vira o bloco `{late_refresh_block}` do gate 4 e o editor decide.
 * Fail-soft por fonte: feed fora do ar / Gmail sem credencial viram nota no
 * bloco, nunca erro. Exit 0 sempre, exceto uso inválido (exit 2).
 *
 * Newsletters: busca via `scripts/fetch-newsletter-threads.ts` (Gmail REST,
 * mesmo caminho do Stage 0 0b-bis) num diretório PRÓPRIO
 * (`_internal/late-refresh/`) — não toca `captured-newsletters.json` nem o
 * cursor `data/newsletter-capture-cursor.json` (a thread continua disponível
 * pra próxima edição se o editor não a usar). A extração de URLs reusa
 * `processThreads` de `capture-newsletter-urls.ts` (consumido, não alterado).
 *
 * Uso:
 *   npx tsx scripts/late-refresh-candidates.ts --edition-dir {EDITION_DIR}/ \
 *     [--now ISO] [--threads FILE] [--past-editions FILE] \
 *     [--skip-newsletters] [--skip-feeds] [--json]
 *
 *   --threads        CapturedThread[] já buscado (pula o Gmail; replay/teste).
 *   --past-editions  default data/past-editions.md.
 *
 * Saída: `_internal/04-late-refresh.json` (relatório completo). Stdout: o
 * bloco texto pro gate (ou o JSON, com `--json`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fetchRss, parseFeed } from "./fetch-rss.ts";
import { enrichEntry, parseSitemap } from "./lib/fetch-sitemap.ts";
import { processThreads, type CapturedThread } from "./capture-newsletter-urls.ts";
import { extractPastUrlsUnbounded, readPastEditionsMd, readReviewedDestaqueUrls } from "./lib/past-editions-extract.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runTsx } from "./lib/run-tsx.ts";
import { stripHtmlBasic } from "./lib/strip-html.ts";
import {
  IMPRECISE_DATE_LOOKBACK_MS,
  LATE_REFRESH_FEEDS,
  LATE_REFRESH_UNCOVERED_LABS,
  canonicalUrlSet,
  extractIndexPageLinks,
  extractPublishedTime,
  feedReportRow,
  filterLateArticles,
  formatLateRefreshBlock,
  githubHttpError,
  postProcessFeedArticles,
  resolveCutoffs,
  uncoveredLabsAtRuntime,
  selectSitemapEntries,
  suggestSubstitution,
  summarizeLateThreads,
  type FeedProcessed,
  type GithubNewReposFeed,
  type GithubReleasesFeed,
  type HighlightLike,
  type IndexPageFeed,
  type LateArticle,
  type LateRefreshFeed,
  type SitemapFeed,
  type LateRefreshReport,
  type LateThreadInput,
} from "./lib/late-refresh.ts";

const ROOT = resolve(import.meta.dirname, "..");
const FEED_TIMEOUT_MS = 20_000;
const SITEMAP_ENRICH_CAP = 15;

function readJson(path: string): unknown {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  } catch {
    return undefined;
  }
}

function readText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

async function fetchSitemapAfter(feed: SitemapFeed, cutoffIso: string): Promise<LateArticle[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  let xml: string;
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": "DiariaBot/1.0 (+https://diar.ia.br)" }, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }
  const entries = selectSitemapEntries(parseSitemap(xml), cutoffIso, feed.pathPrefix, SITEMAP_ENRICH_CAP);
  const enriched = await Promise.all(entries.map((e) => enrichEntry(e, { timeoutMs: FEED_TIMEOUT_MS })));
  return enriched.map((e) => ({
    url: e.loc,
    title: e.title ?? "",
    published_at: e.lastmod,
    summary: e.description ?? e.body_excerpt ?? "",
    lab: feed.lab,
    source: feed.name,
  }));
}

const BOT_HEADERS = { "User-Agent": "DiariaBot/1.0 (+https://diar.ia.br)" } as const;

async function fetchHtml(url: string, fetchImpl: typeof fetch): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: BOT_HEADERS, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function metaContent(html: string, attr: "property" | "name", key: string): string {
  const m =
    html.match(new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']+)["']`, "i")) ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${key}["']`, "i"));
  return m ? stripHtmlBasic(m[1]) : "";
}

/**
 * #9870: página-índice → os `take` primeiros artigos, cada um com a data da
 * própria página. Página de artigo que falha vira artigo sem data (o corte
 * por data o descarta) — o feed só falha inteiro se o ÍNDICE falhar. Desde o
 * #9919 cada falha de página é logada (`warn`, stderr por padrão) e índice
 * vazio / nenhum artigo com data vira `format_suspect` no pós-processamento.
 */
export async function fetchIndexPageAfter(
  feed: IndexPageFeed,
  fetchImpl: typeof fetch = fetch,
  warn: (msg: string) => void = (msg) => console.error(msg),
): Promise<LateArticle[]> {
  const links = extractIndexPageLinks(await fetchHtml(feed.url, fetchImpl), feed.url, feed.pathPrefix, feed.take);
  if (links.length === 0) warn(`[late-refresh] WARN ${feed.name}: índice ${feed.url} sem nenhum link em ${feed.pathPrefix}`);
  return Promise.all(
    links.map(async (url): Promise<LateArticle> => {
      let html = "";
      try {
        html = await fetchHtml(url, fetchImpl);
      } catch (e) {
        html = "";
        warn(`[late-refresh] WARN ${feed.name}: falha ao buscar ${url} (${e instanceof Error ? e.message : String(e)}) — artigo fica sem data`);
      }
      const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      return {
        url,
        title: metaContent(html, "property", "og:title") || (titleTag ? stripHtmlBasic(titleTag[1]) : ""),
        published_at: html ? extractPublishedTime(html) : null,
        summary: metaContent(html, "property", "og:description") || metaContent(html, "name", "description"),
        lab: feed.lab,
        source: feed.name,
      };
    }),
  );
}

const GITHUB_HEADERS = BOT_HEADERS;

/**
 * #9424: GET no GitHub com erro acionável (rate limit com horário de reset,
 * 404 nomeando o que não existe). `fetchImpl` injetável pra teste.
 */
async function githubGet(
  feed: GithubReleasesFeed | GithubNewReposFeed,
  accept: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetchImpl(feed.url, { headers: { ...GITHUB_HEADERS, Accept: accept }, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(githubHttpError(res.status, res.headers, await res.text().catch(() => ""), feed.method));
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchFeedResult {
  articles: LateArticle[];
  processed?: FeedProcessed;
  error?: string;
}

/**
 * Busca + pós-processa um feed. Nunca lança: falha vira `error` (o relatório
 * marca `ok: false`). `fetchImpl` injetável — usado pelos métodos do GitHub
 * (o RSS genérico segue no `fetchRss`, que tem o fetch dele).
 */
export async function fetchFeed(
  feed: LateRefreshFeed,
  cutoffIso: string,
  now: Date,
  fetchImpl: typeof fetch = fetch,
  warn: (msg: string) => void = (msg) => console.error(msg),
): Promise<FetchFeedResult> {
  try {
    if (feed.method === "sitemap") {
      const articles = await fetchSitemapAfter(feed, cutoffIso);
      return { articles, processed: postProcessFeedArticles(feed, articles) };
    }
    if (feed.method === "index-page") {
      const articles = await fetchIndexPageAfter(feed, fetchImpl, warn);
      return { articles, processed: postProcessFeedArticles(feed, articles) };
    }
    if (feed.method === "github-new-repos") {
      // #9424: repos públicos da org pela API REST oficial (sem token: 60 req/h por IP, 3 chamadas por gate).
      const res = await githubGet(feed, "application/vnd.github+json", fetchImpl);
      const processed = postProcessFeedArticles(feed, await res.json());
      return { articles: processed.articles, processed };
    }
    const toLate = (a: { url: string; title: string; published_at?: string | null; summary?: string }): LateArticle => ({
      url: a.url,
      title: a.title,
      published_at: a.published_at ?? null,
      summary: a.summary,
      lab: feed.lab,
      source: feed.name,
    });
    if (feed.method === "github-releases") {
      // Atom de releases do GitHub — corta nightly/rc/patch pela tag (o corte por data é do filterLateArticles).
      const res = await githubGet(feed, "application/atom+xml, application/xml, */*", fetchImpl);
      const processed = postProcessFeedArticles(feed, parseFeed(await res.text()).articles.map(toLate));
      return { articles: processed.articles, processed };
    }
    const days = Math.max(1, Math.ceil((now.getTime() - new Date(cutoffIso).getTime() + IMPRECISE_DATE_LOOKBACK_MS) / 86_400_000));
    const r = await fetchRss({ url: feed.url, sourceName: feed.name, days, timeoutMs: FEED_TIMEOUT_MS, now });
    const processed = postProcessFeedArticles(feed, r.articles.map(toLate));
    return { articles: processed.articles, processed, ...(r.error ? { error: r.error } : {}) };
  } catch (e) {
    return { articles: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Gmail via fetch-newsletter-threads.ts (subprocesso, diretório próprio). */
function fetchLateThreads(editionDir: string, cutoffIso: string, now: Date): { threads: CapturedThread[]; error?: string } {
  const cfg = readJson(join(ROOT, "platform.config.json")) as { newsletter_auto_capture?: { enabled?: boolean; senders?: unknown } } | undefined;
  const nac = cfg?.newsletter_auto_capture;
  const senders = Array.isArray(nac?.senders) ? (nac.senders as unknown[]).map(String) : [];
  if (nac?.enabled !== true || senders.length === 0) return { threads: [], error: "newsletter_auto_capture desligado/sem senders" };
  const outDir = join(editionDir, "_internal", "late-refresh");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, "threads.json");
  const hours = Math.max(1, Math.ceil((now.getTime() - new Date(cutoffIso).getTime()) / 3_600_000) + 1);
  try {
    runTsx(join(ROOT, "scripts", "fetch-newsletter-threads.ts"), ["--senders", senders.join(","), "--since-hours", String(hours), "--out", out], {
      cwd: ROOT,
      stdout: "ignore",
    });
  } catch (e) {
    return { threads: [], error: `fetch-newsletter-threads falhou (${e instanceof Error ? e.message.split("\n")[0] : String(e)})` };
  }
  const raw = readJson(out);
  return { threads: Array.isArray(raw) ? (raw as CapturedThread[]) : [] };
}

/** URLs por thread via processThreads (cursor vazio = não consome nada do cursor real). */
export function threadsToLateInputs(threads: readonly CapturedThread[]): LateThreadInput[] {
  return threads.map((th) => {
    const { articles } = processThreads([th], { processed_thread_ids: [] });
    return { thread_id: th.thread_id, sender: th.sender, subject: th.subject, date: th.date, urls: articles.map((a) => a.url) };
  });
}

export async function buildLateRefreshReport(opts: {
  editionDir: string;
  now: Date;
  skipFeeds: boolean;
  skipNewsletters: boolean;
  pastEditionsPath: string;
  /** Threads pré-buscadas (CapturedThread[]) — pula o Gmail. */
  threadsPath?: string;
}): Promise<LateRefreshReport> {
  const internal = join(opts.editionDir, "_internal");
  const cutoffs = resolveCutoffs(readJson(join(internal, "stage-status.json")), readJson(join(internal, ".step-1-done.json")));
  const base: LateRefreshReport = {
    generated_at: opts.now.toISOString(),
    cutoffs,
    feeds: [],
    uncovered_labs: LATE_REFRESH_UNCOVERED_LABS,
    candidates: [],
    already_in_edition: 0,
    already_published: 0,
    newsletters: [],
  };
  if (!cutoffs.research_cutoff || !cutoffs.newsletter_cutoff) {
    return { ...base, skipped_reason: "início do Stage 1 desconhecido (sem stage-status.json nem .step-1-done.json)" };
  }

  const inEdition = canonicalUrlSet(
    readText(join(opts.editionDir, "02-reviewed.md")),
    readText(join(internal, "01-categorized.json")),
    readText(join(internal, "01-approved.json")),
  );
  const published = extractPastUrlsUnbounded(readPastEditionsMd(opts.pastEditionsPath));
  const approved = readJson(join(internal, "01-approved.json")) as { highlights?: HighlightLike[] } | undefined;
  const highlights = Array.isArray(approved?.highlights) ? approved.highlights : [];
  // Ordem ATUAL de D1..D3 (o editor pode ter reordenado/trocado desde o Stage 1).
  const currentOrder = readReviewedDestaqueUrls(join(opts.editionDir, "02-reviewed.md"));

  if (!opts.skipFeeds) {
    const results = await Promise.all(LATE_REFRESH_FEEDS.map((f) => fetchFeed(f, cutoffs.research_cutoff as string, opts.now)));
    const all: LateArticle[] = [];
    results.forEach((r, i) => {
      const feed = LATE_REFRESH_FEEDS[i];
      const after = filterLateArticles(r.articles, cutoffs.research_cutoff as string, new Set(), new Set(), opts.now.toISOString()).fresh;
      base.feeds.push(feedReportRow(feed, r, after.length));
      all.push(...r.articles);
    });
    // #9424: lab com TODOS os feeds falhando nesta rodada também está descoberto.
    base.uncovered_labs = uncoveredLabsAtRuntime(base.feeds);
    const filtered = filterLateArticles(all, cutoffs.research_cutoff, inEdition, published, opts.now.toISOString());
    base.candidates = filtered.fresh.map((a) => ({ ...a, suggestion: suggestSubstitution(a, highlights, currentOrder) }));
    base.already_in_edition = filtered.already_in_edition.length;
    base.already_published = filtered.already_published.length;
  }

  if (!opts.skipNewsletters) {
    const { threads, error } = opts.threadsPath
      ? { threads: (readJson(opts.threadsPath) as CapturedThread[] | undefined) ?? [], error: undefined }
      : fetchLateThreads(opts.editionDir, cutoffs.newsletter_cutoff, opts.now);
    if (error) base.newsletter_error = error;
    const captured = readJson(join(internal, "captured-newsletters.json"));
    const capturedIds = new Set(Array.isArray(captured) ? (captured as Array<{ thread_id?: string }>).map((t) => String(t.thread_id)) : []);
    base.newsletters = summarizeLateThreads(threadsToLateInputs(threads), capturedIds, cutoffs.newsletter_cutoff, inEdition, published, opts.now.toISOString());
  }
  return base;
}

async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionDir = values["edition-dir"];
  if (!editionDir) {
    console.error("uso: late-refresh-candidates.ts --edition-dir {EDITION_DIR}/ [--now ISO] [--threads FILE] [--past-editions FILE] [--skip-newsletters] [--skip-feeds] [--json]");
    process.exit(2);
  }
  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`--now inválido: ${values.now}`);
    process.exit(2);
  }
  const absDir = resolve(editionDir);
  const report = await buildLateRefreshReport({
    editionDir: absDir,
    now,
    skipFeeds: flags.has("skip-feeds"),
    skipNewsletters: flags.has("skip-newsletters"),
    pastEditionsPath: values["past-editions"] ? resolve(values["past-editions"]) : join(ROOT, "data", "past-editions.md"),
    ...(values.threads ? { threadsPath: resolve(values.threads) } : {}),
  });
  try {
    mkdirSync(join(absDir, "_internal"), { recursive: true });
    writeFileSync(join(absDir, "_internal", "04-late-refresh.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  } catch (e) {
    console.error(`[late-refresh] WARN não gravou 04-late-refresh.json: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(flags.has("json") ? JSON.stringify(report, null, 2) : formatLateRefreshBlock(report));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    // Fail-soft: o gate nunca depende deste passo.
    console.log(`⚠️ Refresh tardio indisponível: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(0);
  });
}
