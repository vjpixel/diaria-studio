/**
 * review-highlight-source.test.ts (#1699)
 *
 * Regressão: o RTX Spark da NVIDIA (260602) virou destaque com link da Canaltech
 * (cobertura de imprensa); a regra #160 só cobria a seção LANÇAMENTOS, então o
 * destaque escapava. O guard deve flagá-lo (warn) e sugerir a fonte oficial.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewHighlightSource } from "../scripts/review-highlight-source.ts";

describe("reviewHighlightSource — destaque lançamento com URL de imprensa (#1699)", () => {
  it("flaga o RTX Spark com link Canaltech (caso 260602) e sugere a NVIDIA", () => {
    const highlights = [
      {
        score: 90,
        rank: 1,
        article: {
          title: "NVIDIA lança o RTX Spark, novo PC de IA para desktop",
          url: "https://canaltech.com.br/hardware/nvidia-rtx-spark/",
          summary: "A NVIDIA anunciou nesta terça o RTX Spark.",
        },
      },
    ];
    const { flagged, total } = reviewHighlightSource(highlights);
    assert.equal(total, 1);
    assert.equal(flagged.length, 1, "destaque-lançamento com URL de imprensa deve ser flagado");
    assert.match(flagged[0].url, /canaltech/);
    assert.ok(flagged[0].suggested_domain, "deve sugerir a fonte oficial");
  });

  it("NÃO flaga destaque-lançamento que JÁ usa domínio oficial", () => {
    const highlights = [
      {
        article: {
          title: "OpenAI lança o GPT-5",
          url: "https://openai.com/index/gpt-5",
          summary: "Novo modelo.",
        },
      },
    ];
    const { flagged } = reviewHighlightSource(highlights);
    assert.equal(flagged.length, 0, "URL oficial → não flaga");
  });

  it("NÃO flaga destaque que não é lançamento (sem verbo de anúncio)", () => {
    const highlights = [
      {
        article: {
          title: "Como a IA está mudando o mercado de trabalho",
          url: "https://canaltech.com.br/mercado/ia-trabalho/",
          summary: "Análise.",
        },
      },
    ];
    const { flagged } = reviewHighlightSource(highlights);
    assert.equal(flagged.length, 0, "não é launch-candidate → não flaga");
  });

  it("tolera shape sem wrapper { article } (artigo direto)", () => {
    const highlights = [
      { title: "Google lança o Gemini 3", url: "https://techcrunch.com/gemini-3", summary: "..." },
    ];
    const { flagged } = reviewHighlightSource(highlights as never);
    assert.equal(flagged.length, 1);
  });

  it("ignora highlights sem url; conta total corretamente", () => {
    const highlights = [
      { article: { title: "sem url" } },
      { article: { title: "OpenAI lança GPT-5", url: "https://openai.com/index/gpt-5" } },
    ];
    const { total, flagged } = reviewHighlightSource(highlights);
    assert.equal(total, 2);
    assert.equal(flagged.length, 0);
  });
});
