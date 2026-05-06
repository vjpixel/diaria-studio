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

  it("B1: legacy com URL bare inline no body — URL canônica do fim ganha", () => {
    // Edge case: layout legacy (URL no fim) onde o LLM/editor deixou uma
    // URL bare em uma linha do body. O parser deve escolher a URL
    // canônica (última depois de "Por que isso importa:"), não a inline.
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título legacy",
      "",
      "Parágrafo do corpo.",
      "",
      "https://midbody.example.com",
      "",
      "Por que isso importa:",
      "Impacto.",
      "",
      "https://canonical.example.com/source",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 1);
    assert.equal(destaques[0].url, "https://canonical.example.com/source");
    // URL inline fica no body (mas NÃO substitui a canônica).
    assert.ok(destaques[0].body.includes("Parágrafo do corpo."));
    assert.equal(destaques[0].why, "Impacto.");
  });

  it("formato #245 double-newline: URL após bloco de título com blank lines", () => {
    // Formato pós-#245: blank line entre header, título, URL, body
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "Título 245",
      "",
      "https://example.com/d1",
      "",
      "Parágrafo 1.",
      "",
      "Parágrafo 2.",
      "",
      "Por que isso importa:",
      "",
      "Impacto.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 1);
    assert.equal(destaques[0].title, "Título 245");
    assert.equal(destaques[0].url, "https://example.com/d1");
    // Body inclui ambos parágrafos
    assert.ok(destaques[0].body.includes("Parágrafo 1."));
    assert.ok(destaques[0].body.includes("Parágrafo 2."));
    // Body NÃO inclui a URL nem "Por que isso importa:"
    assert.ok(!destaques[0].body.includes("https://"));
    assert.ok(!destaques[0].body.includes("Por que isso"));
    assert.equal(destaques[0].why, "Impacto.");
  });

  it("formato #245 pre-gate: 3 opções de título com blank entre cada", () => {
    // Pre-gate: writer emite 3 opções; parser pega a primeira como title.
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "Opção 1 do título",
      "",
      "Opção 2 do título",
      "",
      "Opção 3 do título",
      "",
      "https://example.com/d1",
      "",
      "Corpo do destaque.",
      "",
      "Por que isso importa:",
      "",
      "Impacto.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 1);
    // Parser pega a primeira opção como title (post-gate só tem 1 mesmo)
    assert.equal(destaques[0].title, "Opção 1 do título");
    assert.equal(destaques[0].url, "https://example.com/d1");
    assert.ok(destaques[0].body.includes("Corpo do destaque."));
  });

  it("B1: novo formato — URL inline no body NÃO ganha da canônica do topo", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título novo",
      "https://canonical.example.com/source",
      "",
      "Corpo com URL inline https://midbody.example.com no meio.",
      "",
      "Por que isso importa:",
      "Impacto.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques[0].url, "https://canonical.example.com/source");
    assert.ok(destaques[0].body.includes("URL inline"));
  });

  it("#599: formato inline link `[título](URL)` (post-gate, 1 título)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "[Título único embedado](https://example.com/x)",
      "",
      "Corpo do destaque.",
      "",
      "Por que isso importa:",
      "",
      "Impacto.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 1);
    assert.equal(destaques[0].title, "Título único embedado");
    assert.equal(destaques[0].url, "https://example.com/x");
    assert.equal(destaques[0].body, "Corpo do destaque.");
    assert.equal(destaques[0].why, "Impacto.");
  });

  it("#599: formato inline link com 3 opções pré-gate", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "[Opção 1 do título](https://example.com/x)",
      "",
      "[Opção 2 alternativa](https://example.com/x)",
      "",
      "[Opção 3 mais curta](https://example.com/x)",
      "",
      "Corpo do destaque com várias frases.",
      "",
      "Por que isso importa:",
      "",
      "Impacto editorial.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 1);
    // Parser usa primeira opção como title
    assert.equal(destaques[0].title, "Opção 1 do título");
    assert.equal(destaques[0].url, "https://example.com/x");
    // Body NÃO inclui as outras opções de título
    assert.ok(destaques[0].body.includes("Corpo do destaque"));
    assert.ok(!destaques[0].body.includes("Opção 2"));
    assert.ok(!destaques[0].body.includes("Opção 3"));
  });

  it("#599: 3 destaques em formato inline link", () => {
    const md = [
      "DESTAQUE 1 | LANÇAMENTO",
      "",
      "[Título D1](https://a.com/x)",
      "",
      "Corpo D1.",
      "",
      "Por que isso importa:",
      "",
      "Impacto D1.",
      "",
      "---",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "[Título D2](https://b.com/y)",
      "",
      "Corpo D2.",
      "",
      "Por que isso importa:",
      "",
      "Impacto D2.",
      "",
      "---",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "[Título D3](https://c.com/z)",
      "",
      "Corpo D3.",
      "",
      "Por que isso importa:",
      "",
      "Impacto D3.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 3);
    assert.equal(destaques[0].url, "https://a.com/x");
    assert.equal(destaques[1].url, "https://b.com/y");
    assert.equal(destaques[2].url, "https://c.com/z");
    assert.equal(destaques[0].body, "Corpo D1.");
    assert.equal(destaques[1].body, "Corpo D2.");
    assert.equal(destaques[2].body, "Corpo D3.");
  });

  it("#599: formato legacy (URL solo) ainda funciona — backward compat", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "Título legacy",
      "",
      "https://example.com/legacy",
      "",
      "Corpo legacy.",
      "",
      "Por que isso importa:",
      "",
      "Impacto.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques[0].title, "Título legacy");
    assert.equal(destaques[0].url, "https://example.com/legacy");
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
