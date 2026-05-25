import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractEntities,
  detectEntityDuplicates,
  extractPastHighlights,
} from "../scripts/lib/entity-dedup.ts";

describe("extractEntities", () => {
  it("extracts known AI company names", () => {
    const result = extractEntities("OpenAI lanca novo modelo de IA");
    assert.ok(result.companies.includes("openai"));
  });

  it("extracts multiple companies", () => {
    const result = extractEntities("Google e Microsoft disputam mercado de IA");
    assert.ok(result.companies.includes("google"));
    assert.ok(result.companies.includes("microsoft"));
  });

  it("extracts percentages", () => {
    const result = extractEntities("DeepSeek corta 75% do preco da API");
    assert.deepEqual(result.percentages, ["75%"]);
  });

  it("extracts 'por cento' form", () => {
    const result = extractEntities("Reducao de 50 por cento nos custos");
    assert.deepEqual(result.percentages, ["50%"]);
  });

  it("extracts USD monetary values", () => {
    const result = extractEntities("Salesforce gasta $300M em tokens Anthropic");
    assert.ok(result.monetaryValues.some((v) => v.includes("300")));
  });

  it("extracts BRL monetary values", () => {
    const result = extractEntities("Investimento de R$2,5 bilhoes em IA");
    assert.ok(result.monetaryValues.some((v) => v.includes("r$")));
  });

  it("extracts 'bilhoes/milhoes' forms", () => {
    const result = extractEntities("Meta investe 10 bilhoes em infraestrutura");
    assert.ok(result.monetaryValues.some((v) => v.includes("10B")));
  });

  it("extracts model names", () => {
    const result = extractEntities("GPT-4o supera Claude-3.5 em benchmark");
    assert.ok(result.models.length >= 1);
  });

  it("extracts Gemini model variants", () => {
    const result = extractEntities("Gemini Omni lancado no Google I/O");
    assert.ok(result.models.some((m) => m.includes("gemini")));
  });

  it("returns empty for text with no entities", () => {
    const result = extractEntities("Como aprender programacao online");
    assert.equal(result.companies.length, 0);
    assert.equal(result.models.length, 0);
    assert.equal(result.percentages.length, 0);
    assert.equal(result.monetaryValues.length, 0);
  });

  it("does not false-positive on partial company name matches", () => {
    const result = extractEntities("A metalurgia cresce no Brasil");
    // "meta" should not match inside "metalurgia"
    assert.ok(!result.companies.includes("meta"));
  });
});

describe("detectEntityDuplicates", () => {
  it("flags DeepSeek + 75% across different URLs", () => {
    const articles = [
      {
        url: "https://canaltech.com.br/ia-concorrente-gemini-derruba-preco",
        title: "IA concorrente do Gemini derruba preco em 75%",
        summary: "DeepSeek reduz drasticamente o custo da sua API",
      },
    ];
    const pastHighlights = [
      {
        title: "DeepSeek corta 75% do preco da API",
        url: "https://infomoney.com.br/deepseek-corta-preco",
      },
    ];

    const matches = detectEntityDuplicates(articles, pastHighlights);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].url, articles[0].url);
    assert.ok(matches[0].sharedEntities.includes("deepseek"));
    assert.ok(matches[0].sharedEntities.includes("75%"));
  });

  it("does not flag same company but different event (no number match)", () => {
    const articles = [
      {
        url: "https://example.com/openai-new-feature",
        title: "OpenAI lanca novo recurso de busca",
        summary: "Funcionalidade inedita permite pesquisa em tempo real",
      },
    ];
    const pastHighlights = [
      {
        title: "OpenAI contrata 500 engenheiros",
        url: "https://example.com/openai-hiring",
      },
    ];

    const matches = detectEntityDuplicates(articles, pastHighlights);
    assert.equal(matches.length, 0);
  });

  it("does not flag articles with no entity overlap", () => {
    const articles = [
      {
        url: "https://example.com/apple-vision",
        title: "Apple revela Vision Pro 2 com preco de $3500",
        summary: "Novo headset de realidade mista chega ao mercado",
      },
    ];
    const pastHighlights = [
      {
        title: "Google lanca Gemini 3.5 no I/O",
        url: "https://example.com/google-gemini",
      },
    ];

    const matches = detectEntityDuplicates(articles, pastHighlights);
    assert.equal(matches.length, 0);
  });

  it("flags when company + monetary value match", () => {
    const articles = [
      {
        url: "https://source-b.com/salesforce-anthropic",
        title: "Salesforce vai gastar $300M em IA da Anthropic",
        summary: "CEO confirma investimento massivo",
      },
    ];
    const pastHighlights = [
      {
        title: "Salesforce destina $300M para tokens Anthropic",
        url: "https://source-a.com/salesforce-300m",
      },
    ];

    const matches = detectEntityDuplicates(articles, pastHighlights);
    assert.equal(matches.length, 1);
    assert.ok(matches[0].sharedEntities.some((e) => e.includes("salesforce") || e.includes("anthropic")));
  });

  it("does not flag when only percentage matches but no company", () => {
    const articles = [
      {
        url: "https://example.com/random-75",
        title: "Producao agricola cresce 75% no trimestre",
        summary: "Safra recorde impulsiona exportacoes",
      },
    ];
    const pastHighlights = [
      {
        title: "DeepSeek corta 75% do preco da API",
        url: "https://example.com/deepseek-price",
      },
    ];

    const matches = detectEntityDuplicates(articles, pastHighlights);
    assert.equal(matches.length, 0);
  });

  it("handles empty pastHighlights gracefully", () => {
    const articles = [
      {
        url: "https://example.com/article",
        title: "OpenAI reduces prices by 50%",
      },
    ];
    const matches = detectEntityDuplicates(articles, []);
    assert.equal(matches.length, 0);
  });

  it("handles articles with no title or summary", () => {
    const articles = [
      {
        url: "https://example.com/no-title",
      },
    ];
    const pastHighlights = [
      {
        title: "DeepSeek corta 75% do preco",
        url: "https://example.com/past",
      },
    ];
    const matches = detectEntityDuplicates(articles, pastHighlights);
    assert.equal(matches.length, 0);
  });
});

describe("extractPastHighlights", () => {
  const sampleMd = `# Ultimas edicoes publicadas

---

## 2026-05-22 -- "SoberanIA: IA publica nacional"
URL: https://diaria.beehiiv.com/p/soberania

Links usados:
- https://example.com/link1
- https://example.com/link2

---

## 2026-05-21 -- "Google lanca Gemini Omni no Google I/O"
URL: https://diaria.beehiiv.com/p/gemini-omni

Links usados:
- https://example.com/link3

---

## 2026-05-20 -- "Dell e OpenAI levam Codex a ambientes locais"
URL: https://diaria.beehiiv.com/p/dell-openai

Links usados:
- https://example.com/link4
`;

  it("extracts highlights from past-editions.md format", () => {
    const highlights = extractPastHighlights(sampleMd, 3);
    assert.equal(highlights.length, 3);
    assert.equal(highlights[0].title, "SoberanIA: IA publica nacional");
    assert.equal(highlights[1].title, "Google lanca Gemini Omni no Google I/O");
    assert.equal(highlights[2].title, "Dell e OpenAI levam Codex a ambientes locais");
  });

  it("respects window parameter", () => {
    const highlights = extractPastHighlights(sampleMd, 1);
    assert.equal(highlights.length, 1);
    assert.equal(highlights[0].title, "SoberanIA: IA publica nacional");
  });

  it("returns empty for empty markdown", () => {
    const highlights = extractPastHighlights("", 3);
    assert.equal(highlights.length, 0);
  });
});
