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

/**
 * Linha que abre um item da lista numerada do `## um` (`1) ...`, `2. ...`,
 * com ou sem o número em negrito `**3)**`). Formato do social-writer §3c.
 */
const LIST_ITEM_LINE = /^[ \t]*(?:\*\*)?\d{1,2}[).](?:\*\*)?[ \t]/;

/**
 * Pure (#9999): nos canais de TEXTO (LinkedIn página + pessoal, Facebook) cada
 * item da lista numerada sai separado por linha em branco. O agrupamento de
 * 2 itens por parágrafo (#9791) só existe porque cada parágrafo é 1 card do
 * carrossel do Instagram, e lá ele continua (o `03-social.md` não muda).
 * Equivale a o writer ter posto `{quebra}` entre todos os itens do mesmo
 * parágrafo, só que determinístico.
 *
 * Insere uma linha em branco antes de cada item colado (linha anterior
 * não-vazia) num parágrafo que já abriu um item. Idempotente: linha anterior
 * vazia ou marcador `{quebra}` (que `resolveUseMelhorCardBreaks` troca por
 * linha em branco) não ganha outra.
 */
export function separateUseMelhorListItems(text: string): string {
  const out: string[] = [];
  let paragraphHasItem = false;
  for (const line of text.split("\n")) {
    const bare = line.replace(/\r$/, "");
    if (bare.trim() === "" || isUseMelhorCardBreakLine(bare)) {
      out.push(line);
      paragraphHasItem = false;
      continue;
    }
    const isItem = LIST_ITEM_LINE.test(bare);
    if (isItem && paragraphHasItem) out.push("");
    if (isItem) paragraphHasItem = true;
    out.push(line);
  }
  return out.join("\n");
}
