/**
 * fetch-rss.ts
 *
 * Busca artigos de uma fonte via RSS/Atom feed em vez de WebSearch.
 *
 * Uso (CLI):
 *   npx tsx scripts/fetch-rss.ts --url https://canaltech.com.br/feed/ --source "Canaltech (IA)" [--days 3]
 *
 * Uso (import):
 *   import { fetchRss, parseFeed } from "./fetch-rss.ts";
 *   const articles = await fetchRss({ url, sourceName, days: 3 });
 *
 * Output: JSON com shape compatível com `source-researcher`:
 *   { source, method: "rss", articles: [{ url, title, published_at, summary }] }
 *
 * Suporta RSS 2.0 e Atom. Falhas de rede/parse retornam shape com `articles: []`
 * e `error` descritivo — orchestrator usa como sinal pra fallback em WebSearch.
 */

import { XMLParser } from "fast-xml-parser";

export interface Article {
  url: string;
  title: string;
  published_at: string | null;
  summary: string;
}

export interface FetchResult {
  source: string;
  method: "rss";
  feed_url: string;
  articles: Article[];
  error?: string;
}

export interface FetchOptions {
  url: string;
  sourceName: string;
  days?: number;
  timeoutMs?: number;
  now?: Date;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DAYS = 3;
const USER_AGENT = "DiariaBot/1.0 (+https://diar.ia.br)";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  alwaysCreateTextNode: false,
  trimValues: true,
  parseTagValue: false,
});

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

function coerceText(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if ("#text" in obj) return coerceText(obj["#text"]);
    if ("@_href" in obj) return coerceText(obj["@_href"]);
  }
  return "";
}

function parseDate(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw.trim());
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function extractLink(item: Record<string, unknown>): string {
  const link = item.link;
  if (typeof link === "string") return link.trim();
  if (Array.isArray(link)) {
    const alternates = link
      .map((l) => (typeof l === "string" ? { href: l, rel: "alternate" } : {
        href: coerceText((l as Record<string, unknown>)["@_href"] ?? (l as Record<string, unknown>)["#text"] ?? l),
        rel: coerceText((l as Record<string, unknown>)["@_rel"]) || "alternate",
      }))
      .filter((l) => l.href);
    const alt = alternates.find((l) => l.rel === "alternate") ?? alternates[0];
    return alt?.href ?? "";
  }
  if (typeof link === "object" && link) {
    const obj = link as Record<string, unknown>;
    return coerceText(obj["@_href"] ?? obj["#text"] ?? "");
  }
  const guid = item.guid;
  if (typeof guid === "string" && /^https?:/.test(guid)) return guid;
  if (typeof guid === "object" && guid) {
    const g = coerceText((guid as Record<string, unknown>)["#text"] ?? guid);
    if (/^https?:/.test(g)) return g;
  }
  return "";
}

function normalizeItem(item: Record<string, unknown>, kind: "rss" | "atom"): Article | null {
  const title = stripHtml(coerceText(item.title));
  if (!title) return null;

  const url = extractLink(item).trim();
  if (!url || !/^https?:\/\//.test(url)) return null;

  let published_at: string | null = null;
  if (kind === "rss") {
    published_at = parseDate(coerceText(item.pubDate ?? item["dc:date"] ?? ""));
  } else {
    published_at =
      parseDate(coerceText(item.published ?? "")) ??
      parseDate(coerceText(item.updated ?? ""));
  }

  const rawSummary =
    kind === "rss"
      ? coerceText(item.description ?? item["content:encoded"] ?? "")
      : coerceText(item.summary ?? item.content ?? "");
  const summary = stripHtml(rawSummary).slice(0, 500);

  return { url, title, published_at, summary };
}

export function parseFeed(xml: string): { articles: Article[]; kind: "rss" | "atom" } {
  const parsed = xmlParser.parse(xml);

  if (parsed.rss?.channel) {
    const channel = parsed.rss.channel as Record<string, unknown>;
    const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
    const articles = items
      .map((it) => normalizeItem(it as Record<string, unknown>, "rss"))
      .filter((a): a is Article => a !== null);
    return { articles, kind: "rss" };
  }

  if (parsed.feed) {
    const feed = parsed.feed as Record<string, unknown>;
    const entries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
    const articles = entries
      .map((e) => normalizeItem(e as Record<string, unknown>, "atom"))
      .filter((a): a is Article => a !== null);
    return { articles, kind: "atom" };
  }

  if (parsed["rdf:RDF"]) {
    const rdf = parsed["rdf:RDF"] as Record<string, unknown>;
    const items = Array.isArray(rdf.item) ? rdf.item : rdf.item ? [rdf.item] : [];
    const articles = items
      .map((it) => normalizeItem(it as Record<string, unknown>, "rss"))
      .filter((a): a is Article => a !== null);
    return { articles, kind: "rss" };
  }

  throw new Error("Formato de feed não reconhecido (esperado RSS 2.0, Atom ou RDF)");
}

export function filterByWindow(articles: Article[], days: number, now: Date = new Date()): Article[] {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return articles.filter((a) => {
    if (!a.published_at) return true;
    const t = new Date(a.published_at).getTime();
    return !isNaN(t) && t >= cutoff;
  });
}

export async function fetchRss(opts: FetchOptions): Promise<FetchResult> {
  const days = opts.days ?? DEFAULT_DAYS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? new Date();

  // Security: validar scheme da URL pra evitar SSRF (file://, data://, etc.).
  // Editor controla seed/sources.csv, mas defense-in-depth.
  try {
    const parsed = new URL(opts.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        source: opts.sourceName,
        method: "rss",
        feed_url: opts.url,
        articles: [],
        error: `Unsupported URL scheme: ${parsed.protocol} (só http/https aceitos)`,
      };
    }
  } catch {
    return {
      source: opts.sourceName,
      method: "rss",
      feed_url: opts.url,
      articles: [],
      error: `Invalid URL: ${opts.url}`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(opts.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!res.ok) {
      return {
        source: opts.sourceName,
        method: "rss",
        feed_url: opts.url,
        articles: [],
        error: `HTTP ${res.status}`,
      };
    }

    const xml = await res.text();
    const { articles } = parseFeed(xml);
    const filtered = filterByWindow(articles, days, now);
    return { source: opts.sourceName, method: "rss", feed_url: opts.url, articles: filtered };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      source: opts.sourceName,
      method: "rss",
      feed_url: opts.url,
      articles: [],
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url;
  const sourceName = args.source ?? "unknown";
  const days = args.days ? Number(args.days) : DEFAULT_DAYS;

  if (!url) {
    console.error("Uso: tsx fetch-rss.ts --url <feed_url> --source <name> [--days 3]");
    process.exit(1);
  }

  const result = await fetchRss({ url, sourceName, days });
  console.log(JSON.stringify(result, null, 2));
  if (result.error) process.exit(2);
}

const invokedDirectly =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
