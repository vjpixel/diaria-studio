/**
 * sanitize-description-ellipsis.ts (#2881)
 *
 * Secondary items (RADAR / USE MELHOR / LANÇAMENTOS) inherit their
 * description verbatim from the source's snippet / meta-description. Many
 * outlets truncate their OWN meta-description with an ellipsis (`…` or
 * `...`), and that ellipsis then leaks into the final email — reading as if
 * OUR pipeline had cut the sentence mid-way. It is not our truncation, it's
 * the source's.
 *
 * `sanitizeTrailingEllipsis` strips a TRAILING ellipsis only:
 *   (a) if there is an earlier complete sentence end inside the remaining
 *       text, cut back to it ("Empresa fechou parceria. Além disso, planeja
 *       expandir para outros mercados…" → "Empresa fechou parceria.");
 *   (b) if what remains after removing the ellipsis is ALREADY a complete
 *       sentence (ends in `.`/`!`/`?`), just drop the ellipsis marker;
 *   (c) otherwise (single truncated sentence, no earlier boundary), strip
 *       just the trailing ellipsis marker as a best effort — never publish a
 *       description ending in `…`/`...`.
 *
 * Ellipsis used in the MIDDLE of a sentence (legitimate — e.g. "e por
 * aí… ninguém esperava o que veio a seguir") is left completely untouched;
 * only a TRAILING ellipsis is in scope.
 *
 * Convention: 2+ consecutive ASCII dots count as an ellipsis (mirrors
 * `stripTrailingPeriod` / `checkTitleTrailingPeriod` in
 * `strip-publisher-suffix.ts` / `title-normalization.ts`, which also treat
 * `\.{2,}` as "ellipsis, don't touch/strip-differently").
 */

/** Trailing ellipsis: 2+ ASCII dots or the unicode ellipsis char (…), with optional trailing whitespace. */
const TRAILING_ELLIPSIS_RE = /(?:\.{2,}|…)\s*$/u;

/** Sentence-ending punctuation followed by whitespace (not decimal points / abbreviations glued to the next word). */
const SENTENCE_END_RE = /[.!?](?=\s)/g;

function findLastSentenceEndIndex(text: string): number {
  let lastIndex = -1;
  const re = new RegExp(SENTENCE_END_RE.source, SENTENCE_END_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    lastIndex = match.index;
  }
  return lastIndex;
}

/**
 * Removes a trailing ellipsis from `text`, preferring to cut back to the
 * last complete sentence end when the truncated tail carries no useful
 * content on its own. Text without a trailing ellipsis is returned
 * unchanged (including ellipsis used mid-sentence).
 *
 * @pure
 */
export function sanitizeTrailingEllipsis(text: string): string {
  if (!text) return text;

  const trailingMatch = text.match(TRAILING_ELLIPSIS_RE);
  if (!trailingMatch || trailingMatch.index === undefined) {
    return text; // no trailing ellipsis — untouched (covers mid-sentence `…` too)
  }

  const withoutEllipsis = text.slice(0, trailingMatch.index).trimEnd();
  if (!withoutEllipsis) return text; // nothing sensible left — bail out, keep original

  // (b) remaining text is already a complete sentence — just drop the ellipsis.
  if (/[.!?]$/.test(withoutEllipsis)) {
    return withoutEllipsis;
  }

  // (a) cut back to the last complete sentence end before the truncated tail.
  const lastSentenceEnd = findLastSentenceEndIndex(withoutEllipsis);
  if (lastSentenceEnd !== -1) {
    return withoutEllipsis.slice(0, lastSentenceEnd + 1).trimEnd();
  }

  // (c) no earlier sentence boundary — best effort: strip just the ellipsis.
  return withoutEllipsis;
}
