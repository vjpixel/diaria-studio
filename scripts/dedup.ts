/**
 * dedup.ts
 *
 * Remove artigos duplicados da lista de candidatos.
 * Dois passes:
 *   1. Contra `past-editions.md` — URL canônica (últimas N edições)
 *   2. Dentro da própria lista — URL canônica + similaridade de título
 *
 * Uso:
 *   npx tsx scripts/dedup.ts --articles <articles.json> --past-editions context/past-editions.md [--window 3] [--title-threshold 0.85] [--out <out.json>]
 *
 * Input:  array JSON de artigos (cada um com ao menos { url, title? })
 * Output: { kept: Article[], removed: RemovedEntry[] }
 */

import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Aggregator blocklist — defense-in-depth against roundup newsletters
// leaking into the final candidates list. The source/discovery researchers
// have instructions to resolve canonical URLs for these domains, but this
// rejection pass is a safety net when they fail.
// ---------------------------------------------------------------------------

const AGGREGATOR_HOSTS = new Set([
  // Classic aggregators
  "crescendo.ai",
  "flipboard.com",
  "techstartups.com",
  // AI roundup newsletters (curadoria/resumo de notícias alheias)
  "therundown.ai",
  "bensbites.co",
  "theneurondaily.com",
  "superhuman.ai",
  "theaipulse.beehiiv.com",
  "agentpulse.beehiiv.com",
  "aibreakfast.beehiiv.com",
  "alphasignal.ai",
  "archive.thedeepview.com",
  "recaply.co",
  "7min.ai",
  "evolvingai.io",
  "datamachina.com",
  "cyberman.ai",
  // tldr.tech/ai handled by path check below
]);

// Path-based aggregator detection (hostname alone is too broad)
const AGGREGATOR_PATTERNS: RegExp[] = [
  /^tldr\.tech\/ai(\/|$)/i,
];

function isAggregator(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (AGGREGATOR_HOSTS.has(host)) return true;
    const full = host + u.pathname;
    return AGGREGATOR_PATTERNS.some((p) => p.test(full));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// URL canonicalization (mesma lógica do verify-accessibility.ts)
// ---------------------------------------------------------------------------

function canonicalize(url: string): string {
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

// ---------------------------------------------------------------------------
// Levenshtein similarity (0 = completamente diferente, 1 = idêntico)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[n];
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(a|o|e|um|uma|de|da|do|em|para|por|com|que|se|na|no|as|os|ao|aos|das|dos|pela|pelo|pelas|pelos|is|the|a|an|of|in|for|to|and|on|at|by|with)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a), nb = normalizeTitle(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// ---------------------------------------------------------------------------
// Parse past-editions.md — extrair URLs das últimas `window` edições
// Format: seções ## YYYY-MM-DD — "..." com "Links usados:\n- url" dentro
// ---------------------------------------------------------------------------

function extractPastUrls(md: string, window: number): Set<string> {
  const urls = new Set<string>();

  // Split into edition sections by ## YYYY-MM-DD header
  const sectionRe = /^## \d{4}-\d{2}-\d{2}/m;
  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const editionSections = parts.filter((s) => sectionRe.test(s)).slice(0, window);

  for (const section of editionSections) {
    for (const line of section.split("\n")) {
      const m = line.match(/^-\s+(https?:\/\/\S+)/);
      if (m) urls.add(canonicalize(m[1].replace(/[.,);]+$/, "")));
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Main dedup logic
// ---------------------------------------------------------------------------

interface Article {
  url: string;
  title?: string;
  source?: string;
  discovered_source?: boolean;
  [key: string]: unknown;
}

interface RemovedEntry {
  url: string;
  title?: string;
  dedup_note: string;
}

function dedup(
  articles: Article[],
  pastUrlsSet: Set<string>,
  titleThreshold: number
): { kept: Article[]; removed: RemovedEntry[] } {
  const kept: Article[] = [];
  const removed: RemovedEntry[] = [];

  // ---- Pass 0: reject aggregator URLs (safety net) -----------------------
  const afterPass0: Article[] = [];
  for (const art of articles) {
    if (isAggregator(art.url)) {
      removed.push({ url: art.url, title: art.title, dedup_note: "agregador/roundup bloqueado (use fonte primária)" });
    } else {
      afterPass0.push(art);
    }
  }

  // ---- Pass 1: dedup against past editions (URL only) --------------------
  const afterPass1: Article[] = [];
  for (const art of afterPass0) {
    const canon = canonicalize(art.url);
    if (pastUrlsSet.has(canon)) {
      removed.push({ url: art.url, title: art.title, dedup_note: "url-match com edição anterior" });
    } else {
      afterPass1.push(art);
    }
  }

  // ---- Pass 2: dedup within the current list -----------------------------
  // Sub-pass 2a: group by canonical URL, keep best per group
  const byUrl = new Map<string, Article[]>();
  for (const art of afterPass1) {
    const canon = canonicalize(art.url);
    const group = byUrl.get(canon) ?? [];
    group.push(art);
    byUrl.set(canon, group);
  }

  const afterUrlDedup: Article[] = [];
  for (const [, group] of byUrl) {
    if (group.length === 1) {
      afterUrlDedup.push(group[0]);
      continue;
    }
    // Keep the best: prefer registered source (no discovered_source flag) + longest title
    const sorted = [...group].sort((a, b) => {
      const aDisc = a.discovered_source ? 1 : 0;
      const bDisc = b.discovered_source ? 1 : 0;
      if (aDisc !== bDisc) return aDisc - bDisc; // non-discovered first
      return (b.title?.length ?? 0) - (a.title?.length ?? 0);
    });
    afterUrlDedup.push(sorted[0]);
    for (let i = 1; i < sorted.length; i++) {
      removed.push({ url: sorted[i].url, title: sorted[i].title, dedup_note: `url-duplicado na lista (mantido: ${sorted[0].url})` });
    }
  }

  // Sub-pass 2b: title similarity dedup
  for (let i = 0; i < afterUrlDedup.length; i++) {
    const artI = afterUrlDedup[i];
    if (!artI.title) {
      kept.push(artI);
      continue;
    }
    let isDup = false;
    for (let j = 0; j < i; j++) {
      const artJ = afterUrlDedup[j];
      if (!artJ.title) continue;
      const sim = titleSimilarity(artI.title, artJ.title);
      if (sim >= titleThreshold) {
        // Keep the one from a registered source; in a tie, keep artJ (already in kept)
        const iIsDisc = artI.discovered_source ? 1 : 0;
        const jIsDisc = artJ.discovered_source ? 1 : 0;
        if (iIsDisc >= jIsDisc) {
          // artI is worse or equal — remove it
          removed.push({
            url: artI.url,
            title: artI.title,
            dedup_note: `título similar (${(sim * 100).toFixed(0)}%) ao de "${artJ.title}" (${artJ.url})`,
          });
          isDup = true;
          break;
        } else {
          // artI is from a registered source, artJ is discovered — swap: remove artJ
          // But artJ is already in kept... flag it for removal retroactively
          const jIdx = kept.findIndex((a) => a.url === artJ.url);
          if (jIdx !== -1) {
            removed.push({
              url: artJ.url,
              title: artJ.title,
              dedup_note: `título similar (${(sim * 100).toFixed(0)}%) ao de "${artI.title}" (${artI.url}) — fonte cadastrada preferida`,
            });
            kept.splice(jIdx, 1);
          }
          // artI will be added below
        }
      }
    }
    if (!isDup) kept.push(artI);
  }

  return { kept, removed };
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

function main() {
  const args = parseArgs(process.argv.slice(2));

  const articlesPath = args["articles"];
  const pastEditionsPath = args["past-editions"] ?? "context/past-editions.md";
  const window = parseInt(args["window"] ?? "3", 10);
  const titleThreshold = parseFloat(args["title-threshold"] ?? "0.85");
  const outPath = args["out"];

  if (!articlesPath) {
    console.error("Uso: dedup.ts --articles <articles.json> [--past-editions <path>] [--window 3] [--title-threshold 0.85] [--out <out.json>]");
    process.exit(1);
  }

  const articles: Article[] = JSON.parse(readFileSync(articlesPath, "utf8"));
  const pastMd = readFileSync(pastEditionsPath, "utf8");
  const pastUrls = extractPastUrls(pastMd, window);

  const result = dedup(articles, pastUrls, titleThreshold);

  console.error(
    `dedup: ${articles.length} input → ${result.kept.length} kept, ${result.removed.length} removed (window=${window} edições, threshold=${titleThreshold})`
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
  main();
}
