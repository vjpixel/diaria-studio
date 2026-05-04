/**
 * expand-inbox-aggregators.ts  (#483)
 *
 * Para artigos submetidos pelo editor via inbox cujo link aponta para um
 * agregador (ex: Perplexity Page, Flipboard, etc.), o comportamento padrão
 * do pipeline é descartar o link. Este script implementa a alternativa:
 * fazer fetch da página do agregador, extrair os links primários referenciados
 * e injetá-los no pipeline como novos artigos com `source: "inbox_via_aggregator"`.
 *
 * Slot no pipeline: APÓS `verify-accessibility.ts`, ANTES de
 * `enrich-inbox-articles.ts`. Recebe a lista de artigos (já com veredictos
 * de acessibilidade mesclados) e a lista de resultados do link-verify.
 * Artigos inbox com `verdict: "aggregator"` são expandidos; os demais são
 * passados adiante sem alteração.
 *
 * Uso:
 *   npx tsx scripts/expand-inbox-aggregators.ts \
 *     --articles  data/editions/260429/_internal/tmp-articles-post-verify.json \
 *     --verify    data/editions/260429/_internal/link-verify-all.json \
 *     --out       data/editions/260429/_internal/tmp-articles-expanded.json
 *
 * Input:
 *   --articles  Array de artigos ({ url, title?, source?, flag?, verdict?, ... })
 *   --verify    Array de { url, verdict, finalUrl, note?, resolvedFrom? } do verify-accessibility.ts
 *
 * Output (--out ou stdout):
 *   { articles: Article[], expanded: ExpandResult[], warnings: string[] }
 *
 * Nota: se `expandAggregatorLinks` retornar lista vazia para um artigo
 * inbox-aggregador, o artigo original é descartado (comportamento atual)
 * e um warning é emitido.
 */

import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Article {
  url: string;
  title?: string | null;
  source?: string;
  flag?: string;
  verdict?: string;
  [key: string]: unknown;
}

export interface VerifyEntry {
  url: string;
  verdict: string;
  finalUrl: string;
  note?: string;
  resolvedFrom?: string;
}

export interface ExpandResult {
  aggregator_url: string;
  extracted_urls: string[];
  injected: number;
  discarded: boolean;
  reason?: string;
}

export interface ExpandOutput {
  articles: Article[];
  expanded: ExpandResult[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalize(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "ref" || key === "ref_src")
        u.searchParams.delete(key);
    }
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/"))
      u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return url;
  }
}

function isInboxArticle(article: Article): boolean {
  return (
    article.flag === "editor_submitted" ||
    article.source === "inbox" ||
    article.source === "inbox_via_aggregator"
  );
}

// ---------------------------------------------------------------------------
// Core extraction logic (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Fetches the HTML of an aggregator URL and extracts external links that
 * could be primary sources. Returns at most 10 unique, de-duped external URLs.
 *
 * Filtering rules:
 *   - Must be http(s)
 *   - Must be on a different hostname than the aggregator
 *   - No fragment-only links (#…)
 *   - Social domains excluded (twitter, x.com, facebook, linkedin, instagram)
 *   - Known tracking/redirect domains excluded (t.co, bit.ly, etc.)
 */
export async function expandAggregatorLinks(url: string): Promise<string[]> {
  const SOCIAL_DOMAINS = new Set([
    "twitter.com",
    "x.com",
    "facebook.com",
    "linkedin.com",
    "instagram.com",
    "youtube.com",
  ]);
  const TRACKER_DOMAINS = new Set([
    "t.co",
    "bit.ly",
    "tinyurl.com",
    "ow.ly",
    "buff.ly",
    "dlvr.it",
    "share.google",
  ]);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Diar.ia/1.0 (https://diar.ia.br; diariaeditor@gmail.com)",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const html = await res.text();

    let aggregatorHost: string;
    try {
      aggregatorHost = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return [];
    }

    const links: string[] = [];
    const re = /href="(https?:\/\/[^"]+)"/gi;
    let m: RegExpExecArray | null;

    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      if (href.includes("#")) continue; // skip fragment links

      let hrefHost: string;
      try {
        hrefHost = new URL(href).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        continue;
      }

      // Must be external to the aggregator
      if (hrefHost === aggregatorHost) continue;

      // Skip social and tracker domains
      if (SOCIAL_DOMAINS.has(hrefHost)) continue;
      if (TRACKER_DOMAINS.has(hrefHost)) continue;

      links.push(canonicalize(href));
      if (links.length >= 10) break;
    }

    // Deduplicate preserving order
    return [...new Set(links)];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pipeline integration
// ---------------------------------------------------------------------------

/**
 * Main expansion pass. Takes the article list and verify results, identifies
 * inbox articles with `verdict: "aggregator"`, expands each to its primary
 * links, and returns the updated article list.
 *
 * @param articles     Full article list (mutated copy is returned, original untouched).
 * @param verifyMap    Map from canonical URL → VerifyEntry.
 * @param fetcher      Injectable async function for testing (defaults to expandAggregatorLinks).
 */
export async function expandInboxAggregators(
  articles: Article[],
  verifyMap: Map<string, VerifyEntry>,
  fetcher: (url: string) => Promise<string[]> = expandAggregatorLinks,
): Promise<ExpandOutput> {
  const out: Article[] = [];
  const expanded: ExpandResult[] = [];
  const warnings: string[] = [];

  for (const article of articles) {
    if (!isInboxArticle(article)) {
      // Non-inbox articles pass through unchanged
      out.push(article);
      continue;
    }

    const canon = canonicalize(article.url);
    const verifyEntry = verifyMap.get(canon) ?? verifyMap.get(article.url);
    const verdict = verifyEntry?.verdict ?? article.verdict ?? "";

    if (verdict !== "aggregator") {
      // Not an aggregator — pass through
      out.push(article);
      continue;
    }

    // Inbox aggregator: attempt extraction
    const primaryLinks = await fetcher(article.url);

    if (primaryLinks.length === 0) {
      const warn = `expand-inbox-aggregators: nenhum link primário encontrado em ${article.url} — descartado`;
      warnings.push(warn);
      console.error(`⚠️  ${warn}`);
      expanded.push({
        aggregator_url: article.url,
        extracted_urls: [],
        injected: 0,
        discarded: true,
        reason: "no_primary_links_found",
      });
      // Discard aggregator (same as current behaviour)
      continue;
    }

    // Inject each extracted link as a new article
    const injected: string[] = [];
    for (const href of primaryLinks) {
      out.push({
        url: href,
        title: null,
        summary: null,
        source: "inbox_via_aggregator",
        flag: "editor_submitted",
        inbox_submitted: true,
        expanded_from: article.url,
      });
      injected.push(href);
    }

    expanded.push({
      aggregator_url: article.url,
      extracted_urls: injected,
      injected: injected.length,
      discarded: false,
    });

    console.error(
      `expand-inbox-aggregators: ${article.url} → ${injected.length} link(s) primário(s) injetado(s)`,
    );
  }

  return { articles: out, expanded, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const articlesPath = args["articles"];
  const verifyPath = args["verify"];
  const outPath = args["out"];

  if (!articlesPath || !verifyPath) {
    console.error(
      "Uso: expand-inbox-aggregators.ts --articles <articles.json> --verify <link-verify-all.json> [--out <out.json>]",
    );
    process.exit(1);
  }

  const articles: Article[] = JSON.parse(readFileSync(articlesPath, "utf8"));
  const verifyEntries: VerifyEntry[] = JSON.parse(
    readFileSync(verifyPath, "utf8"),
  );

  // Build verify map keyed by both original and canonical URL for flexibility
  const verifyMap = new Map<string, VerifyEntry>();
  for (const entry of verifyEntries) {
    verifyMap.set(entry.url, entry);
    verifyMap.set(canonicalize(entry.url), entry);
    if (entry.finalUrl) {
      verifyMap.set(entry.finalUrl, entry);
      verifyMap.set(canonicalize(entry.finalUrl), entry);
    }
  }

  const inboxAggregators = articles.filter(
    (a) =>
      isInboxArticle(a) &&
      (() => {
        const canon = canonicalize(a.url);
        const v = verifyMap.get(canon) ?? verifyMap.get(a.url);
        return (v?.verdict ?? a.verdict ?? "") === "aggregator";
      })(),
  );

  if (inboxAggregators.length === 0) {
    console.error("expand-inbox-aggregators: nenhum artigo inbox-aggregador encontrado");
    const result: ExpandOutput = { articles, expanded: [], warnings: [] };
    const json = JSON.stringify(result, null, 2);
    if (outPath) writeFileSync(outPath, json, "utf8");
    else process.stdout.write(json);
    return;
  }

  console.error(
    `expand-inbox-aggregators: ${inboxAggregators.length} artigo(s) inbox-agregador detectado(s)`,
  );

  const result = await expandInboxAggregators(articles, verifyMap);

  console.error(
    `expand-inbox-aggregators: ${result.expanded.length} agregador(es) processado(s), ` +
      `${result.expanded.reduce((s, e) => s + e.injected, 0)} link(s) primário(s) injetado(s), ` +
      `${result.warnings.length} warning(s)`,
  );

  const json = JSON.stringify(result, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, "utf8");
    console.error(`Wrote to ${outPath}`);
  } else {
    process.stdout.write(json);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((err) => {
    console.error("expand-inbox-aggregators error:", err);
    process.exit(1);
  });
}
