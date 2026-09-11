/**
 * test/shadow-score.test.ts (#7977)
 *
 * Cobre scripts/lib/shadow-score.ts — cálculo puro de shadow_score_alt e
 * hash de conteúdo determinístico dos pesos candidatos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeShadowScore, weightsHash } from "../scripts/lib/shadow-score.ts";
import type { ScoringFeatureRow } from "../scripts/lib/scoring-features.ts";

function baseRow(overrides: Partial<ScoringFeatureRow> = {}): ScoringFeatureRow {
  return {
    url: "https://x.com/a",
    bucket: "radar",
    title: "titulo",
    score: 70,
    score_base: 50,
    primary_source: false,
    hands_on: false,
    academy: false,
    howto_br: false,
    howto_br_source: false,
    cluster_sources_count: 0,
    negative_impact: false,
    category: "noticias",
    origin: "cadastrada",
    recency_hours: 10,
    domain: "example.com",
    title_char_count: 10,
    has_official_link: false,
    novelty_vs_past_editions: null,
    source_reputation_ctr_30d: null,
    source_reputation_ctr_90d: null,
    feature_available_since: new Date(0).toISOString(),
    launch_heuristics_sha: null,
    ...overrides,
  };
}

describe("computeShadowScore (#7977)", () => {
  it("soma score_base + pesos das features presentes", () => {
    const row = baseRow({ score_base: 50, primary_source: true, hands_on: true });
    const shadow = computeShadowScore(row, { primary_source: 10, hands_on: 8, academy: 6 });
    assert.equal(shadow, 50 + 10 + 8);
  });

  it("feature ausente do objeto de pesos não contribui (peso implícito 0)", () => {
    const row = baseRow({ score_base: 50, primary_source: true });
    const shadow = computeShadowScore(row, { academy: 6 });
    assert.equal(shadow, 50);
  });

  it("feature false não contribui mesmo com peso definido", () => {
    const row = baseRow({ score_base: 50, primary_source: false });
    const shadow = computeShadowScore(row, { primary_source: 10 });
    assert.equal(shadow, 50);
  });

  it("score_base null → shadow_score_alt null, nunca fabricado", () => {
    const row = baseRow({ score_base: null });
    assert.equal(computeShadowScore(row, { primary_source: 10 }), null);
  });

  it("sem nenhum peso, shadow == score_base", () => {
    const row = baseRow({ score_base: 42 });
    assert.equal(computeShadowScore(row, {}), 42);
  });
});

describe("weightsHash (#7977)", () => {
  it("é determinístico — mesmo objeto de pesos produz o mesmo hash", () => {
    const w = { primary_source: 10, hands_on: 8 };
    assert.equal(weightsHash(w), weightsHash(w));
  });

  it("ordem das chaves não afeta o hash (canonicalização)", () => {
    const a = weightsHash({ primary_source: 10, hands_on: 8 });
    const b = weightsHash({ hands_on: 8, primary_source: 10 });
    assert.equal(a, b);
  });

  it("pesos diferentes produzem hashes diferentes", () => {
    const a = weightsHash({ primary_source: 10 });
    const b = weightsHash({ primary_source: 11 });
    assert.notEqual(a, b);
  });
});
