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
// Quando um desses domínios aparece no input, o verdict "aggregator" sinaliza
// que o agente upstream deve ter resolvido a fonte primária antes; se chegou
// até aqui sem resolução, o orchestrator descarta.
const AGGREGATOR_DOMAINS = new Set([
  "crescendo.ai",
  "techstartups.com",
  "flipboard.com",
  "alltop.com",
  "feedly.com",
  "inoreader.com",
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

export async function verify(url: string, timeoutMs = 8000): Promise<{ verdict: Verdict; finalUrl: string; note?: string }> {
  const finalUrl = canonicalize(url);
  const host = domain(finalUrl);

  // Primary-source prefixes override aggregator domain rules.
  const urlWithoutProtocol = finalUrl.replace(/^https?:\/\//, "");
  const isPrimarySource = PRIMARY_SOURCE_PREFIXES.some((prefix) => urlWithoutProtocol.startsWith(prefix));

  if (!isPrimarySource) {
    // perplexity.ai/* (except hub/ and research subdomain) is an aggregator.
    if (host === "perplexity.ai" || AGGREGATOR_DOMAINS.has(host)) {
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
