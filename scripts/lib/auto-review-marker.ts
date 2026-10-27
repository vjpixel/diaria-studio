/**
 * scripts/lib/auto-review-marker.ts (#11269)
 *
 * Marcador invisível que identifica um comentário inline postado pela
 * automação (self-review do implementador, resposta do dev-fixer), sempre via
 * `scripts/gh-pr-review-api.ts comment|reply`.
 *
 * Por que um marcador e não o autor: as rodadas autônomas postam com o token
 * do dono do repo, então o login do autor é o mesmo do editor e não separa os
 * dois. O passo de resolução pós-fixer do overnight
 * (`scripts/resolve-review-threads.ts` sem `--thread`) só resolve a thread em
 * que TODOS os comentários carregam o marcador: thread aberta pelo editor na UI
 * do GitHub, ou em que ele respondeu, fica aberta e o gate `--check` segura o
 * merge.
 */
export const AUTO_REVIEW_MARKER = "<!-- diaria-auto-review -->";

/** Acrescenta o marcador no fim do corpo (idempotente). */
export function withAutoReviewMarker(body: string): string {
  if (body.includes(AUTO_REVIEW_MARKER)) return body;
  return `${body.replace(/\s+$/, "")}\n\n${AUTO_REVIEW_MARKER}`;
}

/** O comentário foi postado pela automação? */
export function hasAutoReviewMarker(body: unknown): boolean {
  return typeof body === "string" && body.includes(AUTO_REVIEW_MARKER);
}
