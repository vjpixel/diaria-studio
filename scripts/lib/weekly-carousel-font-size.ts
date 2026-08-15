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
 * títulos do carrossel — pega o MENOR dos tamanhos individuais computados
 * pela MESMA fórmula de `buildOverlaySvg` (reusada via
 * `overlayFittingFontSize`, exportada — #5330 fleet review: uma cópia
 * própria dos números mágicos aqui já causou 1 bug real de drift, PR #5335),
 * garantindo que nenhum título estoura a largura/altura disponível mesmo
 * forçado pro tamanho comum.
 */

import { overlayFittingFontSize } from "../gen-social-card-4x5.ts";

const W = 1080;
const PAD = 72; // Idêntico a gen-social-card-4x5.ts/weekly-flat-card.ts.

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
  const available = W - PAD * 2;
  return Math.min(...titles.map((t) => overlayFittingFontSize(t, available)));
}
