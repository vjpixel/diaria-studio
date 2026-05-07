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
import { capArticles, MAX_ARTICLES_PER_SOURCE, type Article } from "./lib/article-cap.ts";

// Re-export pra backward compat (test/fetch-rss.test.ts importa Article daqui).
export { capArticles, MAX_ARTICLES_PER_SOURCE };
export type { Article };

export interface FetchResult {
  source: string;
  method: "rss";
  feed_url: string;
  articles: Article[];
  error?: string;
  /** #678: quantos artigos foram descartados pelo topicFilter (feed funcionou, mas sem match).
   * Se > 0, o orchestrator NÃO deve fazer fallback para WebSearch — o feed está ok. */
  filtered_by_topic?: number;
  /** #891: quantos artigos foram cortados pelo cap por source. Indica que o feed
   * tinha mais conteúdo que MAX_ARTICLES_PER_SOURCE — útil pra triagem de
   * fontes que dominam payload (ex: arXiv devolveu 229 artigos em 260507). */
  truncated_by_cap?: number;
}

export interface FetchOptions {
  url: string;
  sourceName: string;
  days?: number;
  timeoutMs?: number;
  now?: Date;
  /** #347: filtrar artigos por tópico (ao menos 1 termo deve aparecer no title+summary). Case-insensitive. */
  topicFilter?: string[];
}

/**
 * Filtra artigos por tópico (#347): mantém apenas artigos cujo
 * `(title + " " + summary).toLowerCase()` contenha ao menos 1 dos termos.
 * Se `terms` estiver vazio ou ausente, retorna todos os artigos sem filtro.
 */
export function filterByTopic(articles: Article[], terms: string[]): Article[] {
  if (!terms || terms.length === 0) return articles;
  const lowerTerms = terms.map((t) => t.toLowerCase());
  return articles.filter((a) => {
    const haystack = (a.title + " " + (a.summary ?? "")).toLowerCase();
    return lowerTerms.some((t) => haystack.includes(t));
  });
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
    if (!a.published_at) return true; // mantido; caller loga a contagem (#685)
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
    const byWindow = filterByWindow(articles, days, now);
    // #685: logar artigos sem data no caller (não dentro da função pura filterByWindow)
    const undatedCount = articles.filter((a) => !a.published_at).length;
    if (undatedCount > 0) {
      console.error(`[fetch-rss] ${undatedCount} artigo(s) sem published_at mantidos para revisão downstream: ${opts.sourceName}`);
    }
    const hasTopicFilter = opts.topicFilter && opts.topicFilter.length > 0;
    const filtered = hasTopicFilter ? filterByTopic(byWindow, opts.topicFilter!) : byWindow;
    // #678: expõe quantos artigos foram descartados pelo topicFilter para que o
    // orchestrator não faça fallback WebSearch desnecessário (feed ok, sem match hoje).
    const filteredByTopic = hasTopicFilter ? byWindow.length - filtered.length : undefined;
    // #891: cap por source — feeds gigantes (arXiv, agregadores) bloat o payload do orchestrator.
    const { capped, truncated } = capArticles(filtered);
    if (truncated > 0) {
      console.error(
        `[fetch-rss] cap aplicado em ${opts.sourceName}: ${filtered.length} → ${capped.length} (${truncated} cortados)`,
      );
    }
    return {
      source: opts.sourceName,
      method: "rss",
      feed_url: opts.url,
      articles: capped,
      ...(filteredByTopic !== undefined ? { filtered_by_topic: filteredByTopic } : {}),
      ...(truncated > 0 ? { truncated_by_cap: truncated } : {}),
    };
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
  // #347: --topic-filter "term1,term2,..." (parse por vírgula)
  const topicFilter = args["topic-filter"]
    ? args["topic-filter"].split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;

  if (!url) {
    console.error("Uso: tsx fetch-rss.ts --url <feed_url> --source <name> [--days 3] [--topic-filter \"term1,term2,...\"]");
    process.exit(1);
  }

  const result = await fetchRss({ url, sourceName, days, topicFilter });
  console.log(JSON.stringify(result, null, 2));
  if (result.error) process.exit(2);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const invokedDirectly =
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`;

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
