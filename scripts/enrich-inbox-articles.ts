/**
 * enrich-inbox-articles.ts
 *
 * Resolves the metadata gap from #109: URLs submitted via the editorial
 * inbox enter the pipeline as synthetic articles with title="(inbox)" and
 * no summary. The writer (Stage 2) then skips them because there is no
 * verifiable content. This script bridges that gap: for each inbox URL
 * in the articles JSON, fetches the page and extracts og:title /
 * og:description / <title> / <meta name=description> as title + summary.
 *
 * Designed to slot in between `verify-accessibility.ts` (which already
 * resolves the final URL of shortened inbox links like share.google/*) and
 * `categorize.ts`. Pure helpers are exported for unit testing; the CLI
 * fetches over the network and writes the enriched JSON in place.
 *
 * Usage:
 *   npx tsx scripts/enrich-inbox-articles.ts \
 *     --in data/editions/260424/_internal/01-pool.json \
 *     [--timeout-ms 10000] [--concurrency 4] [--user-agent "Mozilla/5.0 (...)"]
 *
 * Input shape: array of { url, title?, summary?, flag?, source?, ... }
 * Behaviour: only entries that look unenriched (per `needsEnrichment`) get
 * fetched. Successful fetches replace title and/or summary in place.
 * Failures leave the article untouched and are logged on stderr.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { request } from "undici";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InboxArticle {
  url: string;
  title?: string | null;
  summary?: string | null;
  flag?: string;
  source?: string;
  [key: string]: unknown;
}

export interface PageMetadata {
  title: string | null;
  summary: string | null;
}

export interface EnrichOutcome {
  url: string;
  enriched: boolean;
  title_updated: boolean;
  summary_updated: boolean;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; DiariaBot/1.0; +https://diaria.beehiiv.com)";

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

const PLACEHOLDER_TITLES = [
  "(inbox)",
  "(no title)",
  "(sem título)",
];

/** Whether an article looks like an unenriched inbox synthetic. */
export function needsEnrichment(article: InboxArticle): boolean {
  const isInbox =
    article.flag === "editor_submitted" ||
    article.source === "inbox";
  if (!isInbox) return false;

  const title = (article.title ?? "").trim();
  const summary = (article.summary ?? "").trim();

  // Placeholder title or an "[INBOX]" / "(...)" prefix scheme.
  const placeholderTitle =
    !title ||
    PLACEHOLDER_TITLES.includes(title.toLowerCase()) ||
    /^\[inbox\]/i.test(title) ||
    /^\(inbox/i.test(title);

  return placeholderTitle || !summary;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)));
}

function extractMetaContent(html: string, name: string, attr: "name" | "property"): string | null {
  // Match content quoted with " or ', and match the same quote on both sides
  // so apostrophes inside double-quoted values aren't treated as boundaries.
  const variants = [
    new RegExp(
      `<meta[^>]+${attr}=["']${name}["'][^>]+content="([^"]*)"`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+${attr}=["']${name}["'][^>]+content='([^']*)'`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content="([^"]*)"[^>]+${attr}=["']${name}["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content='([^']*)'[^>]+${attr}=["']${name}["']`,
      "i",
    ),
  ];
  for (const re of variants) {
    const m = html.match(re);
    if (m) {
      const cleaned = decodeHtmlEntities(m[1]).trim();
      if (cleaned.length > 0) return cleaned;
    }
  }
  return null;
}

function extractTitleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  // Collapse whitespace; many sites pad <title> with newlines.
  const cleaned = decodeHtmlEntities(m[1]).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Extracts the strongest available title and summary from raw HTML.
 * Priority for both fields: og:* > twitter:* > <title> / meta description.
 */
export function extractMetadata(html: string): PageMetadata {
  const title =
    extractMetaContent(html, "og:title", "property") ??
    extractMetaContent(html, "twitter:title", "name") ??
    extractTitleTag(html);

  const summary =
    extractMetaContent(html, "og:description", "property") ??
    extractMetaContent(html, "twitter:description", "name") ??
    extractMetaContent(html, "description", "name");

  return { title, summary };
}

/**
 * Returns a new article merging extracted metadata with the existing one.
 * Existing non-placeholder fields are preserved (defensive: do not clobber
 * editor-curated titles even on enrichable articles).
 */
export function mergeMetadata(
  article: InboxArticle,
  meta: PageMetadata,
): { article: InboxArticle; titleUpdated: boolean; summaryUpdated: boolean } {
  const out: InboxArticle = { ...article };
  let titleUpdated = false;
  let summaryUpdated = false;

  const currentTitle = (article.title ?? "").trim();
  const titleIsPlaceholder =
    !currentTitle ||
    PLACEHOLDER_TITLES.includes(currentTitle.toLowerCase()) ||
    /^\[inbox\]/i.test(currentTitle) ||
    /^\(inbox/i.test(currentTitle);

  if (meta.title && titleIsPlaceholder) {
    out.title = meta.title;
    titleUpdated = true;
  }

  const currentSummary = (article.summary ?? "").trim();
  if (meta.summary && !currentSummary) {
    out.summary = meta.summary;
    summaryUpdated = true;
  }

  return { article: out, titleUpdated, summaryUpdated };
}

// ---------------------------------------------------------------------------
// Network — fetch HTML with timeout
// ---------------------------------------------------------------------------

async function fetchHtml(
  url: string,
  timeoutMs: number,
  userAgent: string,
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await request(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "user-agent": userAgent, accept: "text/html,*/*" },
    });
    if (res.statusCode >= 400) return null;
    const body = await res.body.text();
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface EnrichOptions {
  timeoutMs?: number;
  concurrency?: number;
  userAgent?: string;
}

/**
 * Pure-ish: takes a list of articles and a fetcher (so tests can mock).
 * Returns mutated articles + per-URL outcomes.
 */
export async function enrichArticles(
  articles: InboxArticle[],
  fetcher: (url: string) => Promise<string | null>,
  opts: { concurrency?: number } = {},
): Promise<{ articles: InboxArticle[]; outcomes: EnrichOutcome[] }> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const outcomes: EnrichOutcome[] = [];
  const out = articles.map((a) => ({ ...a }));

  const targets = out
    .map((a, i) => ({ idx: i, article: a }))
    .filter(({ article }) => needsEnrichment(article));

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const job = targets[cursor++];
      const html = await fetcher(job.article.url);
      if (!html) {
        outcomes.push({
          url: job.article.url,
          enriched: false,
          title_updated: false,
          summary_updated: false,
          reason: "fetch_failed",
        });
        continue;
      }
      const meta = extractMetadata(html);
      if (!meta.title && !meta.summary) {
        outcomes.push({
          url: job.article.url,
          enriched: false,
          title_updated: false,
          summary_updated: false,
          reason: "no_metadata_found",
        });
        continue;
      }
      const merged = mergeMetadata(job.article, meta);
      out[job.idx] = merged.article;
      outcomes.push({
        url: job.article.url,
        enriched: merged.titleUpdated || merged.summaryUpdated,
        title_updated: merged.titleUpdated,
        summary_updated: merged.summaryUpdated,
      });
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);

  return { articles: out, outcomes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliFlags {
  in: string;
  timeoutMs: number;
  concurrency: number;
  userAgent: string;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (!flags.in) {
    console.error(
      "Usage: enrich-inbox-articles.ts --in <articles.json> [--timeout-ms N] [--concurrency N] [--user-agent S]",
    );
    process.exit(1);
  }
  return {
    in: flags.in,
    timeoutMs: Number(flags["timeout-ms"] ?? DEFAULT_TIMEOUT_MS),
    concurrency: Number(flags.concurrency ?? DEFAULT_CONCURRENCY),
    userAgent: flags["user-agent"] ?? DEFAULT_USER_AGENT,
  };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const path = resolve(process.cwd(), cli.in);
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);

  // Accept either a bare array or { articles: [] } or a buckets-style object
  // with editor_submitted articles inside.
  let articles: InboxArticle[];
  let writeBack: (enriched: InboxArticle[]) => unknown;

  if (Array.isArray(parsed)) {
    articles = parsed as InboxArticle[];
    writeBack = (e) => e;
  } else if (Array.isArray(parsed?.articles)) {
    articles = parsed.articles as InboxArticle[];
    writeBack = (e) => ({ ...parsed, articles: e });
  } else {
    console.error(
      "enrich-inbox-articles: input JSON must be an array or have an `articles` array",
    );
    process.exit(1);
  }

  const { articles: enriched, outcomes } = await enrichArticles(
    articles,
    (url) => fetchHtml(url, cli.timeoutMs, cli.userAgent),
    { concurrency: cli.concurrency },
  );

  writeFileSync(path, JSON.stringify(writeBack(enriched), null, 2), "utf8");

  const enrichedCount = outcomes.filter((o) => o.enriched).length;
  const failed = outcomes.filter((o) => !o.enriched).length;
  process.stdout.write(
    JSON.stringify(
      {
        in: cli.in,
        considered: outcomes.length,
        enriched: enrichedCount,
        failed,
        outcomes,
      },
      null,
      2,
    ) + "\n",
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((err) => {
    console.error("enrich-inbox-articles error:", err);
    process.exit(1);
  });
}
