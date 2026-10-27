/**
 * daily-carousel-body-size.ts (#11329, item 4)
 *
 * Só a constante, sem import nenhum. Saiu de `daily-carousel-card.ts` (que
 * continua re-exportando) porque o critério do título do card 4x5
 * (`card-title-wrap.ts`) usa o mesmo piso de 62px, e importar
 * `daily-carousel-card.ts` traria o `sharp` (via `weekly-flat-card.ts`) para o
 * lint de título e para o painel de revisão do Studio.
 */

/**
 * Corpo dos slides do carrossel DIÁRIO — tamanho fixo, não auto-size
 * (#6078 item 2, decisão do editor em 24/08/2026).
 *
 * 62px e não 64px por um motivo operacional, não estético: como a saída para
 * o texto que não cabe é REESCREVER o parágrafo, o tamanho da fonte define a
 * frequência com que isso cai no colo do editor. Medido sobre 219 parágrafos
 * reais de d1/d2/d3 em 22 edições (`data/editions/*​/03-social.md`), com o
 * mesmo wrap que o render usa:
 *
 *   | tamanho | teto      | precisariam de reescrita |
 *   |---------|-----------|--------------------------|
 *   | 62px    | 12 linhas | 16 de 219 · 7,3%         |
 *   | 64px    | 11 linhas | 33 de 219 · 15,1%        |
 *   | 72px    | 10 linhas | 84 de 219 · 38,4%        |
 *
 * 60px cabe as mesmas 12 linhas que 62px, então 62 domina (maior pelo mesmo
 * custo). 62px também tem corte previsível — no histórico, tudo até 321
 * caracteres coube e tudo a partir de 327 estourou; em 64px há uma zona
 * cinza de 278–299 onde o resultado depende de quais palavras caem na quebra.
 */
export const DAILY_CAROUSEL_BODY_SIZE = 62;
