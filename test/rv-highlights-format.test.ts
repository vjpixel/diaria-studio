/**
 * test/rv-highlights-format.test.ts (#6447 Fatia 2)
 *
 * Testa a formatação/lógica PURA (sem DOM) do painel "Editor por destaque" —
 * `scripts/studio-ui/public/rv-highlights-format.js` — mesmo padrão de
 * `test/rv-gate-format.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  graphemeLength,
  isTitleTooLong,
  formatTitleCharCount,
  resolveFinalTitle,
  buildHighlightSavePayload,
} from "../scripts/studio-ui/public/rv-highlights-format.js";

describe("graphemeLength", () => {
  it("conta emoji de bandeira como 1 grafema, não 4 code units", () => {
    assert.equal(graphemeLength("🇧🇷 Brasil"), 8); // 🇧🇷 + espaço + "Brasil" (6) = 1+1+6
  });

  it("string vazia -> 0", () => {
    assert.equal(graphemeLength(""), 0);
  });
});

describe("isTitleTooLong / formatTitleCharCount", () => {
  it("título dentro do limite -> não estoura, contador correto", () => {
    const title = "Título curto";
    assert.equal(isTitleTooLong(title, 52), false);
    assert.equal(formatTitleCharCount(title, 52), `${title.length}/52`);
  });

  it("título acima do limite -> estoura", () => {
    const longTitle = "x".repeat(60);
    assert.equal(isTitleTooLong(longTitle, 52), true);
    assert.equal(formatTitleCharCount(longTitle, 52), "60/52");
  });

  it("título nulo/undefined não lança — trata como vazio", () => {
    assert.equal(isTitleTooLong(undefined, 52), false);
    assert.equal(formatTitleCharCount(null, 52), "0/52");
  });
});

describe("resolveFinalTitle", () => {
  it("campo livre vazio -> usa a opção selecionada", () => {
    assert.equal(resolveFinalTitle("Opção 2", ""), "Opção 2");
    assert.equal(resolveFinalTitle("Opção 2", "   "), "Opção 2");
  });

  it("campo livre preenchido -> vence sobre a opção selecionada", () => {
    assert.equal(resolveFinalTitle("Opção 2", "Título reescrito à mão"), "Título reescrito à mão");
  });
});

describe("buildHighlightSavePayload", () => {
  it("monta o payload com trim + filtra parágrafos vazios", () => {
    const payload = buildHighlightSavePayload({
      title: "  Título final  ",
      url: " https://example.com ",
      bodyParagraphs: ["Parágrafo 1", "  ", "", "Parágrafo 2  "],
      whyMatters: "  Impacto.  ",
      expectedModifiedAt: "2026-08-28T00:00:00.000Z",
    });
    assert.deepEqual(payload, {
      title: "Título final",
      url: "https://example.com",
      body: ["Parágrafo 1", "Parágrafo 2"],
      whyMatters: "Impacto.",
      expectedModifiedAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("expectedModifiedAt ausente vira null", () => {
    const payload = buildHighlightSavePayload({
      title: "t",
      url: "u",
      bodyParagraphs: ["p"],
      whyMatters: "w",
    });
    assert.equal(payload.expectedModifiedAt, null);
  });
});
