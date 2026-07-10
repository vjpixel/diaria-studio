#!/usr/bin/env npx tsx
/**
 * translate-summaries.ts (#1490)
 *
 * Reads `_internal/01-approved-capped.json`, finds articles with English
 * summaries (or arXiv abstract prefixes), cleans/truncates them to 1-line
 * PT-BR-friendly text, and writes back.
 *
 * Since we can't call an LLM from a deterministic script, the approach is:
 * - Strip arXiv prefix (`arXiv:XXXX.XXXXXvN Announce Type: new Abstract: `)
 * - Take first sentence (up to first period)
 * - Truncate to 150 chars max
 * - Mark with `summary_translated: true` for idempotency
 *
 * For fully-English titles: not translated here (would need LLM). Only
 * summaries are cleaned.
 *
 * Usage:
 *   npx tsx scripts/translate-summaries.ts --in <path> --out <path>
 *
 * Output JSON summary to stdout:
 *   { considered, translated, already_ok, truncated }
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { truncateAtBoundary } from "./lib/truncate-at-boundary.ts";
import { isMainModule } from "./lib/cli-args.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ArticleEntry {
  title?: string;
  summary?: string;
  summary_translated?: boolean;
  url?: string;
  [key: string]: unknown;
}

interface ApprovedJson {
  highlights?: Array<{ article: ArticleEntry; [key: string]: unknown }>;
  lancamento?: ArticleEntry[];
  pesquisa?: ArticleEntry[];
  noticias?: ArticleEntry[];
  video?: ArticleEntry[];
  [key: string]: unknown;
}

interface TranslateStats {
  considered: number;
  translated: number;
  already_ok: number;
  truncated: number;
}

// ---------------------------------------------------------------------------
// EN detection heuristic
// ---------------------------------------------------------------------------

const EN_COMMON_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "been",
  "are", "was", "were", "will", "can", "has", "its", "into", "also",
  "but", "not", "more", "than", "when", "which", "their", "they",
  "about", "would", "could", "should", "these", "those", "other",
  "some", "such", "only", "over", "after", "before", "between",
  "each", "most", "both", "through", "being", "while", "where",
  "does", "did", "our", "your", "what", "how",
]);

const ARXIV_PREFIX_RE =
  /^arXiv:\d{4}\.\d{4,5}(?:v\d+)?\s*(?:\[[\w.]+\]\s*)?(?:Announce Type:\s*\w+\s*)?(?:Abstract:\s*)?/i;

const MAX_SUMMARY_LENGTH = 150;

/**
 * Returns true if text appears to be primarily English.
 * Heuristic: >60% of words (3+ chars) are common EN words.
 */
function isLikelyEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  if (words.length < 3) return false;
  const enCount = words.filter((w) => EN_COMMON_WORDS.has(w)).length;
  return enCount / words.length > 0.25;
}

/**
 * Returns true if text has an arXiv prefix.
 */
function hasArxivPrefix(text: string): boolean {
  return ARXIV_PREFIX_RE.test(text);
}

/**
 * Whether this article's summary needs cleaning.
 */
function needsCleaning(article: ArticleEntry): boolean {
  if (article.summary_translated) return false;
  const summary = (article.summary ?? "").trim();
  if (!summary) return false;
  return hasArxivPrefix(summary) || isLikelyEnglish(summary);
}

/**
 * Clean/truncate a summary:
 * - Strip arXiv prefix
 * - Take first sentence
 * - Truncate to MAX_SUMMARY_LENGTH
 */
function cleanSummary(summary: string): { cleaned: string; truncated: boolean } {
  let text = summary.replace(ARXIV_PREFIX_RE, "").trim();

  // Take first sentence (up to first period followed by space or end)
  const sentenceEnd = text.match(/\.\s/);
  if (sentenceEnd && sentenceEnd.index !== undefined) {
    text = text.slice(0, sentenceEnd.index + 1);
  }

  const truncated = text.length > MAX_SUMMARY_LENGTH;
  if (truncated) {
    // usar word-boundary pra não cortar no meio de palavra (#2065)
    text = truncateAtBoundary(text, MAX_SUMMARY_LENGTH);
  }

  return { cleaned: text, truncated };
}

/**
 * Process all articles in the approved JSON, cleaning EN summaries.
 */
export function translateSummaries(data: ApprovedJson): {
  data: ApprovedJson;
  stats: TranslateStats;
} {
  const stats: TranslateStats = {
    considered: 0,
    translated: 0,
    already_ok: 0,
    truncated: 0,
  };

  function processArticle(article: ArticleEntry): void {
    stats.considered++;
    if (!needsCleaning(article)) {
      stats.already_ok++;
      return;
    }
    const summary = (article.summary ?? "").trim();
    const { cleaned, truncated } = cleanSummary(summary);
    article.summary = cleaned;
    article.summary_translated = true;
    stats.translated++;
    if (truncated) stats.truncated++;
  }

  // Process highlights
  if (data.highlights) {
    for (const h of data.highlights) {
      if (h.article) processArticle(h.article);
    }
  }

  // Process secondary sections
  const sections: (keyof ApprovedJson)[] = [
    "lancamento",
    "pesquisa",
    "noticias",
    "video",
  ];
  for (const section of sections) {
    const items = data[section];
    if (Array.isArray(items)) {
      for (const item of items as ArticleEntry[]) {
        processArticle(item);
      }
    }
  }

  return { data, stats };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv: string[]): { inPath: string; outPath: string } {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (!flags.in) {
    console.error(
      "Usage: translate-summaries.ts --in <path> --out <path>",
    );
    process.exit(1);
  }
  return {
    inPath: flags.in,
    outPath: flags.out ?? flags.in,
  };
}

function main(): void {
  const cli = parseCliArgs(process.argv.slice(2));
  const inPath = resolve(process.cwd(), cli.inPath);
  const outPath = resolve(process.cwd(), cli.outPath);

  const raw = readFileSync(inPath, "utf8");
  const data = JSON.parse(raw) as ApprovedJson;

  const { data: processed, stats } = translateSummaries(data);

  writeFileSync(outPath, JSON.stringify(processed, null, 2), "utf8");
  process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
}

const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) main();
