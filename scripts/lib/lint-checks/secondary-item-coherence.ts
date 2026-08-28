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
 *
 * (#6441) `fabricated-ellipsis` only fires when the raw summary has ZERO
 * ellipsis anywhere — by construction, that means the truncation is
 * mechanically recoverable: `apply-secondary-item-ellipsis-autofix.ts` can
 * paste the missing tail back from the summary (Stage 2, before the gate).
 * The `recoverable` field on the error record makes this explicit for
 * consumers (Stage 4 severity resolution, `secondaryItemCoherenceSeverity`
 * below) instead of re-deriving it from the summary text a second time.
 * A summary that is ITSELF truncated (RSS garbage — see the
 * "saudedigitalnews" example in #6441) never reaches this branch at all:
 * `!ELLIPSIS_RE.test(summary)` is false for it, so no error is raised here —
 * correctly so, this check has no way to distinguish "source's own
 * legitimate quote ellipsis" from "source's own truncation garbage", and
 * doesn't try (same "no semantic threshold" philosophy as the module
 * docstring above). That case needs a human to notice it in the preview and
 * rewrite manually; it is out of scope for this deterministic check.
 */

import {
  forEachSecondaryItem,
  type SecondaryItemFound,
} from "./secondary-item-walker.ts";
import { TRAILING_ELLIPSIS_RE } from "../sanitize-description-ellipsis.ts";

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
  /**
   * (#6441) Only meaningful for `kind === "fabricated-ellipsis"`: true when
   * `isFabricatedEllipsisRecoverable` confirms the autofix can mechanically
   * restore the missing tail (see that function's docstring for the full
   * two-part condition). Always `false` for `unbalanced-quote` — no autofix
   * exists for it, so it is never "recoverable" in the sense this field
   * means; `secondaryItemCoherenceSeverity` gates on that kind
   * unconditionally regardless of this field's value either way.
   */
  recoverable: boolean;
}

export interface SecondaryItemCoherenceReport {
  ok: boolean;
  errors: SecondaryItemCoherenceError[];
  skipped: number;
}

export type SecondaryItemCoherenceSeverity = "gate-blocking" | "warn-only";

const ELLIPSIS_RE = /(?:\.{2,}|…)/u;

function normalizeWhitespace(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * (#6441) True when the autofix (`secondary-item-ellipsis-autofix.ts`) could
 * plausibly restore `description` from `summary` — i.e. the FULL scope the
 * autofix actually attempts, not just "summary looks intact". Two
 * conditions, both required:
 *   1. `description` itself ends in a TRAILING ellipsis — the autofix only
 *      ever scans for trailing ellipsis (`TRAILING_ELLIPSIS_RE.test(item.description)`
 *      in `applySecondaryItemEllipsisAutofix`); a MID-SENTENCE fabricated
 *      ellipsis (which `checkSecondaryItemCoherence`'s broader `ELLIPSIS_RE`
 *      below DOES flag) is never attempted by the autofix at all, so it must
 *      stay `recoverable: false` — downgrading it to warn-only would ship a
 *      fabricated claim the autofix never touched (code-review finding on
 *      #6441: severity was initially keyed only on the summary's state,
 *      silently widening the warn-only net to a case the autofix can't fix).
 *   2. `summary` does not end in a trailing ellipsis — the signal the
 *      autofix uses to know there's something to paste back.
 * Exported so the autofix module and this check share one definition
 * instead of two regexes drifting apart.
 */
export function isFabricatedEllipsisRecoverable(description: string, summary: string): boolean {
  return (
    TRAILING_ELLIPSIS_RE.test(description) &&
    !TRAILING_ELLIPSIS_RE.test(normalizeWhitespace(summary))
  );
}

/**
 * (#6441) Stage 4 severity for the `secondary-item-coherence` check, derived
 * from the report itself rather than a fixed constant: `unbalanced-quote`
 * always gate-blocks (no autofix exists for it); `fabricated-ellipsis`
 * gate-blocks only when NOT recoverable (summary itself truncated — the
 * irrecoverable case never actually fires today, see the module docstring,
 * but the field is honored here so the severity stays correct if that ever
 * changes). A recoverable `fabricated-ellipsis` — the only shape this check
 * raises in practice — downgrades to warn-only: by the time Stage 4 runs,
 * `apply-secondary-item-ellipsis-autofix.ts` (Stage 2) has already had a
 * chance to fix it; anything still showing here is a residual/edge case
 * (no confident prefix match, or Stage 2 skipped this run), not the
 * "unfixable, needs manual rewrite" class.
 */
export function secondaryItemCoherenceSeverity(
  report: SecondaryItemCoherenceReport,
): SecondaryItemCoherenceSeverity {
  const hasUnrecoverable = report.errors.some(
    (e) => e.kind === "unbalanced-quote" || (e.kind === "fabricated-ellipsis" && !e.recoverable),
  );
  return hasUnrecoverable ? "gate-blocking" : "warn-only";
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

/**
 * Exportado (#6441) para ser a fonte única de "summary bruto por URL" —
 * `apply-secondary-item-ellipsis-autofix.ts` precisa do mesmo lookup pra
 * decidir se/como restaurar a descrição, sem duplicar a lógica de extração
 * (`item.summary ?? item.article?.summary`, dedup por URL sem hash).
 */
export function summaryByUrl(approved: CoherenceApprovedJson): Map<string, string> {
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
        errors.push({ kind: "unbalanced-quote", recoverable: false, ...base });
      }
      if (ELLIPSIS_RE.test(description) && !ELLIPSIS_RE.test(summary)) {
        errors.push({
          kind: "fabricated-ellipsis",
          recoverable: isFabricatedEllipsisRecoverable(item.description, summary),
          ...base,
        });
      }
    },
  });

  return { ok: errors.length === 0, errors, skipped };
}
