/**
 * test/track-a-negative-impact-canary.test.ts (#7980)
 *
 * Cobre scripts/lib/track-a-negative-impact-canary.ts — o canário
 * obrigatório do Track A (#7972 mitigação I-1): rank médio de candidatos
 * `negative_impact:true` entre os top-N (finalistas reconstruídos por
 * `score`), e a decisão de pausar novas promoções quando degrada de forma
 * sustentada.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeEditionCanary, analyzeCanaryTrend, type EditionCanaryPoint } from "../scripts/lib/track-a-negative-impact-canary.ts";
import type { ScoringFeatureRow } from "../scripts/lib/scoring-features.ts";

function row(url: string, score: number, negativeImpact = false): ScoringFeatureRow {
  return {
    url,
    bucket: "radar",
    title: url,
    score,
    score_base: score,
    primary_source: false,
    hands_on: false,
    academy: false,
    howto_br: false,
    howto_br_source: false,
    cluster_sources_count: 0,
    negative_impact: negativeImpact,
    category: "noticias",
    origin: "cadastrada",
    recency_hours: 10,
    domain: "example.com",
    title_char_count: url.length,
    has_official_link: false,
    novelty_vs_past_editions: null,
    source_reputation_ctr_30d: null,
    source_reputation_ctr_90d: null,
    feature_available_since: new Date(0).toISOString(),
    launch_heuristics_sha: null,
  };
}

describe("computeEditionCanary (#7980)", () => {
  it("nenhum candidato negative_impact no pool: avg_rank_among_finalists é null (não aplicável, não 0)", () => {
    const rows = [row("a", 90), row("b", 80), row("c", 70)];
    const point = computeEditionCanary("260901", rows, 15);
    assert.equal(point.avg_rank_among_finalists, null);
    assert.equal(point.negative_impact_pool_count, 0);
  });

  it("1 candidato negative_impact no topo (rank 1): avg_rank=1", () => {
    const rows = [row("a", 100, true), row("b", 80), row("c", 70)];
    const point = computeEditionCanary("260901", rows, 15);
    assert.equal(point.avg_rank_among_finalists, 1);
    assert.equal(point.negative_impact_finalist_count, 1);
  });

  it("candidato negative_impact fora do top-N: rank sintético N+1 (nunca tratado como ausente)", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(`ok-${i}`, 100 - i)), // top 5, todos scores altos
      row("bad", 1, true), // score baixo, cai fora do top-3
    ];
    const point = computeEditionCanary("260901", rows, 3);
    assert.equal(point.avg_rank_among_finalists, 4, "topN=3, rank sintético = topN+1 = 4");
    assert.equal(point.negative_impact_finalist_count, 0, "não entrou no top-3 de verdade");
    assert.equal(point.negative_impact_pool_count, 1);
  });

  it("2 candidatos negative_impact, ranks diferentes: média correta", () => {
    const rows = [row("a", 100, true), row("b", 90), row("c", 80, true), row("d", 70)];
    const point = computeEditionCanary("260901", rows, 15);
    // ordenado por score desc: a(100,rank1,neg) b(90,rank2) c(80,rank3,neg) d(70,rank4)
    assert.equal(point.avg_rank_among_finalists, (1 + 3) / 2);
  });
});

describe("analyzeCanaryTrend (#7980)", () => {
  it("histórico insuficiente (menos pontos avaliáveis que sustainedRounds+1): não recomenda pausa, mas explica que não é avaliável ainda", () => {
    const points: EditionCanaryPoint[] = [
      { edition: "260901", avg_rank_among_finalists: 2, negative_impact_pool_count: 1, negative_impact_finalist_count: 1, finalist_pool_size: 15 },
    ];
    const trend = analyzeCanaryTrend(points, { sustainedRounds: 3 });
    assert.equal(trend.pause_recommended, false);
    assert.equal(trend.baseline_avg_rank, null);
    assert.ok(trend.reasons.length > 0);
  });

  it("rank médio estável (sem degradação): não recomenda pausa", () => {
    const points: EditionCanaryPoint[] = Array.from({ length: 10 }, (_, i) => ({
      edition: `26090${i}`,
      avg_rank_among_finalists: 3, // constante
      negative_impact_pool_count: 1,
      negative_impact_finalist_count: 1,
      finalist_pool_size: 15,
    }));
    const trend = analyzeCanaryTrend(points, { sustainedRounds: 3 });
    assert.equal(trend.pause_recommended, false);
    assert.equal(trend.baseline_avg_rank, 3);
  });

  it("degradação SUSTENTADA nas últimas 3 rodadas (rank piora bem acima do limiar): recomenda pausa", () => {
    const points: EditionCanaryPoint[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ edition: `A${i}`, avg_rank_among_finalists: 2, negative_impact_pool_count: 1, negative_impact_finalist_count: 1, finalist_pool_size: 15 })),
      // últimas 3 rodadas: rank médio piora bem (sobe de 2 pra 14 — bem além do limiar de 1.0)
      { edition: "B1", avg_rank_among_finalists: 14, negative_impact_pool_count: 1, negative_impact_finalist_count: 0, finalist_pool_size: 15 },
      { edition: "B2", avg_rank_among_finalists: 14, negative_impact_pool_count: 1, negative_impact_finalist_count: 0, finalist_pool_size: 15 },
      { edition: "B3", avg_rank_among_finalists: 14, negative_impact_pool_count: 1, negative_impact_finalist_count: 0, finalist_pool_size: 15 },
    ];
    const trend = analyzeCanaryTrend(points, { sustainedRounds: 3 });
    assert.equal(trend.baseline_avg_rank, 2);
    assert.equal(trend.pause_recommended, true);
    assert.ok(trend.reasons[0].includes("pausar"));
  });

  it("degradação em SÓ 2 das últimas 3 rodadas: não é 'sustentada' o bastante — não pausa", () => {
    const points: EditionCanaryPoint[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ edition: `A${i}`, avg_rank_among_finalists: 2, negative_impact_pool_count: 1, negative_impact_finalist_count: 1, finalist_pool_size: 15 })),
      { edition: "B1", avg_rank_among_finalists: 14, negative_impact_pool_count: 1, negative_impact_finalist_count: 0, finalist_pool_size: 15 },
      { edition: "B2", avg_rank_among_finalists: 14, negative_impact_pool_count: 1, negative_impact_finalist_count: 0, finalist_pool_size: 15 },
      { edition: "B3", avg_rank_among_finalists: 2, negative_impact_pool_count: 1, negative_impact_finalist_count: 1, finalist_pool_size: 15 }, // volta ao normal
    ];
    const trend = analyzeCanaryTrend(points, { sustainedRounds: 3 });
    assert.equal(trend.pause_recommended, false);
  });

  it("pontos com avg_rank null (nenhum negative_impact naquela edição) são ignorados, não contam como degradação nem recuperação", () => {
    const points: EditionCanaryPoint[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ edition: `A${i}`, avg_rank_among_finalists: 2, negative_impact_pool_count: 1, negative_impact_finalist_count: 1, finalist_pool_size: 15 })),
      { edition: "N1", avg_rank_among_finalists: null, negative_impact_pool_count: 0, negative_impact_finalist_count: 0, finalist_pool_size: 15 },
      { edition: "N2", avg_rank_among_finalists: null, negative_impact_pool_count: 0, negative_impact_finalist_count: 0, finalist_pool_size: 15 },
      { edition: "B1", avg_rank_among_finalists: 2, negative_impact_pool_count: 1, negative_impact_finalist_count: 1, finalist_pool_size: 15 },
    ];
    const trend = analyzeCanaryTrend(points, { sustainedRounds: 3 });
    // os 2 pontos null são filtrados antes de tudo — sobram 11 avaliáveis,
    // baseline = média dos 8 primeiros (todos =2), janela recente = últimos 3 (=2,2,2 já que N1/N2 saíram) — sem degradação.
    assert.equal(trend.pause_recommended, false);
  });
});
