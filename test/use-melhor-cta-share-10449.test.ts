/**
 * #10449: slide CTA do carrossel USE MELHOR (4º post) troca "Edição completa no
 * link da bio." por um convite em negrito a compartilhar a dica; D1/D2/D3 e a
 * legenda seguem com `INSTAGRAM_CTA_LINE`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildUseMelhorSlides,
  findOverflowingUseMelhorSlides,
  hashUseMelhorSlides,
  USE_MELHOR_CAROUSEL_CTA_TITLE,
} from "../scripts/lib/use-melhor-carousel.ts";
import {
  buildCarouselSlideTexts,
  splitParagraphIntoTwoBlocks,
  DAILY_CAROUSEL_CTA_KICKER,
} from "../scripts/lib/daily-carousel-card.ts";
import { INSTAGRAM_CTA_LINE, INSTAGRAM_FOLLOW_SENTENCE } from "../scripts/lib/social-cta-lines.ts";
import { measureFlatCardBody } from "../scripts/lib/weekly-flat-card.ts";

const TEXTO_UM = [
  "Um guia prático para planilhas, com o passo a passo.",
  "Como pedir fórmulas ao assistente sem perder tempo.",
  "#InteligenciaArtificial #Planilhas",
].join("\n\n");

describe("#10449 — CTA do carrossel USE MELHOR convida a compartilhar", () => {
  const cta = () => buildUseMelhorSlides(TEXTO_UM, "Guia").at(-1)!;

  it("slide CTA do 4º post difere do slide CTA dos destaques", () => {
    const daily = buildCarouselSlideTexts(TEXTO_UM).cta;
    assert.equal(cta().slot, "cta");
    assert.notEqual(cta().text.title, daily.title);
    // D1/D2/D3 intactos: seguem com INSTAGRAM_CTA_LINE (o que a legenda também usa).
    assert.equal(daily.title, splitParagraphIntoTwoBlocks(INSTAGRAM_CTA_LINE));
    assert.equal(INSTAGRAM_CTA_LINE, "Edição completa no link da bio. Segue @diar.ia.br pra não perder a próxima.");
  });

  it("texto decidido pelo editor: convite em negrito + follow, sem 'link da bio'", () => {
    const title = cta().text.title;
    assert.match(title, /\*\*Essa dica ajuda mais alguém\? Compartilhe!\*\*/);
    assert.ok(title.includes(INSTAGRAM_FOLLOW_SENTENCE));
    assert.doesNotMatch(title, /link da bio/);
    // Negrito vem primeiro, follow depois, em blocos separados (respiro do \n\n).
    assert.equal(title, "**Essa dica ajuda mais alguém? Compartilhe!**\n\nSegue @diar.ia.br pra não perder a próxima.");
    assert.doesNotMatch(title, /[→←]/);
  });

  it("kicker/rodapé/layout continuam os do CTA diário", () => {
    const daily = buildCarouselSlideTexts(TEXTO_UM).cta;
    assert.equal(cta().text.kicker, DAILY_CAROUSEL_CTA_KICKER);
    assert.equal(cta().text.footer, daily.footer);
  });

  it("cabe no card (sem overflow)", () => {
    const m = measureFlatCardBody(cta().text.title, cta().layout);
    assert.equal(m.overflows, false);
    assert.deepEqual(
      findOverflowingUseMelhorSlides(TEXTO_UM, "Guia").filter((o) => o.slot === "cta"),
      [],
    );
  });

  it("override de teste (#8681) continua vencendo, inclusive só o kicker", () => {
    const full = buildUseMelhorSlides(TEXTO_UM, "Guia", { kicker: "TESTE", title: "CTA de teste" }).at(-1)!;
    assert.equal(full.text.title, "CTA de teste");
    assert.equal(full.text.kicker, "TESTE");
    const soKicker = buildUseMelhorSlides(TEXTO_UM, "Guia", { kicker: "" }).at(-1)!;
    assert.equal(soKicker.text.kicker, "");
    assert.equal(soKicker.text.title, USE_MELHOR_CAROUSEL_CTA_TITLE);
  });

  it("carimbo muda com o CTA novo (arte antiga é regerada)", () => {
    const slides = buildUseMelhorSlides(TEXTO_UM, "Guia");
    const antigo = slides.map((s) =>
      s.slot === "cta" ? { ...s, text: buildCarouselSlideTexts("x").cta } : s,
    );
    assert.notEqual(hashUseMelhorSlides(slides), hashUseMelhorSlides(antigo));
  });

  it("corpo vazio continua sem carrossel (nunca só capa + CTA)", () => {
    assert.deepEqual(buildUseMelhorSlides("#SoHashtag", "T"), []);
  });
});
