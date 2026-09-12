/**
 * test/check-track-a-negative-impact-canary.test.ts (#7980)
 *
 * Cobre scripts/check-track-a-negative-impact-canary.ts::computeCanarySeries
 * — o glue que lê scoring-features.json de todas as edições em disco
 * (via loadEditionRows, reusado de calibration-power-report.ts) e monta a
 * série cronológica de pontos do canário.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCanarySeries } from "../scripts/check-track-a-negative-impact-canary.ts";

function writeEdition(editionsRoot: string, edition: string, rows: Array<{ url: string; score: number; negative_impact?: boolean }>): void {
  const dir = join(editionsRoot, edition, "_internal");
  mkdirSync(dir, { recursive: true });
  const full = rows.map((r) => ({
    url: r.url,
    bucket: "radar",
    title: r.url,
    score: r.score,
    score_base: r.score,
    primary_source: false,
    hands_on: false,
    academy: false,
    howto_br: false,
    howto_br_source: false,
    cluster_sources_count: 0,
    negative_impact: r.negative_impact ?? false,
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
  }));
  writeFileSync(join(dir, "scoring-features.json"), JSON.stringify({ edition, row_count: full.length, rows: full }), "utf8");
  writeFileSync(join(dir, "01-approved.json"), JSON.stringify({ highlights: [], runners_up: [], lancamento: [], radar: [], use_melhor: [], video: [] }), "utf8");
}

describe("computeCanarySeries (#7980)", () => {
  it("monta 1 ponto por edição, em ordem cronológica", () => {
    const dir = mkdtempSync(join(tmpdir(), "canary-series-"));
    try {
      writeEdition(dir, "260901", [
        { url: "a", score: 90, negative_impact: true },
        { url: "b", score: 80 },
      ]);
      writeEdition(dir, "260902", [{ url: "c", score: 50 }]);
      const series = computeCanarySeries(dir);
      assert.equal(series.length, 2);
      assert.equal(series[0].edition, "260901");
      assert.equal(series[0].avg_rank_among_finalists, 1);
      assert.equal(series[1].edition, "260902");
      assert.equal(series[1].avg_rank_among_finalists, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
