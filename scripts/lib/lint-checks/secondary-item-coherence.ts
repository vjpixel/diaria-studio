/**
 * Deterministic backstop for incoherent secondary-item output (#5663).
 *
 * This deliberately does not invent a semantic-similarity threshold. The
 * approved JSON gives us the raw summary for the same URL, so we only enforce
 * structural facts that are unambiguous:
 * - quote delimiters must be balanced;
 * - an ellipsis in the writer output must also exist in the raw summary.
 *
 * The writer prompts remain the primary defense against a valid-looking but
 * unrepresentative rewrite; this check catches the concrete failure modes that
 * can be proven from the available inputs.
 */

import {
  forEachSecondaryItem,
  type SecondaryItemFound,
} from "./secondary-item-walker.ts";

export interface CoherenceApprovedArticle {
  url?: string;
  title?: string;
  summary?: string;
  article?: { url?: string; title?: string; summary?: string };
  [key: string]: unknown;
}

export interface CoherenceApprovedJson {
  [key: string]: unknown;
}

export type SecondaryItemCoherenceErrorKind =
  | "unbalanced-quote"
  | "fabricated-ellipsis";

export interface SecondaryItemCoherenceError {
  kind: SecondaryItemCoherenceErrorKind;
  section: string;
  line: number;
  titleExcerpt: string;
  descriptionExcerpt: string;
  url: string;
}

export interface SecondaryItemCoherenceReport {
  ok: boolean;
  errors: SecondaryItemCoherenceError[];
  skipped: number;
}

const ELLIPSIS_RE = /(?:\.{2,}|…)/u;

function normalizeWhitespace(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

function isUnbalancedQuote(text: string): boolean {
  const straightQuotes = (text.match(/"/g) ?? []).length;
  if (straightQuotes % 2 !== 0) return true;

  const openings = (text.match(/[“«]/gu) ?? []).length;
  const closings = (text.match(/[”»]/gu) ?? []).length;
  return openings !== closings;
}

function articleEntries(approved: CoherenceApprovedJson): CoherenceApprovedArticle[] {
  const entries: CoherenceApprovedArticle[] = [];
  for (const value of Object.values(approved)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item && typeof item === "object") entries.push(item as CoherenceApprovedArticle);
    }
  }
  return entries;
}

function summaryByUrl(approved: CoherenceApprovedJson): Map<string, string> {
  const summaries = new Map<string, string>();
  for (const item of articleEntries(approved)) {
    const url = item.url ?? item.article?.url;
    const summary = item.summary ?? item.article?.summary;
    if (typeof url === "string" && typeof summary === "string" && summary.trim()) {
      summaries.set(url.split("#", 1)[0], normalizeWhitespace(summary));
    }
  }
  return summaries;
}

export function checkSecondaryItemCoherence(
  md: string,
  approved: CoherenceApprovedJson,
): SecondaryItemCoherenceReport {
  const errors: SecondaryItemCoherenceError[] = [];
  const summaries = summaryByUrl(approved);
  let skipped = 0;

  forEachSecondaryItem(md, {
    onFound: (item: SecondaryItemFound) => {
      const summary = summaries.get(item.url.split("#", 1)[0]);
      if (!summary) {
        skipped++;
        return;
      }
      const description = normalizeWhitespace(item.description);
      const base = {
        section: item.section,
        line: item.descriptionLine,
        titleExcerpt: item.title.slice(0, 80),
        descriptionExcerpt: item.description.slice(0, 120),
        url: item.url,
      };
      if (isUnbalancedQuote(description)) {
        errors.push({ kind: "unbalanced-quote", ...base });
      }
      if (ELLIPSIS_RE.test(description) && !ELLIPSIS_RE.test(summary)) {
        errors.push({ kind: "fabricated-ellipsis", ...base });
      }
    },
  });

  return { ok: errors.length === 0, errors, skipped };
}
