/**
 * test/distillation-backtest.test.ts (#7981)
 *
 * Cobertura focada no que é controlável sem fixture completo do pipeline
 * (02-reviewed.md/03-social.md que passem TODA a máquina de lint real é
 * frágil de fabricar em teste unitário) — a mecânica de contagem/exclusão
 * do denominador (arquivo ausente = "não avaliável", nunca conta como "sem
 * violação"), e o check `title-length-52-chars` (100% controlável via
 * scoring-features.json, a mesma fonte que o corpus real usa).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDistillationBacktest, TITLE_MAX_CHARS } from "../scripts/lib/distillation-backtest.ts";

function writeScoringFeatures(dir: string, rows: Array<{ bucket: string; title_char_count: number }>): void {
  const internal = join(dir, "_internal");
  mkdirSync(internal, { recursive: true });
  const fullRows = rows.map((r, i) => ({
    url: `https://x.com/${i}`,
    bucket: r.bucket,
    title: "x".repeat(r.title_char_count),
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
    domain: "x.com",
    title_char_count: r.title_char_count,
    has_official_link: false,
    novelty_vs_past_editions: null,
    source_reputation_ctr_30d: null,
    source_reputation_ctr_90d: null,
    feature_available_since: new Date(0).toISOString(),
    launch_heuristics_sha: null,
  }));
  writeFileSync(join(internal, "scoring-features.json"), JSON.stringify({ edition: "x", row_count: fullRows.length, rows: fullRows }), "utf8");
}

describe("runDistillationBacktest — title-length-52-chars (#7981)", () => {
  it("edição com título de highlight acima do limite conta como violação", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-backtest-"));
    try {
      const dir = join(editionsRoot, "260901");
      writeScoringFeatures(dir, [{ bucket: "highlights", title_char_count: TITLE_MAX_CHARS + 10 }]);
      const report = runDistillationBacktest(editionsRoot, editionsRoot);
      const check = report.checks.find((c) => c.name === "title-length-52-chars")!;
      assert.equal(check.editions_evaluated, 1);
      assert.equal(check.editions_with_violation, 1);
      assert.equal(check.violation_rate, 1);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("edição com todos os títulos de highlight dentro do limite: sem violação", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-backtest-"));
    try {
      const dir = join(editionsRoot, "260901");
      writeScoringFeatures(dir, [{ bucket: "highlights", title_char_count: TITLE_MAX_CHARS - 5 }]);
      const report = runDistillationBacktest(editionsRoot, editionsRoot);
      const check = report.checks.find((c) => c.name === "title-length-52-chars")!;
      assert.equal(check.editions_with_violation, 0);
      assert.equal(check.violation_rate, 0);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("edição sem NENHUM highlight no feature store não conta pro denominador (não avaliável, não é 'sem violação')", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-backtest-"));
    try {
      const dir = join(editionsRoot, "260901");
      writeScoringFeatures(dir, [{ bucket: "radar", title_char_count: TITLE_MAX_CHARS + 20 }]);
      const report = runDistillationBacktest(editionsRoot, editionsRoot);
      const check = report.checks.find((c) => c.name === "title-length-52-chars")!;
      assert.equal(check.editions_evaluated, 0, "sem highlight, não é avaliável");
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("edição sem scoring-features.json não entra no denominador de nenhum check", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-backtest-empty-"));
    try {
      mkdirSync(join(editionsRoot, "260901", "_internal"), { recursive: true });
      const report = runDistillationBacktest(editionsRoot, editionsRoot);
      for (const check of report.checks) {
        assert.equal(check.editions_evaluated, 0);
        assert.equal(check.violation_rate, 0, "0 avaliáveis → taxa default 0, nunca NaN/undefined");
      }
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("editions_analyzed conta o total de diretórios de edição enumerados, independente de terem dado avaliável", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-backtest-count-"));
    try {
      mkdirSync(join(editionsRoot, "260901", "_internal"), { recursive: true });
      const dir2 = join(editionsRoot, "260902");
      writeScoringFeatures(dir2, [{ bucket: "highlights", title_char_count: 10 }]);
      const report = runDistillationBacktest(editionsRoot, editionsRoot);
      assert.equal(report.editions_analyzed, 2);
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });

  it("retorna os 4 checks nomeados sempre, mesmo com corpus vazio", () => {
    const editionsRoot = mkdtempSync(join(tmpdir(), "distill-backtest-names-"));
    try {
      const report = runDistillationBacktest(editionsRoot, editionsRoot);
      const names = report.checks.map((c) => c.name).sort();
      assert.deepEqual(names, ["banned-lexicon", "carousel-text-overflow", "newsletter-lint-gate-blocking", "title-length-52-chars"].sort());
    } finally {
      rmSync(editionsRoot, { recursive: true, force: true });
    }
  });
});
