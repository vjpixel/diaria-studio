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
import { isAggregator } from "./lib/aggregators";
import { CONFIG } from "./lib/config.ts";
import { canonicalize } from "./lib/url-utils.ts";

export { canonicalize };

// URL canonicalization — centralizada em scripts/lib/url-utils.ts (#523)
// ---------------------------------------------------------------------------

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

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(a|o|e|um|uma|de|da|do|em|para|por|com|que|se|na|no|as|os|ao|aos|das|dos|pela|pelo|pelas|pelos|is|the|a|an|of|in|for|to|and|on|at|by|with)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a), nb = normalizeTitle(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// ---------------------------------------------------------------------------
// Parse past-editions.md — extrair URLs das últimas `window` edições
// Format: seções ## YYYY-MM-DD — "..." com "Links usados:\n- url" dentro
// ---------------------------------------------------------------------------

export function extractPastUrls(md: string, window: number): Set<string> {
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

/**
 * Extrai títulos das últimas `window` edições publicadas (#231 defense-in-depth).
 * Captura o título de cada edição (`## YYYY-MM-DD — "Título"`) para comparação
 * de similaridade com artigos candidatos.
 *
 * Nota: são títulos das newsletters (headline do destaque principal), não títulos
 * individuais dos artigos. Sinal mais fraco que URL match, mas útil quando URL
 * difere (mesma notícia, fonte diferente).
 */
export function extractPastTitles(md: string, window: number): string[] {
  const titles: string[] = [];
  const sectionRe = /^## \d{4}-\d{2}-\d{2}/m;
  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const editionSections = parts.filter((s) => sectionRe.test(s)).slice(0, window);
  for (const section of editionSections) {
    const titleMatch = section.match(/^## \d{4}-\d{2}-\d{2}[^"]*"([^"]+)"/m);
    if (titleMatch) titles.push(titleMatch[1]);
  }
  return titles;
}

// ---------------------------------------------------------------------------
// Inbox title resolution (#485)
// ---------------------------------------------------------------------------

/** Placeholder values that indicate an unresolved inbox title. */
const INBOX_TITLE_PLACEHOLDERS = ["(inbox)", "(no title)", "(sem título)"];

/** Returns true if the article title is a placeholder that needs resolution. */
export function needsTitleResolution(title: string | undefined | null): boolean {
  if (!title || !title.trim()) return true;
  const lower = title.trim().toLowerCase();
  if (INBOX_TITLE_PLACEHOLDERS.includes(lower)) return true;
  if (/^\(inbox/i.test(lower)) return true;
  if (/^\[inbox\]/i.test(lower)) return true;
  return false;
}

/**
 * Fetches the real title of a page by parsing its `<title>` tag.
 * Returns null on network error, non-OK response, or missing `<title>`.
 */
export async function fetchTitle(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Diar.ia/1.0 (https://diar.ia.br; diariaeditor@gmail.com)",
      },
      signal: AbortSignal.timeout(CONFIG.timeouts.fetch),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? match[1].trim().replace(/\s+/g, " ") : null;
  } catch {
    return null;
  }
}

/**
 * For each article with a placeholder title (e.g. `(inbox)`), resolves the
 * real title via an HTTP fetch. Processed in parallel up to `concurrency`
 * simultaneous requests. Articles that fail to resolve keep their original
 * title. Never throws — uses Promise.allSettled internally.
 *
 * @param articles    Mutable array; titles are updated in-place on success.
 * @param concurrency Max parallel fetches (default: 15).
 */
export async function resolveInboxTitles(
  articles: { url: string; title?: string | null; [key: string]: unknown }[],
  concurrency = CONFIG.dedup.titleResolutionConcurrency,
): Promise<{ resolved: number; failed: number }> {
  const targets = articles
    .map((a, i) => ({ idx: i, article: a }))
    .filter(({ article }) => needsTitleResolution(article.title));

  if (targets.length === 0) return { resolved: 0, failed: 0 };

  let resolved = 0;
  let failed = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const job = targets[cursor++];
      const title = await fetchTitle(job.article.url);
      if (title) {
        articles[job.idx].title = title;
        resolved++;
      } else {
        failed++;
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, targets.length)) },
    () => worker(),
  );
  await Promise.allSettled(workers);

  return { resolved, failed };
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

export function dedup(
  articles: Article[],
  pastUrlsSet: Set<string>,
  titleThreshold: number,
  pastTitles: string[] = [],
  titleVsPastThreshold = 0.70,
): { kept: Article[]; removed: RemovedEntry[] } {
  const kept: Article[] = [];
  const removed: RemovedEntry[] = [];

  // ---- Pass 0: reject aggregator URLs (safety net) -----------------------
  const afterPass0: Article[] = [];
  let pass0Rejected = 0;
  for (const art of articles) {
    if (isAggregator(art.url)) {
      removed.push({ url: art.url, title: art.title, dedup_note: "agregador/roundup bloqueado (use fonte primária)" });
      pass0Rejected++;
    } else {
      afterPass0.push(art);
    }
  }
  if (pass0Rejected > 0) {
    console.error(`dedup Pass-0: ${pass0Rejected} URL(s) de agregador/roundup rejeitadas`);
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

  // ---- Pass 1b: title similarity vs past edition headlines (#231 defense-in-depth) ---
  // Threshold mais permissivo (0.70 vs 0.85 dentro da lista) — títulos de newsletter
  // diferem em idioma/ângulo mas evento idêntico deve ter sim > 0.70.
  // Só roda se pastTitles foi fornecido (backward-compat).
  const afterPass1b: Article[] = [];
  if (pastTitles.length > 0) {
    for (const art of afterPass1) {
      if (!art.title) {
        afterPass1b.push(art);
        continue;
      }
      let isDupVsPast = false;
      for (const pastTitle of pastTitles) {
        const sim = titleSimilarity(art.title, pastTitle);
        if (sim >= titleVsPastThreshold) {
          removed.push({
            url: art.url,
            title: art.title,
            dedup_note: `título similar (${(sim * 100).toFixed(0)}%) ao headline de edição anterior "${pastTitle}"`,
          });
          isDupVsPast = true;
          break;
        }
      }
      if (!isDupVsPast) afterPass1b.push(art);
    }
    if (afterPass1.length > afterPass1b.length) {
      console.error(`dedup Pass-1b: ${afterPass1.length - afterPass1b.length} artigo(s) removido(s) por similaridade com headline de edição anterior`);
    }
  } else {
    afterPass1b.push(...afterPass1);
  }

  // ---- Pass 2: dedup within the current list -----------------------------
  // Sub-pass 2a: group by canonical URL, keep best per group
  const byUrl = new Map<string, Article[]>();
  for (const art of afterPass1b) {
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
      // #482: artigos inbox têm título "(inbox)" — não comparar por título;
      // deduplicação real já foi feita por URL na sub-pass 2a.
      if (
        artI.title.toLowerCase() === "(inbox)" ||
        artJ.title.toLowerCase() === "(inbox)"
      ) continue;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const articlesPath = args["articles"];
  const pastEditionsPath = args["past-editions"] ?? "context/past-editions.md";
  const window = parseInt(args["window"] ?? "3", 10);
  const titleThreshold = parseFloat(args["title-threshold"] ?? String(CONFIG.dedup.titleThreshold));
  const outPath = args["out"];

  if (!articlesPath) {
    console.error("Uso: dedup.ts --articles <articles.json> [--past-editions <path>] [--window 3] [--title-threshold 0.85] [--title-vs-past-threshold 0.70] [--out <out.json>]");
    process.exit(1);
  }

  const articles: Article[] = JSON.parse(readFileSync(articlesPath, "utf8"));

  // Pre-pass (#485): resolve placeholder titles for inbox articles before dedup
  // so "(inbox)" doesn't cause false-positive title similarity matches.
  const inboxCount = articles.filter((a) => needsTitleResolution(a.title)).length;
  if (inboxCount > 0) {
    console.error(`dedup pre-pass: ${inboxCount} artigo(s) com título placeholder — resolvendo títulos reais...`);
    const { resolved, failed } = await resolveInboxTitles(articles);
    console.error(`dedup pre-pass: ${resolved} título(s) resolvido(s), ${failed} falha(s) (mantidos com placeholder)`);
  }

  const pastMd = readFileSync(pastEditionsPath, "utf8");
  const pastUrls = extractPastUrls(pastMd, window);
  const pastTitles = extractPastTitles(pastMd, window); // #231 defense-in-depth
  const titleVsPastThreshold = parseFloat(args["title-vs-past-threshold"] ?? String(CONFIG.dedup.titleVsPastThreshold));

  const result = dedup(articles, pastUrls, titleThreshold, pastTitles, titleVsPastThreshold);

  console.error(
    `dedup: ${articles.length} input → ${result.kept.length} kept, ${result.removed.length} removed (window=${window} edições, threshold=${titleThreshold}, title-vs-past=${titleVsPastThreshold})`
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
    console.error("dedup error:", err);
    process.exit(1);
  });
}
