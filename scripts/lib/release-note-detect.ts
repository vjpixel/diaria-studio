/**
 * release-note-detect.ts
 *
 * Regex compartilhada para detectar "New X in Y" (dev release note / feature
 * announcement) em títulos de artigos.
 *
 * Extraída de categorize.ts → lib para evitar duplicação com
 * use-melhor-curation.ts (que não pode importar categorize.ts devido a
 * dependência circular: categorize.ts importa use-melhor-curation.ts).
 *
 * #2469 (finding 4): garantia de lockstep — uma única fonte de verdade.
 */

/**
 * Casa títulos do padrão "New <feature> in <platform/language>".
 * Âncora no início (`^\s*New\s+`) para não casar:
 *   - "What's new in X"
 *   - "How to use new features in Y" (isTutorialByKeyword retorna antes)
 * Requer "in" como separador seguido de ≥1 palavra para evitar "New to Python?"
 * (interrogativo, não announcement).
 */
export const DEV_RELEASE_NOTE_TITLE_RE =
  /^\s*New\s+\w[\w\s]{2,40}\s+in\s+(?:the\s+)?\w/i;

/**
 * Retorna true se o título parece release note de dev ("New X in Y").
 */
export function isDevReleaseNote(title: string): boolean {
  return DEV_RELEASE_NOTE_TITLE_RE.test(title);
}
