/**
 * test/analyze-destaque-overrides.test.ts (#7976)
 *
 * Cobre scripts/analyze-destaque-overrides.ts — join de scoring-features.json
 * com o diff categorized/approved, rotulando Track A (destaque) e Track B
 * (bucket-move/cut/add).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeEditionOverrides, analyzeAllEditions, type LabeledEvent } from "../scripts/analyze-destaque-overrides.ts";
import type { ScoringFeatureRow } from "../scripts/lib/scoring-features.ts";

function row(url: string, overrides: Partial<ScoringFeatureRow> = {}): ScoringFeatureRow {
  return {
    url,
    bucket: "radar",
    title: url,
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
    title_char_count: url.length,
    has_official_link: false,
    novelty_vs_past_editions: null,
    source_reputation_ctr_30d: null,
    source_reputation_ctr_90d: null,
    feature_available_since: new Date(0).toISOString(),
    launch_heuristics_sha: null,
    ...overrides,
  };
}

function byLabel(events: LabeledEvent[], url: string): LabeledEvent {
  const found = events.find((e) => e.url === url);
  assert.ok(found, `evento pra ${url} não encontrado: ${JSON.stringify(events.map((e) => e.url))}`);
  return found!;
}

describe("analyzeEditionOverrides — Track A (destaques) (#7976)", () => {
  it("URL em highlights nos 2 lados vira llm_finalist_and_approved", () => {
    const cat = { highlights: [{ article: { url: "https://x.com/a", title: "A" } }] };
    const appr = { highlights: [{ article: { url: "https://x.com/a", title: "A" } }] };
    const events = analyzeEditionOverrides("260811", cat, appr, []);
    assert.equal(byLabel(events, "https://x.com/a").track_a, "llm_finalist_and_approved");
  });

  it("URL só no categorized.highlights, some do approved.highlights mas sobrevive no pool → llm_finalist_rejected_by_editor, survived_in_pool=true", () => {
    const cat = { highlights: [{ article: { url: "https://x.com/a", title: "A" } }] };
    const appr = { highlights: [], radar: [{ url: "https://x.com/a", title: "A" }] };
    const events = analyzeEditionOverrides("260811", cat, appr, []);
    const e = byLabel(events, "https://x.com/a");
    assert.equal(e.track_a, "llm_finalist_rejected_by_editor");
    assert.equal(e.survived_in_pool, true);
  });

  it("URL só no categorized.highlights, cortada da edição inteira → llm_finalist_rejected_by_editor, survived_in_pool=false", () => {
    const cat = { highlights: [{ article: { url: "https://x.com/a", title: "A" } }] };
    const appr = { highlights: [] };
    const events = analyzeEditionOverrides("260811", cat, appr, []);
    const e = byLabel(events, "https://x.com/a");
    assert.equal(e.track_a, "llm_finalist_rejected_by_editor");
    assert.equal(e.survived_in_pool, false);
  });

  it("URL só no approved.highlights (editor promoveu algo que o LLM nunca escolheu) → editor_promoted_outside_llm_finalists", () => {
    const cat = { highlights: [], radar: [{ url: "https://x.com/a", title: "A" }] };
    const appr = { highlights: [{ article: { url: "https://x.com/a", title: "A" } }] };
    const events = analyzeEditionOverrides("260811", cat, appr, []);
    // O item também sai do pool (radar) — mas Track A já cobre a promoção, e o
    // código de pool detecta "some do pool sem virar destaque"? Não — ele
    // "some" PORQUE virou destaque, e highlights já foi processado antes do
    // pool no código, então catPool ainda contém a URL e viraria pool_cut
    // incorretamente se não filtrado. Este teste garante que NÃO duplica.
    const trackAEvents = events.filter((e) => e.url === "https://x.com/a" && e.track_a);
    assert.equal(trackAEvents.length, 1);
    assert.equal(trackAEvents[0].track_a, "editor_promoted_outside_llm_finalists");
    const poolCutForSameUrl = events.filter((e) => e.url === "https://x.com/a" && e.track_b === "pool_cut");
    assert.equal(poolCutForSameUrl.length, 0, "promoção a destaque não pode também virar pool_cut pro mesmo evento");
  });

  it("anexa a feature row correta via join por URL; null quando a URL não está no feature store", () => {
    const cat = { highlights: [{ article: { url: "https://x.com/a", title: "A" } }] };
    const appr = { highlights: [{ article: { url: "https://x.com/a", title: "A" } }] };
    const rows = [row("https://x.com/a", { primary_source: true })];
    const events = analyzeEditionOverrides("260811", cat, appr, rows);
    assert.equal(byLabel(events, "https://x.com/a").features?.primary_source, true);

    const eventsNoFeatures = analyzeEditionOverrides("260811", cat, appr, []);
    assert.equal(byLabel(eventsNoFeatures, "https://x.com/a").features, null);
  });
});

describe("analyzeEditionOverrides — Track B (pool) (#7976)", () => {
  it("mesma URL, bucket diferente → bucket_moved com from/to corretos", () => {
    const cat = { radar: [{ url: "https://x.com/a", title: "A" }] };
    const appr = { use_melhor: [{ url: "https://x.com/a", title: "A" }] };
    const events = analyzeEditionOverrides("260811", cat, appr, []);
    const e = byLabel(events, "https://x.com/a");
    assert.equal(e.track_b, "bucket_moved");
    assert.deepEqual(e.bucket_move, { from: "radar", to: "use_melhor" });
  });

  it("mesma URL, mesmo bucket → bucket_kept", () => {
    const cat = { radar: [{ url: "https://x.com/a", title: "A" }] };
    const appr = { radar: [{ url: "https://x.com/a", title: "A" }] };
    const events = analyzeEditionOverrides("260811", cat, appr, []);
    assert.equal(byLabel(events, "https://x.com/a").track_b, "bucket_kept");
  });

  it("some do pool sem virar destaque → pool_cut", () => {
    const cat = { radar: [{ url: "https://x.com/a", title: "A" }] };
    const appr = {};
    const events = analyzeEditionOverrides("260811", cat, appr, []);
    assert.equal(byLabel(events, "https://x.com/a").track_b, "pool_cut");
  });

  it("aparece no pool aprovado sem estar no categorizado → pool_add", () => {
    const cat = {};
    const appr = { radar: [{ url: "https://x.com/a", title: "A" }] };
    const events = analyzeEditionOverrides("260811", cat, appr, []);
    assert.equal(byLabel(events, "https://x.com/a").track_b, "pool_add");
  });
});

describe("analyzeAllEditions — I/O real (#7976)", () => {
  function writeEdition(root: string, ed: string, cat: unknown, appr: unknown, features?: unknown): void {
    const dir = join(root, ed, "_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-categorized.json"), JSON.stringify(cat), "utf8");
    writeFileSync(join(dir, "01-approved.json"), JSON.stringify(appr), "utf8");
    if (features) writeFileSync(join(dir, "scoring-features.json"), JSON.stringify(features), "utf8");
  }

  it("edições sem 01-categorized.json ou 01-approved.json são puladas", () => {
    const dir = mkdtempSync(join(tmpdir(), "analyze-destaque-skip-"));
    try {
      mkdirSync(join(dir, "260811", "_internal"), { recursive: true });
      const result = analyzeAllEditions(dir);
      assert.equal(result.editions_analyzed, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scoring-features.json ausente: eventos entram com features=null, contados em events_missing_features", () => {
    const dir = mkdtempSync(join(tmpdir(), "analyze-destaque-nofeat-"));
    try {
      writeEdition(dir, "260811", { radar: [{ url: "https://x.com/a", title: "A" }] }, { radar: [{ url: "https://x.com/a", title: "A" }] });
      const result = analyzeAllEditions(dir);
      assert.equal(result.editions_analyzed, 1);
      assert.equal(result.events_missing_features, result.events.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição com JSON malformado é pulada, não trava a análise das demais", () => {
    const dir = mkdtempSync(join(tmpdir(), "analyze-destaque-malformed-"));
    try {
      writeEdition(dir, "260811", { radar: [{ url: "https://x.com/a", title: "A" }] }, { radar: [{ url: "https://x.com/a", title: "A" }] });
      mkdirSync(join(dir, "260812", "_internal"), { recursive: true });
      writeFileSync(join(dir, "260812", "_internal", "01-categorized.json"), "{ inválido", "utf8");
      writeFileSync(join(dir, "260812", "_internal", "01-approved.json"), "{}", "utf8");
      const result = analyzeAllEditions(dir);
      assert.equal(result.editions_analyzed, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
