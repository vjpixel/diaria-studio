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
import { loadCachedBody } from "./lib/url-body-cache.ts";
import { normalizeItemTitle } from "./lib/strip-publisher-suffix.ts"; // #2140, #2664, #2672
import { sanitizeTrailingEllipsis } from "./lib/sanitize-description-ellipsis.ts"; // #2881

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
  cache_hit?: boolean;
}

export interface EnrichStats {
  cache_hits: number;
  cache_misses: number;
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

/** Submissão do inbox editorial (network-eligible pro fetch de enrichment). */
export function isInboxArticle(article: InboxArticle): boolean {
  return article.flag === "editor_submitted" || article.source === "inbox";
}

function hasPlaceholderTitle(article: InboxArticle): boolean {
  const title = (article.title ?? "").trim();
  return (
    !title ||
    PLACEHOLDER_TITLES.includes(title.toLowerCase()) ||
    /^\[inbox\]/i.test(title) ||
    /^\(inbox/i.test(title)
  );
}

/**
 * Quais artigos precisam de enrichment.
 * - **Inbox** (editor_submitted/source=inbox): título placeholder OU summary
 *   vazio (comportamento original #109).
 * - **Fonte regular** (#1696): título real MAS summary vazio. Itens de seção
 *   secundária (LANÇAMENTOS/RADAR) sem summary renderizam como título pelado
 *   (HF Blog / Nvidia blog às vezes não trazem snippet). Preenche og:description
 *   do body-cache. NÃO toca o título (só inbox tem título placeholder).
 *   Custo barato: o worker enriquece esses SÓ do cache (sem network — ver
 *   `isInboxArticle` gate no loop), e os bodies já foram cacheados no 1i.
 */
export function needsEnrichment(article: InboxArticle): boolean {
  const summary = (article.summary ?? "").trim();
  if (isInboxArticle(article)) {
    return hasPlaceholderTitle(article) || !summary;
  }
  // #1696: fonte regular com título real mas sem summary.
  return !hasPlaceholderTitle(article) && !summary;
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
    // #2881: sources often truncate their OWN meta-description with an
    // ellipsis. That's not our truncation — sanitize before it leaks into
    // the final email as if the sentence had been cut mid-way.
    out.summary = sanitizeTrailingEllipsis(meta.summary);
    summaryUpdated = true;
  }

  return { article: out, titleUpdated, summaryUpdated };
}

/**
 * #1641: fallback de título quando o fetch da página falha. URLs com proteção
 * anti-bot (DeepSeek, VentureBeat) bloqueiam o GET → sem og:title/<title>, o
 * artigo ficaria com placeholder e seria DROPADO na categorização. O editor
 * enviou esse link pelo inbox com um assunto (`submitted_subject`); usamos esse
 * assunto como título em vez de descartar. Retorna o título recuperado, ou null
 * quando não há subject aproveitável (ou o artigo já tem título bom).
 *
 * Pure — exportado pra teste.
 */
export function titleFromSubmittedSubject(article: InboxArticle): string | null {
  if (!needsEnrichment(article)) return null; // título atual já é bom
  let cleaned =
    typeof article.submitted_subject === "string" ? article.submitted_subject.trim() : "";
  // Tira prefixos empilhados em qualquer ordem: "[INBOX] Re: ...", "Fwd: ...".
  const PREFIX_RE = /^\s*(?:\[inbox\]|(?:re|fwd?|enc|res):)\s*/i;
  while (PREFIX_RE.test(cleaned)) cleaned = cleaned.replace(PREFIX_RE, "").trim();
  return cleaned.length > 0 ? cleaned : null;
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
 * #2545: cap de fallback fetches para non-inbox cache-miss. Limita o custo de
 * rede a no máximo N GETs por edição, mesmo que haja muitos cache-misses.
 * Valor conservador: típico é <5 cache-misses por edição (itens secundários que
 * não passaram pelo 1i com body persistido). 10 garante cobertura sem blast.
 */
export const NON_INBOX_FALLBACK_FETCH_CAP = 10;

/**
 * Pure-ish: takes a list of articles and a fetcher (so tests can mock).
 * Returns mutated articles + per-URL outcomes.
 *
 * `bodiesDir` (#717 hyp 7): when set, the worker reads the HTML from the
 * intra-edição body cache populated by `verify-accessibility.ts` before
 * falling back to the network fetcher. The same URL was already fetched in
 * step 1i, so the cache hit eliminates a duplicate GET. Disabled when null.
 *
 * `nonInboxFallbackFetchCap` (#2545): cap de fallback fetches para non-inbox
 * com summary vazio e cache-miss. Default = NON_INBOX_FALLBACK_FETCH_CAP.
 * Bounded: tipicamente <5/edição — evita blast em caso de cache frio.
 */
export async function enrichArticles(
  articles: InboxArticle[],
  fetcher: (url: string) => Promise<string | null>,
  opts: { concurrency?: number; bodiesDir?: string | null; nonInboxFallbackFetchCap?: number } = {},
): Promise<{ articles: InboxArticle[]; outcomes: EnrichOutcome[]; stats: EnrichStats }> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const bodiesDir = opts.bodiesDir ?? null;
  const fallbackCap = opts.nonInboxFallbackFetchCap ?? NON_INBOX_FALLBACK_FETCH_CAP;
  const outcomes: EnrichOutcome[] = [];
  const stats: EnrichStats = { cache_hits: 0, cache_misses: 0 };
  const out = articles.map((a) => ({ ...a }));

  const targets = out
    .map((a, i) => ({ idx: i, article: a }))
    .filter(({ article }) => needsEnrichment(article));

  let cursor = 0;
  // #2545: contador compartilhado de fallback fetches para non-inbox. Protegido
  // por event-loop (JavaScript single-threaded) — sem race entre workers.
  let nonInboxFallbackFetchCount = 0;

  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const job = targets[cursor++];
      let html: string | null = null;
      let cacheHit = false;
      if (bodiesDir !== null) {
        const cached = loadCachedBody(bodiesDir, job.article.url);
        if (cached !== null) {
          html = cached;
          cacheHit = true;
          stats.cache_hits++;
        } else {
          stats.cache_misses++;
        }
      }
      // Inbox: sempre faz network fetch em cache-miss (comportamento original #109).
      // Non-inbox: #2545 — fallback bounded (cap) para artigos secundários sem summary
      // que tiveram cache-miss. Custo limitado: só os cache-misses (tipicamente <5/edição)
      // e apenas até o cap (NON_INBOX_FALLBACK_FETCH_CAP). Antes (#1696) era cache-only
      // e summary ficava vazio silenciosamente; agora tenta 1 GET curto pra og:description.
      if (html === null) {
        if (isInboxArticle(job.article)) {
          html = await fetcher(job.article.url);
        } else if (nonInboxFallbackFetchCount < fallbackCap) {
          // #2545: fallback bounded para non-inbox
          nonInboxFallbackFetchCount++;
          html = await fetcher(job.article.url);
        }
      }
      if (!html) {
        // Non-inbox cache-only sem fallback (cap esgotado ou bodiesDir nulo):
        // registra o skip (summary fica vazio — será detectado pelo lint
        // secondary-items-have-summary no Stage 4).
        if (!isInboxArticle(job.article)) {
          const capExhausted = nonInboxFallbackFetchCount >= fallbackCap;
          outcomes.push({
            url: job.article.url,
            enriched: false,
            title_updated: false,
            summary_updated: false,
            reason: capExhausted ? "cache_miss_cap_exhausted_non_inbox" : "cache_miss_skipped_non_inbox",
            ...(bodiesDir !== null ? { cache_hit: false } : {}),
          });
          continue;
        }
        // #1641: fetch falhou (anti-bot) — recupera o título do submitted_subject
        // antes de desistir, evitando o drop na categorização.
        const recovered = titleFromSubmittedSubject(job.article);
        if (recovered) {
          out[job.idx] = { ...job.article, title: recovered };
          outcomes.push({
            url: job.article.url,
            enriched: true,
            title_updated: true,
            summary_updated: false,
            reason: "title_from_submitted_subject",
          });
        } else {
          outcomes.push({
            url: job.article.url,
            enriched: false,
            title_updated: false,
            summary_updated: false,
            reason: "fetch_failed",
          });
        }
        continue;
      }
      const meta = extractMetadata(html);
      if (!meta.title && !meta.summary) {
        // #1641: página acessível mas sem metadata extraível — mesmo fallback.
        const recovered = titleFromSubmittedSubject(job.article);
        if (recovered) {
          out[job.idx] = { ...job.article, title: recovered };
          outcomes.push({
            url: job.article.url,
            enriched: true,
            title_updated: true,
            summary_updated: false,
            reason: "title_from_submitted_subject",
            ...(cacheHit ? { cache_hit: true } : {}),
          });
        } else {
          outcomes.push({
            url: job.article.url,
            enriched: false,
            title_updated: false,
            summary_updated: false,
            reason: "no_metadata_found",
            ...(cacheHit ? { cache_hit: true } : {}),
          });
        }
        continue;
      }
      const merged = mergeMetadata(job.article, meta);
      // #1641: metadata veio só com summary (sem title) e o título seguiu
      // placeholder — recupera do submitted_subject pra não dropar na categorização.
      if (!merged.titleUpdated && needsEnrichment(merged.article)) {
        const recovered = titleFromSubmittedSubject(merged.article);
        if (recovered) merged.article.title = recovered;
      }
      // #2140, #2664, #2672: normalização de título — aplicado AQUI (dentro do worker),
      // SOMENTE em artigos de imprensa (não-inbox). Títulos editoriais/inbox
      // (curados pelo editor ou recuperados de submitted_subject) são preservados.
      // Aplica: strip de sufixo de veículo (` | `, ` - `, ` — `) + strip de ponto final.
      // Aplicar antes de gravar em `out` para que `title_updated` reflita o estado
      // final correto, sem a obsolescência que existia no passo pós-loop.
      if (!isInboxArticle(job.article) && typeof merged.article.title === "string") {
        merged.article.title = normalizeItemTitle(merged.article.title);
      }
      out[job.idx] = merged.article;
      const titleUpdated =
        merged.titleUpdated ||
        (out[job.idx].title !== job.article.title &&
          typeof out[job.idx].title === "string");
      outcomes.push({
        url: job.article.url,
        enriched: titleUpdated || merged.summaryUpdated,
        title_updated: titleUpdated,
        summary_updated: merged.summaryUpdated,
        ...(cacheHit ? { cache_hit: true } : {}),
      });
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);

  // #2140, #2664, #2672: normalização de título nos artigos NÃO processados pelo
  // worker (needsEnrichment=false — ex: artigos RSS com título real + summary já
  // preenchido). Estes não passaram pelo loop acima, então a normalização ainda
  // não foi aplicada. Normaliza: sufixo de veículo (` | `, ` - `, ` — `) + ponto final.
  //
  // ESCOPO INTENCIONAL: iteramos sobre `out` completo (não só `targets`) para
  // cobrir artigos de imprensa que foram pulados por já terem título + summary
  // (needsEnrichment=false). Um futuro mantedor que restrinja ao `targets` quebraria
  // silenciosamente a cobertura desses artigos RSS — daí o loop sobre `out`.
  //
  // GATE DE ORIGEM: títulos editoriais (inbox / editor_submitted / submitted_subject)
  // NUNCA são normalizados — o invariante "NÃO toca o título" de mergeMetadata é
  // respeitado aqui também. Só artigos de imprensa (fontes regulares, RSS, discovery)
  // passam pela normalização.
  // Passagem final de normalização sobre TODO o `out`. Cobre os casos que o
  // worker NÃO normaliza:
  //   (a) artigos não-target (needsEnrichment=false — ex: RSS já com título +
  //       summary), que nunca entraram no worker;
  //   (b) #2664/#2672 follow-up: targets que SAÍRAM do worker por `continue`
  //       precoce (fetch anti-bot falhou ou página sem metadata extraível) ANTES
  //       da normalização interna (linha ~425). Nesses casos `out[idx].title`
  //       ainda é o título cru do RSS/feed — exatamente onde vivem o sufixo de
  //       veículo (` - Canaltech`) e o ponto final que #2664/#2672 removem. E
  //       fetch anti-bot falha JUSTAMENTE em sites tipo Canaltech, então não é
  //       hipotético.
  // `normalizeItemTitle` é idempotente + @pure: targets já normalizados pelo
  // worker dão no-op aqui (`normalized === title`), sem dupla normalização nem
  // outcome duplicado.
  // GATE DE ORIGEM: títulos editoriais (inbox / editor_submitted / recuperados
  // de submitted_subject) NUNCA são normalizados.
  const targetIdxSet = new Set(targets.map((t) => t.idx));
  for (let i = 0; i < out.length; i++) {
    const article = out[i];
    // Pula artigos editoriais — nunca normalizar títulos curados pelo editor.
    if (isInboxArticle(article)) continue;
    if (typeof article.title !== "string" || !article.title) continue;
    const normalized = normalizeItemTitle(article.title);
    if (normalized === article.title) continue; // já normalizado (worker) ou sem mudança
    article.title = normalized;
    if (targetIdxSet.has(i)) {
      // Target que saiu por `continue` precoce no worker (fetch-fail / sem
      // metadata): o título cru é corrigido AQUI. NÃO empurra outcome novo — o
      // artigo já tem um outcome do worker (ex: fetch_failed / cache_miss_*);
      // só garantimos o título final limpo, sem inflar a contagem de outcomes.
      continue;
    }
    outcomes.push({
      url: article.url,
      enriched: true,
      title_updated: true,
      summary_updated: false,
      reason: "normalize_item_title",
    });
  }

  return { articles: out, outcomes, stats };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliFlags {
  in: string;
  timeoutMs: number;
  concurrency: number;
  userAgent: string;
  bodiesDir: string | null;
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
      "Usage: enrich-inbox-articles.ts --in <articles.json> [--timeout-ms N] [--concurrency N] [--user-agent S] [--bodies-dir <path>]",
    );
    process.exit(1);
  }
  return {
    in: flags.in,
    timeoutMs: Number(flags["timeout-ms"] ?? DEFAULT_TIMEOUT_MS),
    concurrency: Number(flags.concurrency ?? DEFAULT_CONCURRENCY),
    userAgent: flags["user-agent"] ?? DEFAULT_USER_AGENT,
    bodiesDir: flags["bodies-dir"] ?? null,
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

  const { articles: enriched, outcomes, stats } = await enrichArticles(
    articles,
    (url) => fetchHtml(url, cli.timeoutMs, cli.userAgent),
    { concurrency: cli.concurrency, bodiesDir: cli.bodiesDir },
  );

  writeFileSync(path, JSON.stringify(writeBack(enriched), null, 2), "utf8");

  const enrichedCount = outcomes.filter((o) => o.enriched).length;
  const failed = outcomes.filter((o) => !o.enriched).length;

  if (cli.bodiesDir !== null) {
    const total = stats.cache_hits + stats.cache_misses;
    const hitPct = total > 0 ? Math.round((stats.cache_hits / total) * 100) : 0;
    console.error(
      `[enrich] body-cache: ${stats.cache_hits}/${total} hit (${hitPct}%) — fetches evitados`,
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        in: cli.in,
        considered: outcomes.length,
        enriched: enrichedCount,
        failed,
        cache_hits: stats.cache_hits,
        cache_misses: stats.cache_misses,
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
