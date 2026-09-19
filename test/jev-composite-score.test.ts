/**
 * test/jev-composite-score.test.ts (#8415 — Medição 2 do epic #8412)
 *
 * Cobre `scripts/lib/jev-composite-score.ts`: normalização de score, cálculo
 * do composto ponderado, extração de candidatos de `01-approved.json`, e a
 * métrica de concordância no TOP-15. Tudo puro — sem rede, sem disco.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMPOSITE_AXES,
  axesToJevQuestions,
  collectEditionCandidates,
  compositeScore,
  normalizedAxisScore,
  pearsonCorrelation,
  top15Concordance,
  totalWeight,
} from "../scripts/lib/jev-composite-score.ts";
import type { JevScoreAnswer } from "../scripts/lib/jev.ts";

describe("normalizedAxisScore", () => {
  it("normaliza índice contínuo pra 0..1 dado nLevels", () => {
    assert.equal(normalizedAxisScore(0, 3), 0);
    assert.equal(normalizedAxisScore(2, 3), 1);
    assert.equal(normalizedAxisScore(1, 3), 0.5);
  });

  it("clampa fora de [0,1] (resposta ruidosa da API)", () => {
    assert.equal(normalizedAxisScore(-0.5, 3), 0);
    assert.equal(normalizedAxisScore(5, 3), 1);
  });

  it("nLevels<=1 devolve 0 (sem escala pra normalizar)", () => {
    assert.equal(normalizedAxisScore(0, 1), 0);
  });
});

describe("axesToJevQuestions", () => {
  it("gera 1 pergunta `score` por eixo, com criteria (nunca min/max)", () => {
    const qs = axesToJevQuestions(COMPOSITE_AXES);
    assert.equal(qs.length, COMPOSITE_AXES.length);
    for (const q of qs) {
      assert.equal(q.type, "score");
      assert.ok(Array.isArray((q as any).criteria) && (q as any).criteria.length >= 2);
      assert.equal("min" in q, false);
      assert.equal("max" in q, false);
    }
  });
});

describe("compositeScore", () => {
  const axes = [
    { id: "a", weight: 1, criteria: ["baixo", "alto"], instructions: "x" },
    { id: "b", weight: 3, criteria: ["baixo", "médio", "alto"], instructions: "y" },
  ];

  it("pondera pelos pesos declarados, 0-100", () => {
    const answers: Record<string, JevScoreAnswer> = {
      a: { id: "a", type: "score", score: 1, confidence: 1 }, // normalizado = 1.0
      b: { id: "b", type: "score", score: 0, confidence: 1 }, // normalizado = 0.0
    };
    // (1*1.0 + 3*0.0) / 4 * 100 = 25
    assert.equal(compositeScore(answers, axes), 25);
  });

  it("exclui eixo sem resposta do peso total (não penaliza por falha pontual)", () => {
    const answers: Record<string, JevScoreAnswer> = {
      a: { id: "a", type: "score", score: 1, confidence: 1 },
    };
    // só o eixo `a` respondeu, com norm=1.0 → 100
    assert.equal(compositeScore(answers, axes), 100);
  });

  it("devolve null se NENHUM eixo respondeu", () => {
    assert.equal(compositeScore({}, axes), null);
  });

  it("totalWeight soma os pesos declarados", () => {
    assert.equal(totalWeight(axes), 4);
  });
});

describe("collectEditionCandidates", () => {
  it("extrai destaques (highlights) e pool, marca isDestaque corretamente", () => {
    const approved = {
      highlights: [
        {
          score: 95,
          bucket: "noticias",
          url: "https://a.com",
          article: { url: "https://a.com", title: "T1", summary: "S1", source: "Src", published_at: "2026-09-01" },
        },
      ],
      radar: [{ url: "https://b.com", title: "T2", summary: "S2", source: "Src2", date: "2026-09-01", score: 60 }],
      lancamento: [],
      use_melhor: [],
      video: [],
    };
    const cands = collectEditionCandidates(approved, "260901");
    assert.equal(cands.length, 2);
    const a = cands.find((c) => c.url === "https://a.com")!;
    const b = cands.find((c) => c.url === "https://b.com")!;
    assert.equal(a.isDestaque, true);
    assert.equal(a.mechanismScore, 95);
    assert.equal(b.isDestaque, false);
    assert.equal(b.mechanismScore, 60);
  });

  it("highlight duplicado no pool: a entrada de highlights VENCE (isDestaque=true)", () => {
    const approved = {
      highlights: [{ score: 90, url: "https://dup.com", article: { url: "https://dup.com", title: "T" } }],
      radar: [{ url: "https://dup.com", title: "T (pool)", score: 40 }],
    };
    const cands = collectEditionCandidates(approved, "260901");
    assert.equal(cands.length, 1);
    assert.equal(cands[0].isDestaque, true);
    assert.equal(cands[0].mechanismScore, 90);
  });

  it("ignora item sem url ou sem score numérico", () => {
    const approved = {
      radar: [{ title: "sem url", score: 10 }, { url: "https://x.com", title: "sem score" }],
    };
    assert.deepEqual(collectEditionCandidates(approved, "e"), []);
  });
});

describe("top15Concordance", () => {
  it("captura destaques dentro do corte quando o score os rankeia alto", () => {
    const items = [
      { url: "d1", isDestaque: true, score: 90 },
      { url: "d2", isDestaque: true, score: 80 },
      { url: "n1", isDestaque: false, score: 50 },
    ];
    const r = top15Concordance(items, 2);
    assert.equal(r.cutoff, 2);
    assert.equal(r.totalDestaques, 2);
    assert.equal(r.destaquesInTop, 2);
  });

  it("destaque fora do corte não é capturado", () => {
    const items = [
      { url: "n1", isDestaque: false, score: 99 },
      { url: "n2", isDestaque: false, score: 98 },
      { url: "d1", isDestaque: true, score: 10 },
    ];
    const r = top15Concordance(items, 2);
    assert.equal(r.destaquesInTop, 0);
    assert.equal(r.totalDestaques, 1);
  });

  it("cutoff nunca excede o total de candidatos", () => {
    const items = [{ url: "a", isDestaque: true, score: 1 }];
    assert.equal(top15Concordance(items, 15).cutoff, 1);
  });
});

describe("pearsonCorrelation", () => {
  it("1.0 para relação linear perfeita", () => {
    assert.equal(pearsonCorrelation([1, 2, 3], [2, 4, 6]), 1);
  });

  it("null quando n<2 ou variância zero", () => {
    assert.equal(pearsonCorrelation([1], [1]), null);
    assert.equal(pearsonCorrelation([1, 1, 1], [1, 2, 3]), null);
  });
});
