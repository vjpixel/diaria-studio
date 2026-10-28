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
import { capArticles, type Article } from "./article-cap.ts";
// #2834: era byte-idêntico ao stripHtml de fetch-rss.ts — consolidado em
// strip-html.ts como stripHtmlBasic.
import { stripHtmlBasic as stripHtml } from "./strip-html.ts";
import { describeFeedHttpFailure } from "./anti-bot-challenge.ts";

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
  title?: string;
  description?: string;
  body_excerpt?: string;
}

export interface SitemapFetchResult {
  source: string;
  method: "sitemap";
  sitemap_url: string;
  articles: Article[];
  error?: string;
  /** #891: mesmo cap que fetch-rss — count de artigos cortados além do máximo. */
  truncated_by_cap?: number;
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
 * #11401: data de publicação embutida no caminho (`/AAAA/MM/DD/`), comum em
 * changelog datado (ex.: `docs.replit.com/updates/2026/10/23/changelog`).
 * Retorna `AAAA-MM-DD` ou `null` se o caminho não tiver data válida.
 */
export function dateFromPath(loc: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(loc).pathname;
  } catch {
    return null;
  }
  const m = pathname.match(/\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/**
 * #11401: data efetiva de publicação de uma entrada. `lastmod` sobe quando a
 * página é reeditada ou retraduzida (no sitemap do docs.replit.com, o
 * changelog de 13/12/2024 tem `lastmod` de abril/2026) — então, se o caminho
 * traz a data, ela manda. `lastmod` só vale quando cai no mesmo dia da data do
 * caminho (é mais preciso que meia-noite) ou quando o caminho não tem data.
 */
export function effectiveDate(entry: SitemapEntry): string | null {
  const pathDate = dateFromPath(entry.loc);
  if (!pathDate) return entry.lastmod;
  if (entry.lastmod && entry.lastmod.slice(0, 10) === pathDate) return entry.lastmod;
  return `${pathDate}T00:00:00.000Z`;
}

/**
 * #11401: mantém só as entradas cujo caminho está sob `pathPrefix` (ex.:
 * `/updates` → `/updates/2026/10/23/changelog`, mas não `/pt/updates/...` nem
 * as páginas de documentação do mesmo sitemap). Prefixo vazio ou `/` → sem
 * filtro. Sem isso um sitemap de site de documentação inteiro (2,5 mil URLs,
 * centenas com `lastmod` recente) entraria como "artigo".
 */
export function filterByPathPrefix(
  entries: SitemapEntry[],
  pathPrefix: string | undefined,
): SitemapEntry[] {
  const prefix = (pathPrefix ?? "").replace(/\/+$/, "");
  if (!prefix) return entries;
  return entries.filter((e) => {
    let pathname: string;
    try {
      pathname = new URL(e.loc).pathname.replace(/\/+$/, "");
    } catch {
      return false;
    }
    return pathname.startsWith(prefix + "/");
  });
}

/**
 * Mantém entradas cuja data efetiva (`effectiveDate`: data do caminho, senão
 * `lastmod`) é >= `now - days*86400000`. Entradas sem data nenhuma são
 * descartadas — sitemap sem lastmod não é útil pra fetch janelado.
 */
export function filterByWindow(
  entries: SitemapEntry[],
  days: number,
  now: Date = new Date(),
): SitemapEntry[] {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return entries.filter((e) => {
    const date = effectiveDate(e);
    if (!date) return false;
    const t = new Date(date).getTime();
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
    published_at: effectiveDate(entry),
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
  /** #11401: só entradas sob este caminho (ver `filterByPathPrefix`). */
  pathPrefix?: string;
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
        error: describeFeedHttpFailure(res),
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

  const inWindow = filterByWindow(filterByPathPrefix(entries, opts.pathPrefix), days, now);
  const enriched = await Promise.all(
    inWindow.map((e) => enrichEntry(e, { timeoutMs })),
  );
  const articles = enriched.map(entryToArticle);
  // #891: cap por source — sitemap pode ter centenas de URLs. Mesmo cap
  // que fetch-rss pra consistência. Articles já vêm filtrados por janela.
  const { capped, truncated } = capArticles(articles);
  if (truncated > 0) {
    console.error(
      `[fetch-sitemap] cap aplicado em ${opts.sourceName}: ${articles.length} → ${capped.length} (${truncated} cortados)`,
    );
  }

  return {
    source: opts.sourceName,
    method: "sitemap",
    sitemap_url: opts.url,
    articles: capped,
    ...(truncated > 0 ? { truncated_by_cap: truncated } : {}),
  };
}
