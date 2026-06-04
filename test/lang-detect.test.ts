/**
 * lang-detect.test.ts (#1790)
 *
 * Pina o comportamento do looksEnglish canônico (unificou as 2 impls divergentes
 * de categorize.ts e stitch-newsletter.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksEnglish } from "../scripts/lib/lang-detect.ts";

describe("looksEnglish — canônico (#1790)", () => {
  it("texto inglês longo → true", () => {
    assert.ok(
      looksEnglish("A long english description with many of the the common stopwords is are have."),
    );
  });

  it("texto português → false (guard de PT)", () => {
    assert.ok(!looksEnglish("Um guia prático de como criar um agente em português com as novas ferramentas."));
  });

  it("texto curto abaixo de minWords (default 10) → false", () => {
    assert.ok(!looksEnglish("How to build agents"));
  });

  it("minWords:4 permite avaliar títulos curtos", () => {
    assert.ok(looksEnglish("How to build an english agent with the new tools", { minWords: 4 }));
  });

  it("título PT curto com minWords:4 → false (não flaga PT)", () => {
    // 'Como criar um agente em PT' — 'um'/'em' são stop PT → pt ratio alto.
    assert.ok(!looksEnglish("Como criar um agente em PT", { minWords: 4 }));
  });

  it("string vazia → false", () => {
    assert.ok(!looksEnglish(""));
    assert.ok(!looksEnglish("", { minWords: 4 }));
  });

  it("boundary minWords: exatamente no limite avalia; abaixo retorna false", () => {
    // 4 palavras (>1 char): 'these are the tools' → en: these,are,the=3/4=0.75.
    const fourEn = "these are the tools";
    assert.ok(looksEnglish(fourEn, { minWords: 4 }), "4 palavras com minWords:4 avalia");
    assert.ok(!looksEnglish(fourEn, { minWords: 5 }), "abaixo do minWords → false");
    // default minWords:10 rejeita texto de 4 palavras mesmo sendo inglês.
    assert.ok(!looksEnglish(fourEn), "default 10 rejeita texto curto");
    // exatamente 10 palavras com default avalia.
    const tenEn = "these are the new tools that we have for the agents";
    assert.ok(looksEnglish(tenEn), "10 palavras com default avalia");
  });

  it("Unicode-aware: acentos não quebram a tokenização", () => {
    // texto PT com acentos não deve ser flagado como inglês.
    assert.ok(!looksEnglish("A inteligência artificial está transformando a economia e a sociedade brasileira hoje."));
  });
});
