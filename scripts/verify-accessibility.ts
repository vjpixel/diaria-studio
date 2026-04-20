import { readFileSync, writeFileSync } from "node:fs";
import { request } from "undici";

const PAYWALL_DOMAINS = new Set([
  "fortune.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "nytimes.com",
  "theinformation.com",
  "businessinsider.com",
  "economist.com",
]);

// Sites que redistribuem conteúdo de terceiros sem produção editorial própria.
// news.google.com NÃO está aqui — é indexador que aponta para o original.
// Quando um desses domínios aparece, o verificador tenta resolver a fonte primária
// antes de descartar. Se não conseguir, verdict = "aggregator".
const AGGREGATOR_DOMAINS = new Set([
  "crescendo.ai",
  "techstartups.com",
  "flipboard.com",
  "alltop.com",
  "feedly.com",
  "inoreader.com",
  "thedeepview.com",
]);

// Domínios de redes sociais — ignorados na busca por fonte primária.
const SOCIAL_DOMAINS = new Set([
  "twitter.com",
  "x.com",
  "facebook.com",
  "linkedin.com",
  "instagram.com",
  "youtube.com",
  "t.co",
]);

// Prefixos de URL que são fontes primárias dentro de domínios parcialmente
// agregadores. Verificados ANTES de checar AGGREGATOR_DOMAINS.
const PRIMARY_SOURCE_PREFIXES = [
  "perplexity.ai/hub/",
  "research.perplexity.ai",
  // perplexity.ai/* (outros paths) continua sendo tratado como agregador abaixo
];

const PAYWALL_MARKERS = [
  "subscribe to continue",
  "subscribers only",
  "subscribe now",
  "sign in to read",
  "premium content",
  "this article is for subscribers",
  "assinantes",
  "conteúdo exclusivo para assinantes",
];

type Verdict = "accessible" | "paywall" | "blocked" | "aggregator" | "uncertain";

type VerifyResult = {
  verdict: Verdict;
  finalUrl: string;
  note?: string;
  resolvedFrom?: string; // set when an aggregator URL was resolved to its primary source
};

export function canonicalize(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "ref" || key === "ref_src") u.searchParams.delete(key);
    }
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    if (u.hostname === "arxiv.org" && u.pathname.startsWith("/pdf/")) {
      u.pathname = u.pathname.replace(/^\/pdf\//, "/abs/").replace(/\.pdf$/, "");
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Tenta extrair a URL da fonte primária de uma página agregadora.
 * Estratégia em ordem de confiança:
 *   1. <meta property="og:url"> apontando para domínio diferente
 *   2. <link rel="canonical"> apontando para domínio diferente
 *   3. Primeiro link externo relevante dentro de <article> ou <main>
 * Retorna null se não encontrar fonte primária confiável.
 */
async function resolveAggregator(url: string, aggregatorHost: string, timeoutMs: number): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await request(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; DiariaBot/1.0)" },
    });
    if (res.statusCode >= 400) return null;

    const body = await res.body.text();

    // 1. og:url
    const ogUrl =
      body.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i)?.[1];
    if (ogUrl) {
      const h = domain(ogUrl);
      if (h && h !== aggregatorHost && !SOCIAL_DOMAINS.has(h)) return canonicalize(ogUrl);
    }

    // 2. canonical
    const canonical =
      body.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ??
      body.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)?.[1];
    if (canonical) {
      const h = domain(canonical);
      if (h && h !== aggregatorHost && !SOCIAL_DOMAINS.has(h)) return canonicalize(canonical);
    }

    // 3. Primeiro link externo em <article> ou <main>
    const contentArea =
      body.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
      body.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
      body;

    const externalLinks = [...contentArea.matchAll(/href=["'](https?:\/\/[^"'#?]+)["']/gi)]
      .map((m) => m[1])
      .filter((href) => {
        const h = domain(href);
        return h && h !== aggregatorHost && !SOCIAL_DOMAINS.has(h);
      });

    if (externalLinks.length > 0) return canonicalize(externalLinks[0]);

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function verify(url: string, timeoutMs = 8000, isRetry = false): Promise<VerifyResult> {
  const finalUrl = canonicalize(url);
  const host = domain(finalUrl);

  // Primary-source prefixes override aggregator domain rules.
  const urlWithoutProtocol = finalUrl.replace(/^https?:\/\//, "");
  const isPrimarySource = PRIMARY_SOURCE_PREFIXES.some((prefix) => urlWithoutProtocol.startsWith(prefix));

  if (!isPrimarySource) {
    if (host === "perplexity.ai" || AGGREGATOR_DOMAINS.has(host)) {
      // Attempt to resolve to the primary source (first call only — no infinite recursion).
      if (!isRetry) {
        const primary = await resolveAggregator(finalUrl, host, timeoutMs);
        if (primary) {
          const primaryResult = await verify(primary, timeoutMs, true);
          if (primaryResult.verdict !== "aggregator") {
            return { ...primaryResult, resolvedFrom: finalUrl };
          }
        }
      }
      return { verdict: "aggregator", finalUrl };
    }
  }

  if (PAYWALL_DOMAINS.has(host)) return { verdict: "paywall", finalUrl, note: "known-paywall domain" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const head = await request(finalUrl, { method: "HEAD", signal: ctrl.signal });
    if (head.statusCode >= 400) return { verdict: "blocked", finalUrl, note: `HEAD ${head.statusCode}` };

    const get = await request(finalUrl, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; DiariaBot/1.0)" },
    });
    if (get.statusCode >= 400) return { verdict: "blocked", finalUrl, note: `GET ${get.statusCode}` };

    const body = (await get.body.text()).slice(0, 50_000).toLowerCase();
    for (const marker of PAYWALL_MARKERS) {
      if (body.includes(marker)) return { verdict: "paywall", finalUrl, note: `marker: ${marker}` };
    }
    if (body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").length < 500) {
      return { verdict: "uncertain", finalUrl, note: "body < 500 chars" };
    }
    return { verdict: "accessible", finalUrl };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { verdict: "blocked", finalUrl, note: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: verify-accessibility.ts <urls.json | url1,url2,...>");
    process.exit(1);
  }

  let urls: string[];
  if (input.endsWith(".json")) {
    const raw = readFileSync(input, "utf8");
    urls = JSON.parse(raw);
  } else {
    urls = input.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const results = await Promise.all(urls.map(async (url) => ({ url, ...(await verify(url)) })));

  const out = process.argv[3];
  if (out) {
    writeFileSync(out, JSON.stringify(results, null, 2), "utf8");
    console.log(`Wrote ${results.length} results to ${out}`);
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  main();
}
