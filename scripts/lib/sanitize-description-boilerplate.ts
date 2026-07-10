/**
 * sanitize-description-boilerplate.ts (#3196)
 *
 * Secondary-item descriptions inherited from a source's `og:description`
 * sometimes carry navigation/boilerplate text instead of (or glued onto) the
 * actual summary — the site's `og:description` meta tag is occasionally
 * auto-generated from arbitrary page text (byline dates, "read more"
 * widgets, related-post titles) rather than manually curated. Concrete
 * failure reported in #3196 (edição 260709, USE MELHOR hashtagtreinamentos):
 *
 *   "Existe uma ótima radiografia de… Leia mais: Transição de carreira em
 *    dados no Brasil... Claude Code: Guia Completo para Programar com
 *    IA29 de maio de 2026"
 *
 * Two distinct artifacts in that single string:
 *   (a) "Leia mais:" navigation lead-in followed by unrelated related-post
 *       titles concatenated together — none of it belongs in the summary.
 *   (b) "IA29 de maio de 2026" — a byline date glued directly onto the
 *       preceding acronym with no separating space (lost when the site
 *       squashed its own DOM text into the meta tag).
 *
 * This module strips (a) and best-effort-fixes (b). It does NOT try to
 * recover a "correct" summary when the boilerplate makes up the ENTIRE
 * string — callers should treat a near-empty/dangling result as still
 * possibly no usable description and let `secondary-items-have-summary`
 * (#2545) flag the gap explicitly rather than publish an empty string.
 */

/**
 * Known PT-BR "read more" / "see also" navigation lead-ins. When found, the
 * description is cut BEFORE the phrase — everything from the lead-in onward
 * is unrelated navigation content (related-post titles, category links),
 * never part of the actual summary.
 */
const NAV_LEAD_IN_RE =
  /\b(?:leia\s+mais|leia\s+tamb[ée]m|veja\s+tamb[ée]m|veja\s+mais|saiba\s+mais|continue\s+lendo)\s*:?/iu;

/**
 * Cuts `text` at the first known navigation lead-in phrase (case-insensitive,
 * with or without trailing colon). Text without a lead-in is returned
 * unchanged. @pure
 */
export function stripNavigationBoilerplate(text: string): string {
  if (!text) return text;
  const match = text.match(NAV_LEAD_IN_RE);
  if (!match || match.index === undefined) return text;
  return text.slice(0, match.index).trim();
}

const MONTHS =
  "janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro";

/**
 * Short ALL-CAPS acronym (2-6 letters — "IA", "CEO", "PIB", ...) glued
 * directly to a following full PT-BR date ("29 de maio de 2026") with no
 * separating space. Deliberately narrow — acronym + complete "N de mês de
 * YYYY" date only — to avoid false positives on genuine alphanumeric product
 * names (e.g. "GPT4", "M3") that happen to end a sentence.
 */
const GLUED_ACRONYM_DATE_RE = new RegExp(
  String.raw`\b(\p{Lu}{2,6})(\d{1,2}\s+de\s+(?:${MONTHS})\s+de\s+\d{4})`,
  "giu",
);

/**
 * Inserts the missing space between a glued acronym and a following full
 * date ("IA29 de maio de 2026" → "IA 29 de maio de 2026"). Text without the
 * pattern is returned unchanged. @pure
 */
export function fixGluedAcronymDate(text: string): string {
  if (!text) return text;
  return text.replace(GLUED_ACRONYM_DATE_RE, "$1 $2");
}

/**
 * Combined sanitizer applied to a raw `og:description` before it's stored as
 * an article's `summary`. Order matters: strip navigation boilerplate FIRST
 * — it can remove the very tail where a glued-date artifact would otherwise
 * live (as in the #3196 example above, where the glued date sits inside the
 * "Leia mais:" segment and disappears with the cut) — then fix any remaining
 * glued-acronym-date artifact in what's left. @pure
 */
export function sanitizeDescriptionBoilerplate(text: string): string {
  const stripped = stripNavigationBoilerplate(text);
  return fixGluedAcronymDate(stripped);
}
