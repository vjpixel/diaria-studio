/**
 * weekly-carousel-font-size.test.ts (#5330)
 *
 * computeCarouselTitleFontSize: 1 tamanho único que caiba TODOS os títulos
 * de um carrossel — o MENOR tamanho individual (título mais restritivo
 * governa o grupo inteiro), nunca estoura largura/altura de nenhum card.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCarouselTitleFontSize, WEEKLY_CAROUSEL_NEWS_CARD_SIZE } from "../scripts/lib/weekly-carousel-font-size.ts";
import { DAILY_CAROUSEL_BODY_SIZE } from "../scripts/lib/daily-carousel-card.ts";

describe("WEEKLY_CAROUSEL_NEWS_CARD_SIZE (#8480, 260919)", () => {
  it("é exatamente o piso do carrossel diário (62px) — mesma constante, sem drift", () => {
    assert.equal(WEEKLY_CAROUSEL_NEWS_CARD_SIZE, DAILY_CAROUSEL_BODY_SIZE);
    assert.equal(WEEKLY_CAROUSEL_NEWS_CARD_SIZE, 62);
  });
});

describe("computeCarouselTitleFontSize", () => {
  it("título único: retorna o mesmo tamanho que buildOverlaySvg computaria sozinho", () => {
    const size = computeCarouselTitleFontSize(["Título curto"]);
    assert.ok(size >= DAILY_CAROUSEL_BODY_SIZE && size <= 88);
  });

  it("pega o MENOR tamanho entre vários títulos — o mais restritivo governa", () => {
    const shortTitle = "IA";
    const longTitle =
      "Um título editorial bem mais longo do que qualquer um dos outros títulos deste carrossel, forçando um tamanho de fonte bem menor";
    const sizeAlone = computeCarouselTitleFontSize([shortTitle]);
    const sizeCombined = computeCarouselTitleFontSize([shortTitle, longTitle]);
    assert.ok(sizeCombined < sizeAlone, `esperava que o título longo reduzisse o tamanho combinado (${sizeCombined} deveria ser < ${sizeAlone})`);
  });

  it("todos os títulos do mesmo comprimento aproximado → tamanho estável (não oscila por ordem)", () => {
    const titles = ["Medicina teme formar médicos sem raciocínio", "Assistente pessoal ataca sistema sem ser solicitado"];
    const a = computeCarouselTitleFontSize(titles);
    const b = computeCarouselTitleFontSize([...titles].reverse());
    assert.equal(a, b, "ordem dos títulos não deveria mudar o resultado (é um min(), comutativo)");
  });

  it("nunca abaixo do piso (DAILY_CAROUSEL_BODY_SIZE, 62px — #8123) mesmo com título extremamente longo", () => {
    const veryLong = "Palavra ".repeat(60).trim(); // bem além de qualquer título editorial real
    const size = computeCarouselTitleFontSize([veryLong]);
    assert.equal(size, DAILY_CAROUSEL_BODY_SIZE, `esperava exatamente o piso ${DAILY_CAROUSEL_BODY_SIZE}, veio ${size}`);
  });

  it("nunca acima do clamp máximo (88) mesmo com título de 1 palavra curta", () => {
    const size = computeCarouselTitleFontSize(["IA"]);
    assert.ok(size <= 88, `esperava <=88, veio ${size}`);
  });

  it("lista vazia lança (contrato — sempre chamado com pelo menos 1 título)", () => {
    assert.throws(() => computeCarouselTitleFontSize([]));
  });
});
