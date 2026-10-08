/**
 * use-melhor-card-break.ts (#9866)
 *
 * Marcador oficial de "quebra visual dentro do card" no `## um` (4º post,
 * item USE MELHOR). O gerador do carrossel separa cards por LINHA EM BRANCO,
 * então uma linha vazia comum entre dois itens cria card novo. Quando o
 * editor quer 2 itens no MESMO card mas com uma linha em branco entre eles no
 * texto publicado (LinkedIn/Facebook/Instagram/Threads/X), o `## um` usa uma
 * linha contendo só o marcador:
 *
 *   5) **Item cinco** ...
 *   {quebra}
 *   6) **Item seis** ...
 *
 * - Carrossel/lints de forma: a linha some (`stripUseMelhorCardBreaks`) — os
 *   2 itens ficam no mesmo card, que já os separa com respiro próprio.
 * - Publicação: a linha vira linha em branco real (`resolveUseMelhorCardBreaks`),
 *   aplicado por `finalizeUseMelhorPostText` (use-melhor-dispatch.ts) em todo canal.
 *
 * Alias legado: linha só com caractere invisível (U+200B/U+2060/U+FEFF) — o
 * contorno manual da edição 261008 — é tratada como o mesmo marcador, pra não
 * publicar uma linha com caractere invisível.
 *
 * Módulo FOLHA (sem imports) — consumido por use-melhor-carousel.ts,
 * use-melhor-dispatch.ts e social-lint-rules.ts sem risco de ciclo.
 */

export const USE_MELHOR_CARD_BREAK = "{quebra}";

/** Linha inteira = marcador (com espaços em volta) ou só caracteres invisíveis. */
const CARD_BREAK_LINE = /^[ \t]*(?:\{quebra\}|[​⁠﻿]+)[ \t]*$/i;

/** Pure: a linha é um marcador de quebra dentro do card? */
export function isUseMelhorCardBreakLine(line: string): boolean {
  return CARD_BREAK_LINE.test(line.replace(/\r$/, ""));
}

/** Pure: remove as linhas-marcador (carrossel, contagem de chars, lints de forma). */
export function stripUseMelhorCardBreaks(text: string): string {
  return text
    .split("\n")
    .filter((l) => !isUseMelhorCardBreakLine(l))
    .join("\n");
}

/** Pure: troca cada linha-marcador por uma linha em branco (texto publicado). */
export function resolveUseMelhorCardBreaks(text: string): string {
  return text
    .split("\n")
    .map((l) => (isUseMelhorCardBreakLine(l) ? "" : l))
    .join("\n");
}
