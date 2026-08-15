/**
 * weekly-carousel-font-size.ts (#5330)
 *
 * O clamp dinâmico de `buildOverlaySvg` (44-88px, escalado pelo comprimento
 * de CADA título) é a intenção certa pra uma publicação diária isolada, mas
 * incomoda visualmente quando vários títulos de comprimento bem diferente
 * aparecem lado a lado no MESMO carrossel — achado ao vivo do editor
 * revisando o preview: títulos variaram de 50 a 88px na mesma semana.
 *
 * `computeCarouselTitleFontSize` calcula 1 tamanho ÚNICO que caiba TODOS os
 * títulos do carrossel (os 5 itens de notícia + capa + CTA) — pega o MENOR
 * dos tamanhos individuais computados pela mesma fórmula de
 * `buildOverlaySvg`, garantindo que nenhum título estoura a largura/altura
 * disponível mesmo forçado pro tamanho comum.
 */

import { wrapTitle } from "../gen-social-card-4x5.ts";

const W = 1080;
const PAD = 72; // Idêntico a gen-social-card-4x5.ts/weekly-flat-card.ts.
const MIN_SIZE = 44;
const MAX_SIZE = 88;

/** Pure: mesmo cálculo de `buildOverlaySvg`, mas exposto isoladamente pra reuso aqui. */
function fittingFontSize(title: string): number {
  const available = W - PAD * 2;
  const lines = wrapTitle(title, Math.floor(available / 26));
  const longest = Math.max(...lines.map((l) => l.length));
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.floor(available / (longest * 0.52))));
}

/**
 * Pure: tamanho de fonte único que caiba todos os `titles` — o MENOR entre
 * os tamanhos individuais (o título mais restritivo governa o carrossel
 * inteiro). Lança se `titles` estiver vazio (contrato — sempre chamado com
 * pelo menos capa+CTA, nunca lista vazia por construção do caller).
 */
export function computeCarouselTitleFontSize(titles: string[]): number {
  if (titles.length === 0) {
    throw new Error("computeCarouselTitleFontSize: titles vazio — precisa de pelo menos 1 título");
  }
  return Math.min(...titles.map(fittingFontSize));
}
