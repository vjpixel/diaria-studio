import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDestaques, buildSubtitle } from "../scripts/extract-destaques.ts";

describe("parseDestaques (#172)", () => {
  it("parseia formato novo: URL imediatamente abaixo do título", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título escolhido d1",
      "https://example.com/d1",
      "",
      "Parágrafo 1 do corpo.",
      "",
      "Parágrafo 2 do corpo.",
      "",
      "Por que isso importa:",
      "Impacto prático.",
      "",
      "---",
      "DESTAQUE 2 | PESQUISA",
      "Título d2",
      "https://example.com/d2",
      "",
      "Corpo d2.",
      "",
      "Por que isso importa:",
      "Impacto d2.",
      "",
      "---",
      "DESTAQUE 3 | MERCADO",
      "Título d3",
      "https://example.com/d3",
      "",
      "Corpo d3.",
      "",
      "Por que isso importa:",
      "Impacto d3.",
    ].join("\n");

    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 3);
    assert.equal(destaques[0].n, 1);
    assert.equal(destaques[0].title, "Título escolhido d1");
    assert.equal(destaques[0].url, "https://example.com/d1");
    assert.equal(destaques[0].body, "Parágrafo 1 do corpo.\n\nParágrafo 2 do corpo.");
    assert.equal(destaques[0].why, "Impacto prático.");
    assert.equal(destaques[1].title, "Título d2");
    assert.equal(destaques[1].url, "https://example.com/d2");
    assert.equal(destaques[2].title, "Título d3");
    assert.equal(destaques[2].url, "https://example.com/d3");
  });

  it("parseia formato legacy: URL no fim do bloco (compat)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título d1",
      "",
      "Corpo d1.",
      "",
      "Por que isso importa:",
      "Impacto d1.",
      "",
      "https://example.com/d1",
      "",
      "---",
      "DESTAQUE 2 | PESQUISA",
      "Título d2",
      "",
      "Corpo d2.",
      "",
      "https://example.com/d2",
      "",
      "---",
      "DESTAQUE 3 | MERCADO",
      "Título d3",
      "",
      "Corpo d3.",
      "",
      "https://example.com/d3",
    ].join("\n");

    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 3);
    assert.equal(destaques[0].title, "Título d1");
    assert.equal(destaques[0].url, "https://example.com/d1");
    assert.equal(destaques[0].body, "Corpo d1.");
    assert.equal(destaques[0].why, "Impacto d1.");
    assert.equal(destaques[1].title, "Título d2");
    assert.equal(destaques[1].url, "https://example.com/d2");
    assert.equal(destaques[1].why, "");
    assert.equal(destaques[2].url, "https://example.com/d3");
  });

  it("destaque sem URL → url vazia", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título sem URL",
      "",
      "Corpo.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 1);
    assert.equal(destaques[0].url, "");
  });

  it("body em formato novo NÃO inclui a URL", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "https://example.com/x",
      "",
      "Parágrafo 1.",
      "",
      "Parágrafo 2.",
      "",
      "Por que isso importa:",
      "Impacto.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques[0].url, "https://example.com/x");
    assert.ok(!destaques[0].body.includes("https://example.com/x"));
    assert.equal(destaques[0].body, "Parágrafo 1.\n\nParágrafo 2.");
    assert.equal(destaques[0].why, "Impacto.");
  });
});

describe("buildSubtitle", () => {
  it("junta d2 e d3 quando cabem em 80 chars", () => {
    const r = buildSubtitle("Título curto 2", "Título curto 3");
    assert.equal(r, "Título curto 2 | Título curto 3");
  });

  it("usa só d2 quando combinado passa de 80 chars", () => {
    const long2 = "Um título mais longo que tem várias palavras";
    const long3 = "Outro título também longo com palavras";
    const r = buildSubtitle(long2, long3);
    // Combinado: 44 + 3 + 38 = 85 → trunca pra só d2
    if ((`${long2} | ${long3}`).length > 80) {
      assert.equal(r, long2);
    }
  });
});
