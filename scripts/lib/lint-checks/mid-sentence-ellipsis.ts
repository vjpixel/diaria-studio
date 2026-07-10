/**
 * lint-checks/mid-sentence-ellipsis.ts (#3196)
 *
 * Backstop for outlet meta-description truncation landing in the MIDDLE of a
 * secondary item's description, not just at the end (`no-trailing-ellipsis`,
 * #2881, already covers the trailing case). Some outlets truncate their OWN
 * meta-description with an ellipsis surrounded by real words on both sides —
 * that reads as if OUR pipeline had cut the sentence, when it's the source's
 * own truncation. Reported incident (#3196, edição 260709, item RADAR G1):
 *
 *   "Um advogado de Salvador foi condenado ... de inteligência artificial
 *    (IA) usadas pelo tribunal"
 *
 * WARN-ONLY (mirrors the #2715 rationale used by title-publisher-suffix /
 * title-trailing-period / no-trailing-ellipsis): this is a broad heuristic
 * with no allowlist, so it necessarily also flags a LEGITIMATE stylistic
 * mid-sentence ellipsis (e.g. "Os pesquisadores esperavam um resultado… e
 * tiveram uma surpresa completamente diferente." — the exact shape
 * `no-trailing-ellipsis`'s own test suite treats as OK to NOT flag). That's
 * by design: this check is a wider net for the editor to eyeball, never a
 * gate-blocker — the false-positive cost is low, the false-negative cost
 * (unflagged truncation reaching subscribers) is the bug this closes.
 *
 * Algorithm: strip a trailing "(N min)" time-suffix (USE MELHOR reading-time
 * estimate) and any genuine TRAILING ellipsis (already covered by the sibling
 * check) from the description, then look for any remaining ellipsis
 * occurrence — by construction, anything left over sits in the middle of the
 * sentence, not at the very end.
 */

import { TRAILING_ELLIPSIS_RE } from "../sanitize-description-ellipsis.ts";
import { stripTrailingTimeSuffix } from "./no-trailing-ellipsis.ts"; // #3196: shared w/ fix #2
// #3242: state machine de boundary-parsing extraída pro walker compartilhado
// — ver secondary-item-walker.ts para o histórico de duplicação (#2545,
// #2881, #3196) que motivou a extração.
import { forEachSecondaryItem, type SecondaryItemFound } from "./secondary-item-walker.ts";

/** Any ellipsis run — 2+ ASCII dots or the unicode ellipsis char. */
const ANY_ELLIPSIS_RE = /(?:\.{2,}|…)/u;

export interface MidSentenceEllipsisError {
  section: string;
  /** Linha da descrição (ou do item inline) que contém a reticência no meio. */
  line: number;
  /** Trecho do título do item, para contexto. */
  titleExcerpt: string;
  /** Trecho da descrição (até 100 chars), para contexto. */
  descriptionExcerpt: string;
}

export interface MidSentenceEllipsisReport {
  ok: boolean;
  errors: MidSentenceEllipsisError[];
}

/**
 * Returns true if `description` — after stripping a trailing "(N min)"
 * suffix and any genuine trailing ellipsis — still contains an ellipsis,
 * i.e. one used in the middle of the sentence.
 */
function hasMidSentenceEllipsis(description: string): boolean {
  let text = stripTrailingTimeSuffix(description).trimEnd();
  const trailingMatch = text.match(TRAILING_ELLIPSIS_RE);
  if (trailingMatch && trailingMatch.index !== undefined) {
    text = text.slice(0, trailingMatch.index);
  }
  return ANY_ELLIPSIS_RE.test(text);
}

/**
 * Varre `md` e retorna um erro para cada item de seção secundária cuja
 * descrição contém `…`/`...` no MEIO da frase (não só no fim).
 */
export function checkMidSentenceEllipsis(md: string): MidSentenceEllipsisReport {
  const errors: MidSentenceEllipsisError[] = [];

  forEachSecondaryItem(md, {
    onFound: (item: SecondaryItemFound) => {
      if (hasMidSentenceEllipsis(item.description)) {
        errors.push({
          section: item.section,
          line: item.descriptionLine,
          titleExcerpt: item.title.slice(0, 80),
          descriptionExcerpt: item.description.slice(0, 100),
        });
      }
    },
  });

  return { ok: errors.length === 0, errors };
}
