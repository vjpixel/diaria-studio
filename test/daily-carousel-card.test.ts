/**
 * daily-carousel-card.test.ts (#6005 Parte B)
 *
 * Cobre o miolo PURE de `scripts/lib/daily-carousel-card.ts`:
 *   - splitIntoParagraphCards: 1:1 no caso comum, resiliente a desvio.
 *   - buildCarouselSlideTexts: 3 parágrafos + CTA, kicker de posição.
 *   - resolveCarouselImageUrls: tudo-ou-nada (qualquer slide ausente -> null).
 *
 * `renderCarouselSlides` (chama sharp de verdade via `renderFlatCard`) não é
 * exercitado aqui — mesma disciplina de `weekly-flat-card.test.ts`, que só
 * testa o SVG puro (`buildFlatCardSvg`) e o cache, nunca o render real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitIntoParagraphCards,
  buildCarouselSlideTexts,
  carouselSlideFilename,
  carouselImageKeys,
  resolveCarouselImageUrls,
  CAROUSEL_SLIDE_SLOTS,
} from "../scripts/lib/daily-carousel-card.ts";
import { INSTAGRAM_CTA_LINE } from "../scripts/lib/social-cta-lines.ts";

describe("splitIntoParagraphCards (pure)", () => {
  it("caso comum: exatamente 3 parágrafos (separados por linha em branco) -> passthrough 1:1", () => {
    const body = "Primeiro parágrafo aqui.\n\nSegundo parágrafo aqui.\n\nTerceiro parágrafo aqui.";
    const result = splitIntoParagraphCards(body, 3);
    assert.deepEqual(result, ["Primeiro parágrafo aqui.", "Segundo parágrafo aqui.", "Terceiro parágrafo aqui."]);
  });

  it("normaliza espaços internos (quebras de linha simples dentro de um parágrafo viram espaço)", () => {
    const body = "Linha 1\nLinha 2 do mesmo parágrafo.\n\nSegundo.\n\nTerceiro.";
    const result = splitIntoParagraphCards(body, 3);
    assert.equal(result[0], "Linha 1 Linha 2 do mesmo parágrafo.");
  });

  it("MAIS parágrafos que o alvo: mantém os primeiros N-1, funde o resto no último (nunca descarta conteúdo)", () => {
    const body = "Um.\n\nDois.\n\nTrês.\n\nQuatro.";
    const result = splitIntoParagraphCards(body, 3);
    assert.equal(result.length, 3);
    assert.deepEqual(result.slice(0, 2), ["Um.", "Dois."]);
    assert.equal(result[2], "Três. Quatro.");
  });

  it("MENOS parágrafos que o alvo: divide o mais longo em sentenças até atingir o alvo", () => {
    const body = "Curto.\n\nEste é um parágrafo bem mais longo. Tem duas frases claras. Devia dar pra dividir.";
    const result = splitIntoParagraphCards(body, 3);
    assert.equal(result.length, 3);
    assert.equal(result[0], "Curto.");
  });

  it("texto de 1 frase só (não dá pra dividir mais): retorna menos que o alvo, nunca lança", () => {
    const body = "Uma frase única sem mais nada.";
    const result = splitIntoParagraphCards(body, 3);
    assert.ok(result.length >= 1 && result.length < 3);
  });

  it("corpo vazio -> array vazio", () => {
    assert.deepEqual(splitIntoParagraphCards("", 3), []);
  });
});

describe("buildCarouselSlideTexts (pure)", () => {
  it("produz p1/p2/p3 (kicker de posição) + cta (INSTAGRAM_CTA_LINE)", () => {
    const genericText = "Um.\n\nDois.\n\nTrês.\n\n#InteligenciaArtificial #Agentes";
    const texts = buildCarouselSlideTexts(genericText);
    assert.equal(texts.p1.title, "Um.");
    assert.equal(texts.p2.title, "Dois.");
    assert.equal(texts.p3.title, "Três.");
    assert.equal(texts.p1.kicker, "01 / 03");
    assert.equal(texts.p3.kicker, "03 / 03");
    assert.equal(texts.cta.title, INSTAGRAM_CTA_LINE);
    for (const slot of CAROUSEL_SLIDE_SLOTS) assert.equal(texts[slot].footer, "diar.ia.br");
  });

  it("remove o bloco de hashtags antes de dividir em parágrafos (splitBodyAndTags)", () => {
    const genericText = "Um.\n\nDois.\n\nTrês.\n\n#Tag1 #Tag2 #Tag3";
    const texts = buildCarouselSlideTexts(genericText);
    for (const slot of ["p1", "p2", "p3"] as const) {
      assert.doesNotMatch(texts[slot].title, /#Tag/);
    }
  });
});

describe("carouselSlideFilename / carouselImageKeys (pure)", () => {
  it("nomes de arquivo seguem a convenção 04-{destaque}-carousel-{slot}-4x5.jpg", () => {
    assert.equal(carouselSlideFilename("d1", "p1"), "04-d1-carousel-p1-4x5.jpg");
    assert.equal(carouselSlideFilename("d2", "cta"), "04-d2-carousel-cta-4x5.jpg");
  });

  it("chaves de 06-public-images.json seguem {destaque}_carousel_{slot}, capa reusa {destaque}_4x5", () => {
    const { cover, slides } = carouselImageKeys("d3");
    assert.equal(cover, "d3_4x5");
    assert.equal(slides.p1, "d3_carousel_p1");
    assert.equal(slides.cta, "d3_carousel_cta");
  });
});

describe("resolveCarouselImageUrls (pure) — tudo-ou-nada", () => {
  const fullImages = {
    d1_4x5: { url: "https://x/cover" },
    d1_carousel_p1: { url: "https://x/p1" },
    d1_carousel_p2: { url: "https://x/p2" },
    d1_carousel_p3: { url: "https://x/p3" },
    d1_carousel_cta: { url: "https://x/cta" },
  };

  it("todos os 5 presentes -> array ordenado [capa, p1, p2, p3, cta]", () => {
    const urls = resolveCarouselImageUrls(fullImages, "d1");
    assert.deepEqual(urls, ["https://x/cover", "https://x/p1", "https://x/p2", "https://x/p3", "https://x/cta"]);
  });

  it("capa ausente -> null (fallback pro single-image)", () => {
    const { d1_4x5, ...rest } = fullImages;
    assert.equal(resolveCarouselImageUrls(rest, "d1"), null);
  });

  it("1 slide de parágrafo ausente -> null (nunca publica carrossel incompleto)", () => {
    const { d1_carousel_p2, ...rest } = fullImages;
    assert.equal(resolveCarouselImageUrls(rest, "d1"), null);
  });

  it("CTA ausente -> null", () => {
    const { d1_carousel_cta, ...rest } = fullImages;
    assert.equal(resolveCarouselImageUrls(rest, "d1"), null);
  });

  it("images undefined -> null", () => {
    assert.equal(resolveCarouselImageUrls(undefined, "d1"), null);
  });

  it("destaque sem nenhuma entry (edição sem carrossel) -> null", () => {
    assert.equal(resolveCarouselImageUrls(fullImages, "d2"), null);
  });
});
