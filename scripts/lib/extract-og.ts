/**
 * extract-og.ts (#1559 part B)
 *
 * Extrai Open Graph metadata (title, description, published_time) de HTML body.
 * Usado por fetch-websearch-batch.ts pra enriquecer artigos do Brave Search
 * com title/summary de melhor qualidade que o snippet do search engine.
 *
 * Trade-off: ~5s extra por query (3-5 fetches paralelos) — total ~15s a mais
 * na pipeline. Ainda 8× mais rápido que agents Haiku.
 *
 * Fetcher injectable (fetchFn) pra testes.
 */

export interface OgMetadata {
  title: string | null;
  description: string | null;
  publishedTime: string | null;
}

/**
 * Pure: extrai og:title, og:description, og:article:published_time de HTML.
 * Fallback pra <title> e <meta name="description"> quando OG ausente.
 *
 * Retorna `{ title: null, description: null, publishedTime: null }` quando
 * body é inválido. Caller decide fallback.
 */
export function extractOgFromBody(body: string): OgMetadata {
  try {
    // og:title primeiro, <title> como fallback
    const ogTitle =
      body.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1] ??
      body.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ??
      null;

    // og:description primeiro, <meta name="description"> como fallback
    const ogDescription =
      body.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1] ??
      body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1] ??
      null;

    // og:article:published_time (mais comum em editorial sites)
    const publishedTime =
      body.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i)?.[1] ??
      null;

    return {
      title: ogTitle ? decodeEntities(ogTitle.trim()) : null,
      description: ogDescription ? decodeEntities(ogDescription.trim()) : null,
      publishedTime: publishedTime ? publishedTime.trim() : null,
    };
  } catch {
    return { title: null, description: null, publishedTime: null };
  }
}

/**
 * Pure: decode HTML entities comuns em title/description scraping.
 * Cobre &amp;, &quot;, &#39;, &lt;, &gt;, &nbsp;, &mdash;, &ndash;, &hellip;
 * + numeric entities (&#NNN;).
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Fetch URL + extract OG metadata. Retorna null em qualquer erro
 * (network, timeout, 4xx/5xx, body inválido). Caller usa snippet original
 * como fallback.
 */
export async function fetchOgMetadata(
  url: string,
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<OgMetadata | null> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const fetchFn = opts.fetchFn ?? fetch;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      method: "GET",
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
    });

    if (res.status >= 400) return null;
    const body = await res.text();
    return extractOgFromBody(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
