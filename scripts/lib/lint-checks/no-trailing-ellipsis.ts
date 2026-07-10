/**
 * lint-checks/no-trailing-ellipsis.ts (#2881)
 *
 * Backstop for `sanitizeTrailingEllipsis` (`scripts/lib/sanitize-description-
 * ellipsis.ts`), which runs at enrich time (Stage 1). Some descriptions
 * escape sanitization entirely — e.g. editor-curated text pasted straight
 * into `02-reviewed.md` after the gate, or a source snippet ingested via a
 * path that doesn't go through `enrich-inbox-articles.ts`. This lint flags
 * (WARN-ONLY, doesn't block the Stage 4 gate) any secondary item
 * (LANÇAMENTOS / RADAR / USE MELHOR / legacy PESQUISAS / OUTRAS NOTÍCIAS)
 * whose description still ends in `…`/`...` — the trailing ellipsis leaks
 * through as if OUR pipeline had cut the sentence mid-way (#2881 sintoma:
 * edição 260703).
 *
 * Two description shapes are checked, mirroring
 * `checkSecondaryItemsHaveSummary`:
 *   - title-only line + description on the NEXT non-empty line;
 *   - canonical USE MELHOR inline shape: `**[Título](URL)** Descrição...`.
 *
 * Only the TRAILING ellipsis is in scope — `…`/`...` used mid-sentence
 * (legitimate) is never flagged — see the sibling `mid-sentence-ellipsis.ts`
 * (#3196) for that backstop instead.
 *
 * #3196: before checking for a trailing ellipsis, a trailing "(N min)"
 * reading-time suffix (USE MELHOR) is stripped first via
 * `stripTrailingTimeSuffix` — otherwise a description like "Então... (5 min)"
 * "ends" in "(5 min)", not "…", and the ellipsis escapes detection.
 *
 * Exit via CLI (`lint-newsletter-md.ts --check no-trailing-ellipsis`):
 *   always 0 (WARN-ONLY, mirrors title-publisher-suffix / title-trailing-
 *   period — #2715) — matches are surfaced as ⚠️, never block the gate.
 */

// Fonte única da regex de reticência final (#2881 self-review) — evita drift
// entre o sanitizador do enrich e este backstop de gate.
import { TRAILING_ELLIPSIS_RE } from "../sanitize-description-ellipsis.ts";
// #3242: state machine de boundary-parsing (target section / encerramento de
// seção / os 2 formatos suportados) extraída pro walker compartilhado — era
// duplicada quase byte-a-byte em 4 lints (secondary-items-have-summary.ts,
// no-trailing-ellipsis.ts, mid-sentence-ellipsis.ts, no-untranslated-summary.ts).
import { forEachSecondaryItem, type SecondaryItemFound } from "./secondary-item-walker.ts";

/**
 * Trailing "(N min)"-style reading-time suffix (USE MELHOR, #2372/#2396/#2450)
 * — auto-injected by `injectAutoTimeEstimate` in `stitch-newsletter.ts`, or
 * written by the editor as the canonical parenthetical form. When present it
 * sits AFTER any ellipsis inherited from the source's own truncated
 * meta-description — "Então... (5 min)" — so a naive end-of-string check on
 * the raw description "ends" in "(5 min)", not "…", and the ellipsis escapes
 * detection (#3196, edição 260709, item USE MELHOR TikTok). Strip it before
 * testing for a trailing ellipsis.
 *
 * Kept narrow (parenthetical shape only) since that's the canonical Stage-4
 * shape — mirrors `USE_MELHOR_TEMPO_RE` (use-melhor-tempo.ts). The dash form
 * (`— 5 min`) is normalized to parens upstream by `normalizeDashToParens`
 * (stitch-newsletter.ts) before Stage 4, so it's out of scope here.
 */
export const TRAILING_TIME_SUFFIX_RE = /\s*\(\s*~?\s*\d+\s*min\b[^)]*\)\s*$/iu;

/** Strips a trailing "(N min)" reading-time suffix, if present. @pure */
export function stripTrailingTimeSuffix(text: string): string {
  return text.replace(TRAILING_TIME_SUFFIX_RE, "");
}

export interface NoTrailingEllipsisError {
  section: string;
  /** Linha da descrição (ou do item inline) que termina em reticências. */
  line: number;
  /** Trecho do título do item, para contexto. */
  titleExcerpt: string;
  /** Trecho final da descrição que disparou o flag. */
  descriptionExcerpt: string;
}

export interface NoTrailingEllipsisReport {
  ok: boolean;
  errors: NoTrailingEllipsisError[];
}

/**
 * Varre `md` e retorna um erro para cada item de seção secundária cuja
 * descrição termina em `…`/`...`.
 */
export function checkNoTrailingEllipsis(md: string): NoTrailingEllipsisReport {
  const errors: NoTrailingEllipsisError[] = [];

  forEachSecondaryItem(md, {
    onFound: (item: SecondaryItemFound) => {
      if (TRAILING_ELLIPSIS_RE.test(stripTrailingTimeSuffix(item.description))) {
        errors.push({
          section: item.section,
          line: item.descriptionLine,
          titleExcerpt: item.title.slice(0, 80),
          descriptionExcerpt: item.description.slice(-40),
        });
      }
    },
  });

  return { ok: errors.length === 0, errors };
}
