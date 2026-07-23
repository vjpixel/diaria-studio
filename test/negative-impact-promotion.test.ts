/**
 * test/negative-impact-promotion.test.ts (#3916, #3918)
 *
 * Testa o backstop determinístico que garante ≥1 destaque com
 * `negative_impact:true` mesmo quando o scorer-select (LLM) não cumpriu a
 * regra sozinho. Função pura — sem I/O, sem mock de agent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ensureNegativeImpactHighlight,
  hasNegativeImpactTag,
  type FinalistLike,
  type HighlightLike,
} from "../scripts/lib/negative-impact-promotion.ts";

describe("hasNegativeImpactTag", () => {
  it("true quando top-level negative_impact:true", () => {
    assert.equal(hasNegativeImpactTag({ negative_impact: true }), true);
  });
  it("true quando article.negative_impact:true (nested)", () => {
    assert.equal(hasNegativeImpactTag({ article: { negative_impact: true } }), true);
  });
  it("false quando ausente em ambos", () => {
    assert.equal(hasNegativeImpactTag({}), false);
  });
  it("false quando explicitamente false", () => {
    assert.equal(hasNegativeImpactTag({ negative_impact: false, article: { negative_impact: false } }), false);
  });
});

describe("ensureNegativeImpactHighlight (#3916, #3918)", () => {
  const finalists: FinalistLike[] = [
    { url: "https://d1.com", score: 95, bucket: "lancamento", article: { url: "https://d1.com", title: "Lançamento X" } },
    { url: "https://d2.com", score: 88, bucket: "radar", article: { url: "https://d2.com", title: "Notícia Y" } },
    { url: "https://harm-high.com", score: 82, bucket: "radar", article: { url: "https://harm-high.com", title: "Empresa demite citando IA", negative_impact: true } },
    { url: "https://harm-low.com", score: 60, bucket: "radar", article: { url: "https://harm-low.com", title: "Golpe com deepfake", negative_impact: true } },
    { url: "https://d3.com", score: 70, bucket: "radar", article: { url: "https://d3.com", title: "Notícia Z" } },
  ];

  it("no-op quando já existe ≥1 highlight tagueado (top-level)", () => {
    const highlights: HighlightLike[] = [
      { url: "https://d1.com", score: 95, negative_impact: true },
      { url: "https://d2.com", score: 88 },
    ];
    const result = ensureNegativeImpactHighlight(highlights, finalists);
    assert.equal(result.promotion, undefined);
    assert.deepEqual(result.highlights, highlights);
  });

  it("no-op quando já existe ≥1 highlight tagueado (nested article)", () => {
    const highlights: HighlightLike[] = [
      { url: "https://d1.com", score: 95, article: { url: "https://d1.com", negative_impact: true } },
    ];
    const result = ensureNegativeImpactHighlight(highlights, finalists);
    assert.equal(result.promotion, undefined);
  });

  it("no-op quando highlights vazio (defensivo)", () => {
    const result = ensureNegativeImpactHighlight([], finalists);
    assert.equal(result.promotion, undefined);
    assert.deepEqual(result.highlights, []);
  });

  it("no-op quando nenhum finalista tem a tag (pool sem candidato digno, #3918)", () => {
    const highlights: HighlightLike[] = [{ url: "https://d1.com", score: 95 }];
    const finalistsNoTag: FinalistLike[] = [
      { url: "https://d1.com", score: 95, article: { url: "https://d1.com" } },
      { url: "https://d2.com", score: 80, article: { url: "https://d2.com" } },
    ];
    const result = ensureNegativeImpactHighlight(highlights, finalistsNoTag);
    assert.equal(result.promotion, undefined);
    assert.deepEqual(result.highlights, highlights);
  });

  it("promove o finalista tagueado de MAIOR score quando nenhum highlight tem a tag", () => {
    const highlights: HighlightLike[] = [
      { url: "https://d1.com", score: 95 },
      { url: "https://d2.com", score: 88 },
      { url: "https://d3.com", score: 70 },
    ];
    const result = ensureNegativeImpactHighlight(highlights, finalists);
    assert.ok(result.promotion, "esperava promoção");
    assert.equal(result.promotion!.promoted_url, "https://harm-high.com", "deve escolher o maior score entre os tagueados (82 > 60)");
  });

  it("NUNCA demove o destaque de MAIOR score (D1) — troca sempre o de MENOR score", () => {
    const highlights: HighlightLike[] = [
      { url: "https://d1.com", score: 95 }, // maior score — nunca deve ser demovido
      { url: "https://d2.com", score: 88 },
      { url: "https://d3.com", score: 70 }, // menor score — deve ser demovido
    ];
    const result = ensureNegativeImpactHighlight(highlights, finalists);
    assert.equal(result.promotion!.demoted_url, "https://d3.com");
    // d1 e d2 permanecem intactos na posição original
    assert.equal(result.highlights[0].url, "https://d1.com");
    assert.equal(result.highlights[1].url, "https://d2.com");
    // d3 foi substituído pelo candidato promovido
    assert.equal(result.highlights[2].url, "https://harm-high.com");
    assert.equal(result.highlights[2].article?.negative_impact, true);
  });

  it("preserva o rank/posição do destaque demovido (troca de conteúdo, não de posição)", () => {
    const highlights: HighlightLike[] = [
      { rank: 1, url: "https://d1.com", score: 95 },
      { rank: 2, url: "https://d3.com", score: 70 }, // menor score, no meio do array
      { rank: 3, url: "https://d2.com", score: 88 },
    ];
    const result = ensureNegativeImpactHighlight(highlights, finalists);
    assert.equal(result.highlights[1].rank, 2, "rank da posição é preservado");
    assert.equal(result.highlights[1].url, "https://harm-high.com");
  });

  it("nunca promove um candidato que já está entre os highlights (evita duplicata)", () => {
    // harm-high já é um highlight (mas SEM a tag setada no highlight em si —
    // simula divergência article vs highlight); harm-low é o único candidato
    // elegível restante.
    const highlights: HighlightLike[] = [
      { url: "https://harm-high.com", score: 82 }, // já selecionado, mas sem tag aqui
      { url: "https://d2.com", score: 88 },
    ];
    const result = ensureNegativeImpactHighlight(highlights, finalists);
    assert.ok(result.promotion);
    assert.equal(result.promotion!.promoted_url, "https://harm-low.com", "harm-high já está nos highlights — não pode ser 'promovido' de novo");
  });

  it("mensagem de promoção referencia #3916/#3918", () => {
    const highlights: HighlightLike[] = [{ url: "https://d1.com", score: 95 }];
    const result = ensureNegativeImpactHighlight(highlights, finalists);
    assert.match(result.promotion!.reason, /#3916/);
    assert.match(result.promotion!.reason, /#3918/);
  });

  it("função pura: não muta os argumentos originais", () => {
    const highlights: HighlightLike[] = [{ url: "https://d1.com", score: 95 }];
    const highlightsCopy = JSON.parse(JSON.stringify(highlights));
    const finalistsCopy = JSON.parse(JSON.stringify(finalists));
    ensureNegativeImpactHighlight(highlights, finalists);
    assert.deepEqual(highlights, highlightsCopy);
    assert.deepEqual(finalists, finalistsCopy);
  });
});
