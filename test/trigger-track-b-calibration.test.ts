/**
 * test/trigger-track-b-calibration.test.ts (#7979)
 *
 * Cobre scripts/trigger-track-b-calibration.ts — parsing de título de
 * relatório de calibração e a decisão fim-a-fim contra fixtures reais em
 * disco (corpus sintético + registry de relatórios).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featureFromCalibrationReportTitle, decideTrackBTrigger } from "../scripts/trigger-track-b-calibration.ts";
import { registerReport } from "../scripts/studio-ui/studio-reports.ts";

describe("featureFromCalibrationReportTitle (#7979)", () => {
  it("extrai o nome da feature do formato gerado por generate-calibration-evidence-report.ts", () => {
    assert.equal(featureFromCalibrationReportTitle("Calibração hands_on — PR #8010"), "hands_on");
  });

  it("título fora do formato esperado: retorna null, nunca lança", () => {
    assert.equal(featureFromCalibrationReportTitle("título qualquer sem o formato"), null);
    assert.equal(featureFromCalibrationReportTitle(""), null);
  });
});

function writeSyntheticEdition(editionsRoot: string, edition: string, articles: Array<{ url: string; primary_source: boolean; keep: boolean }>): void {
  const dir = join(editionsRoot, edition, "_internal");
  mkdirSync(dir, { recursive: true });
  const rows = articles.map((a) => ({
    url: a.url,
    bucket: "radar",
    title: a.url,
    score: 50,
    score_base: 50,
    primary_source: a.primary_source,
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
  }));
  writeFileSync(join(dir, "scoring-features.json"), JSON.stringify({ edition, row_count: rows.length, rows }), "utf8");
  const kept = articles.filter((a) => a.keep).map((a) => ({ url: a.url, title: a.url }));
  writeFileSync(join(dir, "01-approved.json"), JSON.stringify({ highlights: [], runners_up: [], lancamento: [], radar: kept, use_melhor: [], video: [] }), "utf8");
}

describe("decideTrackBTrigger (#7979, fim-a-fim contra fixtures em disco)", () => {
  it("efeito forte plantado (primary_source) sem PR anterior nem cadência ativa: elegível e escolhido", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "trigger-editions-"));
    const rootDir = mkdtempSync(join(tmpdir(), "trigger-root-"));
    try {
      for (let e = 0; e < 50; e++) {
        const ed = String(260800 + e);
        writeSyntheticEdition(editionsRoot, ed, [
          { url: `https://x.com/${ed}-a`, primary_source: true, keep: true },
          { url: `https://x.com/${ed}-b`, primary_source: true, keep: true },
          { url: `https://x.com/${ed}-c`, primary_source: false, keep: false },
          { url: `https://x.com/${ed}-d`, primary_source: false, keep: false },
        ]);
      }
      const result = decideTrackBTrigger(editionsRoot, rootDir, "2026-09-11T12:00:00.000Z");
      assert.ok(result.eligible.some((c) => c.feature === "primary_source"), "primary_source deveria estar na fila de elegíveis");
      assert.equal(result.chosenFeature, "primary_source");
      assert.equal(result.blockedOnWeightComputation, true);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("feature já coberta por PR de calibração anterior (registry): excluída da fila de elegíveis", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "trigger-editions-covered-"));
    const rootDir = mkdtempSync(join(tmpdir(), "trigger-root-covered-"));
    try {
      for (let e = 0; e < 50; e++) {
        const ed = String(260800 + e);
        writeSyntheticEdition(editionsRoot, ed, [
          { url: `https://x.com/${ed}-a`, primary_source: true, keep: true },
          { url: `https://x.com/${ed}-b`, primary_source: true, keep: true },
          { url: `https://x.com/${ed}-c`, primary_source: false, keep: false },
          { url: `https://x.com/${ed}-d`, primary_source: false, keep: false },
        ]);
      }
      registerReport(rootDir, { kind: "calibration", sessionId: "8010", title: "Calibração primary_source — PR #8010", htmlPath: "data/reports/calibration/primary_source-8010.md" }, undefined, false);

      const result = decideTrackBTrigger(editionsRoot, rootDir, "2026-09-11T12:00:00.000Z");
      assert.ok(!result.eligible.some((c) => c.feature === "primary_source"), "primary_source já tem PR — não deveria voltar pra fila");
      assert.ok(result.alreadyCovered.includes("primary_source"));
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("cadência bloqueada (candidato aberto ontem): elegível mas NÃO escolhido — chosenFeature null", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "trigger-editions-cooldown-"));
    const rootDir = mkdtempSync(join(tmpdir(), "trigger-root-cooldown-"));
    try {
      for (let e = 0; e < 50; e++) {
        const ed = String(260800 + e);
        writeSyntheticEdition(editionsRoot, ed, [
          { url: `https://x.com/${ed}-a`, primary_source: true, keep: true },
          { url: `https://x.com/${ed}-b`, primary_source: true, keep: true },
          { url: `https://x.com/${ed}-c`, primary_source: false, keep: false },
          { url: `https://x.com/${ed}-d`, primary_source: false, keep: false },
        ]);
      }
      // PR de OUTRA feature registrada ontem — ocupa o cooldown semanal, mas
      // não cobre primary_source (ainda elegível, só bloqueado por cadência).
      const yesterday = new Date(new Date("2026-09-11T12:00:00.000Z").getTime() - 24 * 60 * 60 * 1000).toISOString();
      registerReport(rootDir, { kind: "calibration", sessionId: "8005", title: "Calibração academy — PR #8005", htmlPath: "x.md", createdAt: yesterday }, undefined, false);

      const result = decideTrackBTrigger(editionsRoot, rootDir, "2026-09-11T12:00:00.000Z");
      assert.ok(result.eligible.some((c) => c.feature === "primary_source"));
      assert.equal(result.chosenFeature, null);
      assert.equal(result.cadence.canOpenNewCandidate, false);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("blockedOnWeightComputation reflete chosenFeature (achado de review do #7979) — false quando nada foi escolhido", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "trigger-editions-blocked-flag-"));
    const rootDir = mkdtempSync(join(tmpdir(), "trigger-root-blocked-flag-"));
    try {
      // Sem edições -> fila vazia -> chosenFeature null -> blockedOnWeightComputation deveria ser false, não uma constante true.
      const result = decideTrackBTrigger(editionsRoot, rootDir, "2026-09-11T12:00:00.000Z");
      assert.equal(result.chosenFeature, null);
      assert.equal(result.blockedOnWeightComputation, false);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("nenhuma edição no corpus: fila vazia, nada escolhido, sem lançar", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "trigger-editions-empty-"));
    const rootDir = mkdtempSync(join(tmpdir(), "trigger-root-empty-"));
    try {
      const result = decideTrackBTrigger(editionsRoot, rootDir, "2026-09-11T12:00:00.000Z");
      assert.deepEqual(result.eligible, []);
      assert.equal(result.chosenFeature, null);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
