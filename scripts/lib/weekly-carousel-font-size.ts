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

import { overlayFittingFontSize, type OverlayWrap } from "../gen-social-card-4x5.ts";

const W = 1080;
const PAD = 72; // Idêntico a gen-social-card-4x5.ts/weekly-flat-card.ts.

/**
 * Tamanho FIXO dos cards internos (com foto) do carrossel semanal (#8480,
 * 260919) — decisão do editor: parar de calcular, a cada rodada, o menor
 * tamanho que caiba TODOS os títulos daquela semana (`computeCarouselTitleFontSize`,
 * que oscilava 62-88 conforme o conjunto de itens selecionados) e usar sempre
 * o mesmo valor, igual ao corpo fixo do carrossel diário (`DAILY_CAROUSEL_BODY_SIZE`
 * em `daily-carousel-card.ts`) — mesma métrica em toda parte, texto que não
 * couber é reescrito/substituído, nunca encolhido. `computeCarouselTitleFontSize`
 * continua existindo (função pura, testada) só deixou de ser o caminho padrão
 * em `publish-weekly-social.ts` — `--force-font-size` segue como único jeito
 * manual de sair de 62.
 *
 * Valor LITERAL, não importado de `daily-carousel-card.ts`, de propósito:
 * `daily-carousel-card.ts` importa de `weekly-flat-card.ts`, que importa de
 * `gen-social-card-4x5.ts`, que importa deste arquivo
 * (`computeCarouselTitleFontSize`) — um `import { DAILY_CAROUSEL_BODY_SIZE }`
 * aqui fecha um ciclo de módulos ESM e quebra em runtime com `ReferenceError:
 * Cannot access 'DAILY_CAROUSEL_BODY_SIZE' before initialization` (TDZ,
 * achado ao vivo no CI da PR #8494). Os dois valores são mantidos iguais por
 * convenção documentada, não por import compartilhado — mudar um exige
 * lembrar do outro (sem guard mecânico; `test/weekly-carousel-font-size.test.ts`
 * importa `DAILY_CAROUSEL_BODY_SIZE` só no teste, onde o ciclo não existe).
 */
export const WEEKLY_CAROUSEL_NEWS_CARD_SIZE = 62;

/**
 * Pure: tamanho de fonte único que caiba todos os `titles` — o MENOR entre
 * os tamanhos individuais (o título mais restritivo governa o carrossel
 * inteiro). Lança se `titles` estiver vazio (contrato — sempre chamado com
 * pelo menos capa+CTA, nunca lista vazia por construção do caller).
 *
 * `wrap` (#8485, `WEEKLY_OVERLAY_WRAP` de `gen-social-card-4x5.ts`) precisa
 * ser o MESMO que `buildOverlaySvg` usa pra renderizar — hoje só chega aqui
 * via `--force-font-size` em `publish-weekly-social.ts` (o piso fixo acima,
 * `WEEKLY_CAROUSEL_NEWS_CARD_SIZE`, ignora este cálculo por padrão); se o
 * `wrap` passado aqui divergir do usado no render, o tamanho calculado não
 * bate com o que sai na tela (mesma lição do #5335 citada no topo do
 * arquivo).
 */
export function computeCarouselTitleFontSize(titles: string[], wrap?: OverlayWrap): number {
  if (titles.length === 0) {
    throw new Error("computeCarouselTitleFontSize: titles vazio — precisa de pelo menos 1 título");
  }
  const available = W - PAD * 2;
  return Math.min(...titles.map((t) => overlayFittingFontSize(t, available, wrap)));
}
