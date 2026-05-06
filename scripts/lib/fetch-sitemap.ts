/**
 * fetch-sitemap.ts (#761)
 *
 * Helpers puros pra parsear sitemap.xml, filtrar por janela de publicação
 * via `lastmod`, e enriquecer cada entrada com title/description/excerpt
 * via fetch da página.
 *
 * Slot no pipeline: usado pelo `scripts/fetch-sitemap.ts` (CLI) que o
 * orchestrator stage-1 dispatcha quando a coluna RSS de `seed/sources.csv`
 * termina em `sitemap.xml`.
 */

import { XMLParser } from "fast-xml-parser";

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
  title?: string;
  description?: string;
  body_excerpt?: string;
}

export interface Article {
  url: string;
  title: string;
  published_at: string | null;
  summary: string;
}

export interface SitemapFetchResult {
  source: string;
  method: "sitemap";
  sitemap_url: string;
  articles: Article[];
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DAYS = 4;
const USER_AGENT = "DiariaBot/1.0 (+https://diar.ia.br)";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  alwaysCreateTextNode: false,
  trimValues: true,
  parseTagValue: false,
});

function coerceText(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if ("#text" in obj) return coerceText(obj["#text"]);
  }
  return "";
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parseia um sitemap.xml (formato `<urlset><url><loc/><lastmod/></url>...`)
 * e retorna a lista de entradas. Lança Error em XML malformado ou sem `<urlset>`.
 */
export function parseSitemap(xml: string): SitemapEntry[] {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (e) {
    throw new Error(`sitemap XML inválido: ${(e as Error).message}`);
  }
  const root = parsed as Record<string, unknown>;
  const urlset = root.urlset as Record<string, unknown> | undefined;
  if (!urlset) {
    throw new Error("sitemap não tem <urlset> (formato esperado: sitemap.xml)");
  }
  const urls = Array.isArray(urlset.url)
    ? (urlset.url as unknown[])
    : urlset.url
      ? [urlset.url]
      : [];

  const entries: SitemapEntry[] = [];
  for (const u of urls) {
    const obj = u as Record<string, unknown>;
    const loc = coerceText(obj.loc).trim();
    if (!loc) continue;
    const lastmodRaw = coerceText(obj.lastmod).trim();
    entries.push({
      loc,
      lastmod: lastmodRaw || null,
    });
  }
  return entries;
}

/**
 * Mantém entradas cujo `lastmod` é >= `now - days*86400000`.
 * Entradas sem `lastmod` são descartadas — sitemap sem lastmod não é útil
 * pra fetch janelado.
 */
export function filterByWindow(
  entries: SitemapEntry[],
  days: number,
  now: Date = new Date(),
): SitemapEntry[] {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return entries.filter((e) => {
    if (!e.lastmod) return false;
    const t = new Date(e.lastmod).getTime();
    if (Number.isNaN(t)) return false;
    return t >= cutoff;
  });
}

/**
 * Faz fetch da página de uma entrada e extrai title (`<title>` ou og:title),
 * description (meta description ou og:description), e o primeiro `<p>` (≤500 chars).
 * Em falha de rede/timeout, retorna a entrada inalterada (sem enriquecimento).
 */
export async function enrichEntry(
  entry: SitemapEntry,
  opts: { timeoutMs?: number } = {},
): Promise<SitemapEntry> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(entry.loc, {
      headers: { "User-Agent": USER_AGENT },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return entry;
    const html = await res.text();

    const ogTitleMatch = html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    );
    const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = stripHtml(
      ogTitleMatch?.[1] ?? titleTagMatch?.[1] ?? "",
    );

    const ogDescMatch = html.match(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    );
    const metaDescMatch = html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    );
    const description = stripHtml(
      ogDescMatch?.[1] ?? metaDescMatch?.[1] ?? "",
    );

    const pMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const body_excerpt = pMatch ? stripHtml(pMatch[1]).slice(0, 500) : undefined;

    return {
      ...entry,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(body_excerpt ? { body_excerpt } : {}),
    };
  } catch {
    return entry;
  } finally {
    clearTimeout(timer);
  }
}

function entryToArticle(entry: SitemapEntry): Article {
  const title = entry.title ?? "";
  const summary = entry.description ?? entry.body_excerpt ?? "";
  return {
    url: entry.loc,
    title,
    published_at: entry.lastmod,
    summary,
  };
}

/**
 * Orquestra fetch sitemap → parse → filter por janela → enrich → mapeia
 * para o shape `Article` (mesmo do `fetch-rss.ts`).
 */
export async function fetchSitemapEntries(opts: {
  url: string;
  sourceName: string;
  days?: number;
  timeoutMs?: number;
  now?: Date;
}): Promise<SitemapFetchResult> {
  const days = opts.days ?? DEFAULT_DAYS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? new Date();

  // SSRF guard
  try {
    const parsed = new URL(opts.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        source: opts.sourceName,
        method: "sitemap",
        sitemap_url: opts.url,
        articles: [],
        error: `Unsupported URL scheme: ${parsed.protocol} (só http/https aceitos)`,
      };
    }
  } catch {
    return {
      source: opts.sourceName,
      method: "sitemap",
      sitemap_url: opts.url,
      articles: [],
      error: `Invalid URL: ${opts.url}`,
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let xml: string;
  try {
    const res = await fetch(opts.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/xml, text/xml, */*",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      return {
        source: opts.sourceName,
        method: "sitemap",
        sitemap_url: opts.url,
        articles: [],
        error: `HTTP ${res.status}`,
      };
    }
    xml = await res.text();
  } catch (e: unknown) {
    return {
      source: opts.sourceName,
      method: "sitemap",
      sitemap_url: opts.url,
      articles: [],
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }

  let entries: SitemapEntry[];
  try {
    entries = parseSitemap(xml);
  } catch (e) {
    return {
      source: opts.sourceName,
      method: "sitemap",
      sitemap_url: opts.url,
      articles: [],
      error: (e as Error).message,
    };
  }

  const inWindow = filterByWindow(entries, days, now);
  const enriched = await Promise.all(
    inWindow.map((e) => enrichEntry(e, { timeoutMs })),
  );

  return {
    source: opts.sourceName,
    method: "sitemap",
    sitemap_url: opts.url,
    articles: enriched.map(entryToArticle),
  };
}
