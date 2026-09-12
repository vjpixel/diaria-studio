/**
 * test/trigger-track-a-calibration.test.ts (#7980)
 *
 * Cobre scripts/trigger-track-a-calibration.ts — decisão fim-a-fim
 * (elegibilidade + cadência + canário obrigatório) contra fixtures reais
 * em disco.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featureFromCalibrationReportTitle, decideTrackATrigger } from "../scripts/trigger-track-a-calibration.ts";
import { registerReport } from "../scripts/studio-ui/studio-reports.ts";

function writeEdition(editionsRoot: string, edition: string, domainIndex: number, items: Array<{ slug: string; primary_source: boolean; approved: boolean; negative_impact?: boolean; score?: number }>): void {
  const dir = join(editionsRoot, edition, "_internal");
  mkdirSync(dir, { recursive: true });
  const domain = `source${domainIndex % 10}.com`;
  const urlFor = (slug: string) => `https://${domain}/${edition}-${slug}`;

  writeFileSync(join(dir, "01-categorized.json"), JSON.stringify({ highlights: items.map((i) => ({ article: { url: urlFor(i.slug), title: i.slug } })) }), "utf8");
  writeFileSync(join(dir, "01-approved.json"), JSON.stringify({ highlights: items.filter((i) => i.approved).map((i) => ({ article: { url: urlFor(i.slug), title: i.slug } })) }), "utf8");

  const rows = items.map((i) => ({
    url: urlFor(i.slug),
    bucket: "highlights",
    title: i.slug,
    score: i.score ?? 50,
    score_base: i.score ?? 50,
    primary_source: i.primary_source,
    hands_on: false,
    academy: false,
    howto_br: false,
    howto_br_source: false,
    cluster_sources_count: 0,
    negative_impact: i.negative_impact ?? false,
    category: "noticias",
    origin: "cadastrada",
    recency_hours: 10,
    domain,
    title_char_count: 10,
    has_official_link: false,
    novelty_vs_past_editions: null,
    source_reputation_ctr_30d: null,
    source_reputation_ctr_90d: null,
    feature_available_since: new Date(0).toISOString(),
    launch_heuristics_sha: null,
  }));
  writeFileSync(join(dir, "scoring-features.json"), JSON.stringify({ edition, row_count: rows.length, rows }), "utf8");
}

function writeStrongCorpus(editionsRoot: string, n: number, opts: { negativeImpactRank?: "good" | "bad" } = {}): void {
  for (let e = 0; e < n; e++) {
    const ed = String(260700 + e);
    const items: Array<{ slug: string; primary_source: boolean; approved: boolean; negative_impact?: boolean; score?: number }> = [
      { slug: "a", primary_source: true, approved: true },
      { slug: "b", primary_source: false, approved: false },
    ];
    if (opts.negativeImpactRank === "good") items.push({ slug: "neg", primary_source: false, approved: true, negative_impact: true, score: 95 });
    if (opts.negativeImpactRank === "bad") items.push({ slug: "neg", primary_source: false, approved: false, negative_impact: true, score: 1 });
    writeEdition(editionsRoot, ed, e, items);
  }
}

describe("featureFromCalibrationReportTitle (#7980)", () => {
  it("mesmo formato de título que Track B — reusa o parsing, não duplica", () => {
    assert.equal(featureFromCalibrationReportTitle("Calibração coverage_bonus_present — PR #9000"), "coverage_bonus_present");
    assert.equal(featureFromCalibrationReportTitle(""), null);
  });
});

describe("decideTrackATrigger (#7980, fim-a-fim)", () => {
  it("efeito forte plantado, sem PR anterior, canário limpo: elegível e escolhido, calibração chamada de verdade", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "trigger-a-editions-"));
    const rootDir = mkdtempSync(join(tmpdir(), "trigger-a-root-"));
    try {
      writeStrongCorpus(editionsRoot, 60, { negativeImpactRank: "good" });
      const result = decideTrackATrigger(editionsRoot, rootDir, "2026-09-11T12:00:00.000Z");
      assert.ok(result.eligible.some((c) => c.feature === "primary_source"));
      assert.equal(result.chosenFeature, "primary_source");
      assert.equal(result.canary.pause_recommended, false);
      assert.ok(result.calibration, "deveria ter chamado calibrateTrackAWeights de verdade");
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("canário recomenda pausa (negative_impact degradando de forma sustentada): NENHUM candidato é escolhido, mesmo elegível e com cadência livre", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "trigger-a-editions-canary-"));
    const rootDir = mkdtempSync(join(tmpdir(), "trigger-a-root-canary-"));
    try {
      // 1ª metade: negative_impact bem ranqueado (rank 1). 2ª metade: SEMPRE mal ranqueado (fora do top-15) — degradação sustentada nas últimas rodadas.
      for (let e = 0; e < 40; e++) {
        const ed = String(260700 + e);
        writeEdition(editionsRoot, ed, e, [
          { slug: "a", primary_source: true, approved: true },
          { slug: "b", primary_source: false, approved: false },
          { slug: "neg", primary_source: false, approved: true, negative_impact: true, score: 95 },
        ]);
      }
      for (let e = 40; e < 60; e++) {
        const ed = String(260700 + e);
        writeEdition(editionsRoot, ed, e, [
          { slug: "a", primary_source: true, approved: true },
          { slug: "b", primary_source: false, approved: false },
          { slug: "neg", primary_source: false, approved: false, negative_impact: true, score: 1 },
        ]);
      }
      const result = decideTrackATrigger(editionsRoot, rootDir, "2026-09-11T12:00:00.000Z");
      assert.equal(result.canary.pause_recommended, true, JSON.stringify(result.canary));
      assert.equal(result.chosenFeature, null, "canário deve bloquear mesmo com feature elegível");
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("feature já coberta por PR de calibração anterior (registry): excluída da fila de elegíveis", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "trigger-a-editions-covered-"));
    const rootDir = mkdtempSync(join(tmpdir(), "trigger-a-root-covered-"));
    try {
      writeStrongCorpus(editionsRoot, 60, { negativeImpactRank: "good" });
      registerReport(rootDir, { kind: "calibration", sessionId: "9000", title: "Calibração primary_source — PR #9000", htmlPath: "data/reports/calibration/primary_source-9000.md" }, undefined, false);

      const result = decideTrackATrigger(editionsRoot, rootDir, "2026-09-11T12:00:00.000Z");
      assert.ok(!result.eligible.some((c) => c.feature === "primary_source"));
      assert.ok(result.alreadyCovered.includes("primary_source"));
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("cadência bloqueada (candidato de outra feature aberto ontem): elegível mas NÃO escolhido", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "trigger-a-editions-cooldown-"));
    const rootDir = mkdtempSync(join(tmpdir(), "trigger-a-root-cooldown-"));
    try {
      writeStrongCorpus(editionsRoot, 60, { negativeImpactRank: "good" });
      const yesterday = new Date(new Date("2026-09-11T12:00:00.000Z").getTime() - 24 * 60 * 60 * 1000).toISOString();
      registerReport(rootDir, { kind: "calibration", sessionId: "9001", title: "Calibração academy — PR #9001", htmlPath: "x.md", createdAt: yesterday }, undefined, false);

      const result = decideTrackATrigger(editionsRoot, rootDir, "2026-09-11T12:00:00.000Z");
      assert.ok(result.eligible.some((c) => c.feature === "primary_source"));
      assert.equal(result.chosenFeature, null);
      assert.equal(result.cadence.canOpenNewCandidate, false);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
