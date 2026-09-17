/**
 * test/track-a-features.test.ts (#7980)
 *
 * Cobre scripts/lib/track-a-features.ts — allowlist de features
 * calibráveis do Track A e resolução de valor (incl. a feature sintética
 * `coverage_bonus_present`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TRACK_A_CANDIDATE_FEATURES, isTrackACandidateFeature, trackAFeatureValue, trackAReportFeatureLabel, TRACK_A_REPORT_FEATURE_PREFIX } from "../scripts/lib/track-a-features.ts";
import type { ScoringFeatureRow } from "../scripts/lib/scoring-features.ts";

function row(overrides: Partial<ScoringFeatureRow> = {}): ScoringFeatureRow {
  return {
    url: "https://x.com/a",
    bucket: "radar",
    title: "a",
    score: 50,
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
    title_char_count: 1,
    has_official_link: false,
    novelty_vs_past_editions: null,
    source_reputation_ctr_30d: null,
    source_reputation_ctr_90d: null,
    feature_available_since: new Date(0).toISOString(),
    launch_heuristics_sha: null,
    ...overrides,
  };
}

describe("TRACK_A_CANDIDATE_FEATURES (#7980, #8254)", () => {
  it("exclui audience_affinity, has_official_link, academy, howto_br e howto_br_source — só os 3 nomeados no escopo do Track A", () => {
    assert.deepEqual([...TRACK_A_CANDIDATE_FEATURES].sort(), ["coverage_bonus_present", "hands_on", "primary_source"].sort());
    assert.equal(isTrackACandidateFeature("audience_affinity"), false);
    assert.equal(isTrackACandidateFeature("has_official_link"), false);
    assert.equal(isTrackACandidateFeature("negative_impact"), false);
    // #8254: as 3 features só computadas dentro de `annotateUseMelhorBucket` (bucket
    // use_melhor) — bucket categoricamente excluído de virar destaque, mesma razão
    // estrutural de `audience_affinity` — não fazem mais parte do Track A.
    assert.equal(isTrackACandidateFeature("academy"), false);
    assert.equal(isTrackACandidateFeature("howto_br"), false);
    assert.equal(isTrackACandidateFeature("howto_br_source"), false);
  });

  it("isTrackACandidateFeature reconhece todos os 3 nomes válidos", () => {
    for (const f of TRACK_A_CANDIDATE_FEATURES) assert.equal(isTrackACandidateFeature(f), true);
  });
});

describe("trackAFeatureValue (#7980)", () => {
  it("features booleanas reais lêem direto do campo", () => {
    assert.equal(trackAFeatureValue(row({ primary_source: true }), "primary_source"), true);
    assert.equal(trackAFeatureValue(row({ primary_source: false }), "primary_source"), false);
    assert.equal(trackAFeatureValue(row({ hands_on: true }), "hands_on"), true);
    assert.equal(trackAFeatureValue(row({ hands_on: false }), "hands_on"), false);
  });

  it("coverage_bonus_present é sintética: deriva de cluster_sources_count > 0", () => {
    assert.equal(trackAFeatureValue(row({ cluster_sources_count: 0 }), "coverage_bonus_present"), false);
    assert.equal(trackAFeatureValue(row({ cluster_sources_count: 1 }), "coverage_bonus_present"), true);
    assert.equal(trackAFeatureValue(row({ cluster_sources_count: 5 }), "coverage_bonus_present"), true);
  });
});

describe("trackAReportFeatureLabel (#7980)", () => {
  it("prefixa o nome da feature com track-a: — convenção obrigatória pro título de relatório de calibração de Track A (achado de review do #7980, P1: evita colisão com nomes de feature compartilhados de Track B)", () => {
    for (const f of TRACK_A_CANDIDATE_FEATURES) {
      assert.equal(trackAReportFeatureLabel(f), `${TRACK_A_REPORT_FEATURE_PREFIX}${f}`);
    }
    assert.equal(trackAReportFeatureLabel("primary_source"), "track-a:primary_source");
  });
});
