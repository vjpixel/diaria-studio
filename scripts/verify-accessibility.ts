import { readFileSync, writeFileSync } from "node:fs";
import { request } from "undici";
import puppeteer, { type Browser } from "puppeteer";
import { CONFIG } from "./lib/config.ts";
import { canonicalize, extractHost } from "./lib/url-utils.ts";
import { logEvent } from "./lib/run-log.ts";
import { loadCachedBody, saveCachedBody } from "./lib/url-body-cache.ts";
import {
  loadCache as loadVerifyCache,
  saveCache as saveVerifyCache,
  getCached as getVerifyCached,
  setCached as setVerifyCached,
  isCacheableVerdict,
  DEFAULT_TTL_MS,
  MAX_CACHED_BODY_SIZE,
} from "./lib/url-verify-cache.ts";
import type { VerifyOptions } from "./lib/verify-options.ts";

// #717 hypothesis #3: concorrência do browser fallback. Default 4 — Puppeteer
// roda múltiplas tabs no mesmo browser sem problema; serial era ~7-8s/url ×
// 200+ urls = grande parte dos 22min do verify em 260506. Set via
// --browser-concurrency N.
const DEFAULT_BROWSER_CONCURRENCY = 4;

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

// Domínios que retornam anti-bot em crawlers mas são acessíveis a usuários humanos.
// Quando esses sites retornam 403/bloqueio, o verdict vira `anti_bot` em vez de
// `blocked`, e o artigo permanece no pool com flag `access_uncertain` (#320).
const TRUSTED_PUBLISHERS = new Set([
  "anthropic.com",
  "openai.com",
  "venturebeat.com",
  "techcrunch.com",
  "theverge.com",
  "reuters.com",
  "wired.com",
  "ai.meta.com",
  "blog.google",
  "deepmind.google",
  "deepmind.com",
  "microsoft.com",
  "blogs.microsoft.com",
  "blogs.nvidia.com",
]);

// URL shorteners e redirecionadores que devem ter a URL final propagada (#317).
// Qualquer redirect cross-origin é capturado, mas esses são os mais frequentes
// nas submissões inbox do editor.
const SHORTENER_HOSTS = new Set([
  "share.google",
  "bit.ly",
  "t.co",
  "lnkd.in",
  "tinyurl.com",
  "ow.ly",
  "buff.ly",
  "dlvr.it",
]);

function isShortener(host: string): boolean {
  return SHORTENER_HOSTS.has(host) || host === "share.google";
}

// Sites que redistribuem conteúdo de terceiros sem produção editorial própria.
// news.google.com NÃO está aqui — é indexador que aponta para o original.
// Quando um desses domínios aparece, o verificador tenta resolver a fonte primária
// antes de descartar. Se não conseguir, verdict = "aggregator".
// Note: thedeepview.com foi removido daqui — é newsletter editorial com conteúdo
// próprio (listada como Secundária em sources.csv). Manter aqui fazia o resolver
// tentar achar "fonte primária" em og:url/canonical, que apontam de volta pra eles
// mesmos — resultado: verdict virava "aggregator" e artigos eram descartados.
const AGGREGATOR_DOMAINS = new Set([
  "crescendo.ai",
  "techstartups.com",
  "flipboard.com",
  "alltop.com",
  "feedly.com",
  "inoreader.com",
  "perplexity.ai",
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

/**
 * Detecta URLs de vídeo (YouTube, Vimeo) que devem receber verdict `video`
 * em vez de `aggregator` ou `blocked`. URLs de vídeo são conteúdo primário,
 * não agregadores — precisam de tratamento especial (#359).
 */
function isVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return true;
    if (host === "youtube.com" && u.pathname.startsWith("/watch")) return true;
    if (host === "vimeo.com") return true;
    return false;
  } catch {
    return false;
  }
}

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

type Verdict = "accessible" | "paywall" | "blocked" | "aggregator" | "uncertain" | "anti_bot" | "video";

type VerifyResult = {
  verdict: Verdict;
  finalUrl: string;
  note?: string;
  resolvedFrom?: string; // set when an aggregator URL was resolved to its primary source
  access_uncertain?: boolean; // true para anti_bot em publisher confiável (#320)
  /**
   * Sinaliza se este resultado veio do cache cross-edition (#717 hyp 2)
   * ou do path normal (HEAD/GET). Usado por `main()` pra acumular
   * estatísticas de cache. Undefined quando cache não foi configurado
   * (`opts.verifyCache` ausente). Não afeta consumers downstream — é
   * descartado no output JSON pelo serializer (cache hint é interno).
   */
  _cacheHit?: boolean;
};

export { canonicalize };

export function domain(url: string): string {
  return extractHost(url) ?? "";
}

/**
 * Classifica um HTTP status code retornado por HEAD/GET (#696).
 * Extraída de `verify()` para permitir teste unitário sem mockar undici.
 *
 * Retorna o verdict adequado ou `null` se o status não indica erro (< 400).
 */
export function classifyHttpStatus(
  statusCode: number,
  host: string,
  method: "HEAD" | "GET",
): Pick<VerifyResult, "verdict" | "note" | "access_uncertain"> | null {
  if (statusCode < 400) return null;
  // #696: 429 = rate limiting transient — tratar como anti_bot em qualquer domínio
  if (statusCode === 429) {
    return { verdict: "anti_bot", note: `${method} 429 (rate limited)`, access_uncertain: true };
  }
  // #320: 403 em publisher confiável = provável anti-bot
  if (statusCode === 403 && TRUSTED_PUBLISHERS.has(host)) {
    return { verdict: "anti_bot", note: `${method} 403 (trusted publisher)`, access_uncertain: true };
  }
  return { verdict: "blocked", note: `${method} ${statusCode}` };
}

/**
 * Detecta soft 404 pelo conteúdo do elemento <title> (#695).
 * Retorna o título capturado se indicar "não encontrado", null caso contrário.
 * Limitar a detecção ao <title> evita falsos positivos em artigos que
 * mencionam "404" no conteúdo (ex: "Como resolvi o erro 404 no nginx").
 */
export function detectSoft404Title(body: string): string | null {
  const titleMatch = body.match(/<title[^>]*>([^<]{1,200})<\/title>/);
  if (!titleMatch) return null;
  const title = titleMatch[1].toLowerCase();
  if (/\b(404|not found|not exist|página não encontrada|artigo não encontrado|conteúdo não encontrado|page not found|no such page)\b/.test(title)) {
    return titleMatch[1].trim();
  }
  return null;
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

/**
 * Segue redirects HTTP via fetch nativo (Node 18+, redirect:'follow') e retorna
 * a URL final. Para shorteners e redirects cross-origin, captura o destino pra
 * popular `resolvedFrom` (#317).
 */
async function followRedirects(url: string, timeoutMs: number): Promise<{ finalUrl: string; redirected: boolean }> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const finalUrl = canonicalize(res.url || url);
    const redirected = finalUrl !== canonicalize(url);
    return { finalUrl, redirected };
  } catch {
    return { finalUrl: canonicalize(url), redirected: false };
  }
}

/**
 * Verify a single URL. Threaded `opts` carries cache config; counters
 * are returned in `_cacheHit` field on the result, accumulated by main().
 *
 * Note: `isRetry` is internal recursion state (set when called from
 * aggregator resolution), separate from `opts` since it's not a user-
 * controllable knob. Stays as a positional second arg.
 *
 * #836 change: cache lookup no longer guarded by `!isRetry` — recursive
 * primary URLs from aggregator resolution can also benefit from cache
 * hits. Aggregator verdicts are never cached, so no risk of returning
 * stale aggregator data via the cache path.
 */
export async function verify(
  url: string,
  opts: VerifyOptions = {},
  isRetry = false,
  browser?: Browser | null,
): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? CONFIG.timeouts.verify;
  const verifyCache = opts.verifyCache ?? null;
  const verifyCacheTtlMs = opts.verifyCacheTtlMs ?? DEFAULT_TTL_MS;
  const bodiesDir = opts.bodiesDir ?? null;

  let effectiveUrl = canonicalize(url);
  let host = domain(effectiveUrl);
  let resolvedFrom: string | undefined;

  // #717 hypothesis #2: cross-edition cache lookup ANTES de qualquer fetch.
  // Cache key = canonical URL. Hit → short-circuit com verdict cacheado.
  // Skipa video/shortener/aggregator/paywall/HEAD/GET — todos os caminhos.
  // #836: !isRetry guard removed — recursive primary URLs benefit from cache.
  if (verifyCache !== null) {
    const cached = getVerifyCached(verifyCache, effectiveUrl, verifyCacheTtlMs);
    if (cached !== null) {
      return {
        verdict: cached.verdict,
        finalUrl: cached.finalUrl ?? effectiveUrl,
        ...(cached.note ? { note: cached.note } : {}),
        _cacheHit: true,
      };
    }
  }

  // ---- Vídeos: YouTube e Vimeo recebem verdict `video` (#359) ----------------
  // Verificado ANTES de shorteners/aggregators para evitar que URLs de vídeo
  // sejam tratadas como redes sociais bloqueadas ou agregadores.
  if (isVideoUrl(effectiveUrl)) {
    return { verdict: "video", finalUrl: effectiveUrl };
  }

  // ---- Resolve shorteners e redirects cross-origin (#317) ----------------
  if (isShortener(host)) {
    const { finalUrl, redirected } = await followRedirects(effectiveUrl, Math.min(timeoutMs, 5000));
    const finalHost = domain(finalUrl);
    if (redirected && finalHost !== host) {
      resolvedFrom = effectiveUrl;
      effectiveUrl = finalUrl;
      host = finalHost;
    }
  }

  // Primary-source prefixes override aggregator domain rules.
  const urlWithoutProtocol = effectiveUrl.replace(/^https?:\/\//, "");
  const isPrimarySource = PRIMARY_SOURCE_PREFIXES.some((prefix) => urlWithoutProtocol.startsWith(prefix));

  if (!isPrimarySource) {
    if (AGGREGATOR_DOMAINS.has(host)) {
      // Attempt to resolve to the primary source (first call only — no infinite recursion).
      if (!isRetry) {
        const primary = await resolveAggregator(effectiveUrl, host, timeoutMs);
        if (primary) {
          const primaryResult = await verify(primary, opts, true);
          if (primaryResult.verdict !== "aggregator") {
            return { ...primaryResult, resolvedFrom: resolvedFrom ?? effectiveUrl };
          }
        }
      }
      return { verdict: "aggregator", finalUrl: effectiveUrl, ...(resolvedFrom ? { resolvedFrom } : {}) };
    }
  }

  if (PAYWALL_DOMAINS.has(host)) return { verdict: "paywall", finalUrl: effectiveUrl, note: "known-paywall domain", ...(resolvedFrom ? { resolvedFrom } : {}) };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const head = await request(effectiveUrl, { method: "HEAD", signal: ctrl.signal });
    if (head.statusCode >= 400) {
      const r = classifyHttpStatus(head.statusCode, host, "HEAD");
      if (r) return { ...r, finalUrl: effectiveUrl, ...(resolvedFrom ? { resolvedFrom } : {}) };
    }

    const get = await request(effectiveUrl, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; DiariaBot/1.0)" },
    });
    if (get.statusCode >= 400) {
      const r = classifyHttpStatus(get.statusCode, host, "GET");
      if (r) return { ...r, finalUrl: effectiveUrl, ...(resolvedFrom ? { resolvedFrom } : {}) };
    }

    // #717 hypothesis #1: persistir body raw pra verify-dates não re-fetchar.
    // Lê raw primeiro, depois deriva versão truncada/lowercase pros checks.
    const rawBody = await get.body.text();
    saveCachedBody(bodiesDir, effectiveUrl, rawBody);
    const body = rawBody.slice(0, 50_000).toLowerCase();
    for (const marker of PAYWALL_MARKERS) {
      if (body.includes(marker)) return { verdict: "paywall", finalUrl: effectiveUrl, note: `marker: ${marker}`, ...(resolvedFrom ? { resolvedFrom } : {}) };
    }
    if (body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").length < 500) {
      if (browser) return { ...(await verifyWithBrowser(url, browser)), ...(resolvedFrom ? { resolvedFrom } : {}) };
      return { verdict: "uncertain", finalUrl: effectiveUrl, note: "body < 500 chars", ...(resolvedFrom ? { resolvedFrom } : {}) };
    }
    // #695: soft 404 via título — página retorna 200 mas <title> indica não encontrado
    const soft404Title = detectSoft404Title(body);
    if (soft404Title) {
      return { verdict: "uncertain", finalUrl: effectiveUrl, note: `possível soft 404 (title: "${soft404Title}")`, ...(resolvedFrom ? { resolvedFrom } : {}) };
    }
    return { verdict: "accessible", finalUrl: effectiveUrl, ...(resolvedFrom ? { resolvedFrom } : {}) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Timeout/connection error em publisher confiável = provável anti-bot (#320)
    if (TRUSTED_PUBLISHERS.has(host) && (msg.includes("abort") || msg.includes("timeout") || msg.includes("ECONNREFUSED"))) {
      return { verdict: "anti_bot", finalUrl: effectiveUrl, note: `fetch error: ${msg}`, access_uncertain: true, ...(resolvedFrom ? { resolvedFrom } : {}) };
    }
    return { verdict: "blocked", finalUrl: effectiveUrl, note: msg, ...(resolvedFrom ? { resolvedFrom } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fallback via Puppeteer para sites JS-heavy que retornam body < 500 chars
 * com fetch HTTP puro. Renderiza a página com um browser real e re-avalia.
 */
/**
 * Bounded worker pool — processa indices em paralelo com no máximo
 * `concurrency` workers ativos. Cada worker pega o próximo índice via
 * cursor compartilhado; resultados gravados in-place em ordem original.
 *
 * Usado pra paralelizar o second-pass de browser fallback (#717 hyp 3) sem
 * mudar a ordem do array de results.
 */
export async function runBounded<T>(
  indices: number[],
  concurrency: number,
  task: (idx: number) => Promise<T>,
): Promise<void> {
  const safe = Math.max(1, concurrency);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < indices.length) {
      const i = cursor++;
      await task(indices[i]);
    }
  }
  await Promise.all(Array.from({ length: safe }, () => worker()));
}

async function verifyWithBrowser(
  url: string,
  browser: Browser,
  timeoutMs = 20000
): Promise<VerifyResult> {
  const finalUrl = canonicalize(url);
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    // Stealth evasions: hide WebDriver flag and mock chrome runtime
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // Mock window.chrome for anti-bot checks — globalThis avoids `window` type issues in Node context
      (globalThis as Record<string, unknown>).chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    });
    await page.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    // #844: aguardar network idle (até 2s parado, máximo 5s) em vez de 5s
    // fixos. Páginas que hidratam rápido saem cedo; pesadas continuam até
    // o teto. Páginas que nunca ficam idle (tracking pixels, websockets
    // persistentes) caem no timeout interno e seguem normalmente.
    try {
      await page.waitForNetworkIdle({ idleTime: 2000, timeout: 5000 });
    } catch {
      // Timeout é esperado em sites com tracking persistente — proceder
      // com whatever the page rendered up to this point.
    }

    const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
    for (const marker of PAYWALL_MARKERS) {
      if (bodyText.toLowerCase().includes(marker)) {
        return { verdict: "paywall", finalUrl, note: `browser marker: ${marker}` };
      }
    }
    if (bodyText.replace(/\s+/g, " ").trim().length < 500) {
      return { verdict: "uncertain", finalUrl, note: "browser body < 500 chars" };
    }
    return { verdict: "accessible", finalUrl, note: "browser fallback" };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { verdict: "uncertain", finalUrl, note: `browser error: ${msg}` };
  } finally {
    await page?.close().catch(() => {});
  }
}

async function main() {
  // CLI shape preservada: positional <urls.json> [out.json], + flags opcionais
  // --bodies-dir <path>             (#717 hyp 1) — intra-edição body cache
  // --cache <path>                  (#717 hyp 2) — cross-edition verdict cache
  // --cache-ttl-days <N>            (#717 hyp 2) — TTL override (default 7)
  // --browser-concurrency <N>       (#717 hyp 3) — paralelismo do fallback Puppeteer (default 4)
  //
  // #836: módulo-level vars eliminadas. Toda configuração vive em locals
  // de main() ou na VerifyOptions threaded por chamada de verify().
  let bodiesCacheDir: string | null = null;
  let verifyCachePath: string | null = null;
  let verifyCacheTtlMs: number = DEFAULT_TTL_MS;
  let browserConcurrency = DEFAULT_BROWSER_CONCURRENCY;
  const positional: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--bodies-dir" && i + 1 < process.argv.length) {
      bodiesCacheDir = process.argv[i + 1];
      i++;
    } else if (a === "--cache" && i + 1 < process.argv.length) {
      verifyCachePath = process.argv[i + 1];
      i++;
    } else if (a === "--cache-ttl-days" && i + 1 < process.argv.length) {
      const days = Number(process.argv[i + 1]);
      if (Number.isFinite(days) && days > 0) {
        verifyCacheTtlMs = days * 24 * 60 * 60 * 1000;
      }
      i++;
    } else if (a === "--browser-concurrency" && i + 1 < process.argv.length) {
      const n = Number(process.argv[i + 1]);
      if (Number.isFinite(n) && n >= 1) {
        browserConcurrency = Math.floor(n);
      }
      i++;
    } else {
      positional.push(a);
    }
  }
  const input = positional[0];
  if (!input) {
    console.error(
      "Usage: verify-accessibility.ts <urls.json | url1,url2,...> [out.json] [--bodies-dir <path>] [--cache <path>] [--cache-ttl-days N] [--browser-concurrency N]",
    );
    process.exit(1);
  }

  // Carregar cache cross-edição se path foi passado.
  let verifyCache: Map<string, import("./lib/url-verify-cache.ts").CacheEntry> | null = null;
  if (verifyCachePath !== null) {
    verifyCache = loadVerifyCache(verifyCachePath, verifyCacheTtlMs);
    console.error(`[verify] cache carregado: ${verifyCache.size} entries (${verifyCachePath})`);
  }

  // Bag única passada pra cada verify() — todas as configurações em um lugar.
  const verifyOpts: VerifyOptions = {
    bodiesDir: bodiesCacheDir,
    verifyCache,
    verifyCacheTtlMs,
  };

  let urls: string[];
  if (input.endsWith(".json")) {
    const raw = readFileSync(input, "utf8");
    urls = JSON.parse(raw);
  } else {
    urls = input.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // First pass: verify all URLs with undici (fast, no JS)
  const results = await Promise.all(urls.map(async (url) => ({ url, ...(await verify(url, verifyOpts)) })));

  // Second pass: retry uncertain results with Puppeteer (JS rendering)
  const uncertainIdxs = results
    .map((r, i) => (r.verdict === "uncertain" && r.note === "body < 500 chars" ? i : -1))
    .filter((i) => i >= 0);

  if (uncertainIdxs.length > 0) {
    const effectiveConcurrency = Math.min(browserConcurrency, uncertainIdxs.length);
    console.error(
      `[verify] ${uncertainIdxs.length} uncertain — retrying with browser fallback (concurrency=${effectiveConcurrency})...`,
    );
    const fallbackStart = Date.now();
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
      const launched = browser;
      await runBounded(uncertainIdxs, effectiveConcurrency, async (idx) => {
        const r = results[idx];
        const browserResult = await verifyWithBrowser(r.url, launched);
        results[idx] = { url: r.url, ...browserResult };
      });
      const elapsedMs = Date.now() - fallbackStart;
      console.error(
        `[verify] browser fallback concluído: ${uncertainIdxs.length} URLs em ${(elapsedMs / 1000).toFixed(1)}s (concurrency=${effectiveConcurrency})`,
      );
    } catch (e) {
      console.error(`[verify] browser fallback failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  // #717 hypothesis #2: persistir verdicts cacheáveis no cross-edition cache.
  // Aplica a TODOS os results (incluindo browser-fallback ones) — verdict
  // estável conforme isCacheableVerdict.
  // #836: counters acumulados aqui em locais (era module-level antes).
  if (verifyCache !== null && verifyCachePath !== null) {
    // Cache foi configurado pra esta run, então toda URL passou pela
    // cache lookup (ela é a primeira coisa em verify()). Hit = explícito
    // `_cacheHit: true`. Miss = qualquer outro estado (incluindo paths
    // que short-circuitam pra video/aggregator/etc após o miss inicial).
    let cacheHits = 0;
    let cacheMisses = 0;
    for (const r of results) {
      if (r._cacheHit === true) cacheHits++;
      else cacheMisses++;
    }
    let added = 0;
    let bodiesCarriedToVerifyCache = 0;
    for (const r of results) {
      if (!isCacheableVerdict(r.verdict)) continue;
      const key = canonicalize(r.url);

      // #866: cache hits já estão no verify cache (potencialmente com body
      // de runs anteriores). Skip rewrite pra preservar body existente —
      // setVerifyCached overwriteria com entry sem body.
      if (r._cacheHit === true) continue;

      // #866: pra cache miss em URL accessible, lift body do bodies-dir
      // pro verify cache entry. Permite que verify-dates em runs futuros
      // (cross-edição) reuse o body sem refetch.
      let body: string | undefined;
      if (bodiesCacheDir && r.verdict === "accessible") {
        const cached = loadCachedBody(bodiesCacheDir, key);
        if (cached && cached.length <= MAX_CACHED_BODY_SIZE) {
          body = cached;
          bodiesCarriedToVerifyCache++;
        }
      }

      setVerifyCached(verifyCache, key, {
        verdict: r.verdict,
        finalUrl: r.finalUrl,
        ...(r.note ? { note: r.note } : {}),
        ...(body ? { body } : {}),
      });
      added++;
    }
    saveVerifyCache(verifyCachePath, verifyCache);
    const cacheTotal = cacheHits + cacheMisses;
    const hitPct = cacheTotal > 0 ? Math.round((cacheHits / cacheTotal) * 100) : 0;
    const bodyNote = bodiesCarriedToVerifyCache > 0
      ? `, +${bodiesCarriedToVerifyCache} bodies (#866)`
      : "";
    console.error(
      `[verify] cross-edition cache: ${cacheHits}/${cacheTotal} hit (${hitPct}%), +${added} novos entries persistidos${bodyNote}`,
    );
  }

  const paywall = results.filter((r) => r.verdict === "paywall").length;
  const blocked = results.filter((r) => r.verdict === "blocked" || r.verdict === "anti_bot").length;
  const aggregator = results.filter((r) => r.verdict === "aggregator").length;
  const ok = results.filter((r) => r.verdict === "accessible" || r.verdict === "video").length;
  const total = results.length;
  logEvent({
    edition: null,
    stage: 1,
    agent: "verify-accessibility.ts",
    level: "info",
    message: `verify: ${paywall} paywall, ${blocked} blocked, ${aggregator} aggregator, ${ok} ok`,
    details: { paywall, blocked, aggregator, ok, total },
  });

  // Strip internal `_cacheHit` field before serialization — purely
  // pra accumulating stats em main(), não pertence ao output JSON.
  const serializable = results.map(({ _cacheHit, ...rest }) => rest);

  const out = positional[1];
  if (out) {
    writeFileSync(out, JSON.stringify(serializable, null, 2), "utf8");
    console.log(`Wrote ${serializable.length} results to ${out}`);
  } else {
    console.log(JSON.stringify(serializable, null, 2));
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  main();
}
