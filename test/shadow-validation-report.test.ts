/**
 * test/shadow-validation-report.test.ts (#7977)
 *
 * Cobre scripts/shadow-validation-report.ts — AUC de concordância (kept vs
 * score real / shadow_score_alt) sobre a janela de holdout, e o índice de
 * concentração de domínio dos itens mantidos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAuc, buildShadowValidationReport } from "../scripts/shadow-validation-report.ts";

const WEIGHTS_HASH = "340ec6d9d3e9b0f1";

describe("computeAuc (#7977)", () => {
  it("separação perfeita (todo positivo > todo negativo): AUC 1.0", () => {
    assert.equal(computeAuc([10, 9, 1, 2], [true, true, false, false]), 1);
  });

  it("separação perfeita invertida (todo positivo < todo negativo): AUC 0.0", () => {
    assert.equal(computeAuc([1, 2, 10, 9], [true, true, false, false]), 0);
  });

  it("empate entre positivo e negativo conta 0.5 no par", () => {
    // 1 positivo (5) vs 1 negativo (5): empate → 0.5
    assert.equal(computeAuc([5, 5], [true, false]), 0.5);
  });

  it("valores null são excluídos do cálculo, não tratados como 0", () => {
    // positivo null é descartado — só resta o negativo, sem positivo válido → indefinido
    assert.equal(computeAuc([null, 5], [true, false]), null);
  });

  it("grupo positivo ou negativo vazio: AUC indefinida (null), nunca fabricada", () => {
    assert.equal(computeAuc([1, 2, 3], [true, true, true]), null);
    assert.equal(computeAuc([], []), null);
  });

  it("sem poder preditivo nenhum (valores idênticos entre grupos): AUC 0.5", () => {
    assert.equal(computeAuc([5, 5, 5, 5], [true, true, false, false]), 0.5);
  });
});

function writeEditionFixture(
  editionsRoot: string,
  edition: string,
  rows: Array<{ url: string; score: number | null; shadow: number | null; kept: boolean }>,
  opts: { skipShadow?: boolean; shadowHash?: string } = {},
): void {
  const dir = join(editionsRoot, edition, "_internal");
  mkdirSync(dir, { recursive: true });

  const featureRows = rows.map((r) => ({
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
    negative_impact: false,
    category: "noticias",
    origin: "cadastrada",
    recency_hours: 10,
    domain: new URL(r.url).hostname,
    title_char_count: 10,
    has_official_link: false,
    novelty_vs_past_editions: null,
    source_reputation_ctr_30d: null,
    source_reputation_ctr_90d: null,
    feature_available_since: new Date(0).toISOString(),
    launch_heuristics_sha: null,
  }));
  writeFileSync(join(dir, "scoring-features.json"), JSON.stringify({ edition, row_count: featureRows.length, rows: featureRows }), "utf8");

  if (!opts.skipShadow) {
    const shadowRows = rows.map((r) => ({ url: r.url, bucket: "radar", score: r.score, shadow_score_alt: r.shadow }));
    writeFileSync(
      join(dir, "scoring-shadow.json"),
      JSON.stringify({ edition, candidate_weights_hash: opts.shadowHash ?? WEIGHTS_HASH, row_count: shadowRows.length, rows: shadowRows }),
      "utf8",
    );
  }

  const kept = rows.filter((r) => r.kept).map((r) => ({ url: r.url, title: r.url }));
  writeFileSync(
    join(dir, "01-approved.json"),
    JSON.stringify({ highlights: [], runners_up: [], lancamento: [], radar: kept, use_melhor: [], video: [] }),
    "utf8",
  );
}

describe("buildShadowValidationReport (#7977)", () => {
  it("calcula AUC real e shadow para uma edição com separação perfeita nos dois", () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-validation-"));
    try {
      writeEditionFixture(dir, "260901", [
        { url: "https://x.com/a", score: 90, shadow: 90, kept: true },
        { url: "https://x.com/b", score: 80, shadow: 80, kept: true },
        { url: "https://x.com/c", score: 10, shadow: 10, kept: false },
        { url: "https://x.com/d", score: 5, shadow: 5, kept: false },
      ]);
      const report = buildShadowValidationReport(dir, WEIGHTS_HASH, 25);
      assert.equal(report.holdout_editions.length, 1);
      const e = report.holdout_editions[0];
      assert.equal(e.auc_real, 1);
      assert.equal(e.auc_shadow, 1);
      assert.equal(e.n_kept, 2);
      assert.equal(report.mean_auc_real, 1);
      assert.equal(report.mean_auc_shadow, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holdout respeita o N pedido — só as edições cronologicamente mais recentes entram", () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-validation-holdout-"));
    try {
      for (let e = 0; e < 5; e++) {
        const ed = String(260800 + e);
        writeEditionFixture(dir, ed, [
          { url: `https://x.com/${ed}-a`, score: 10, shadow: 10, kept: true },
          { url: `https://x.com/${ed}-b`, score: 5, shadow: 5, kept: false },
        ]);
      }
      const report = buildShadowValidationReport(dir, WEIGHTS_HASH, 2);
      assert.equal(report.holdout_editions.length, 2);
      assert.deepEqual(
        report.holdout_editions.map((e) => e.edition),
        ["260803", "260804"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scoring-shadow.json ausente: edição vai para editions_skipped com motivo, não trava o relatório", () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-validation-missing-shadow-"));
    try {
      writeEditionFixture(
        dir,
        "260901",
        [
          { url: "https://x.com/a", score: 10, shadow: null, kept: true },
          { url: "https://x.com/b", score: 5, shadow: null, kept: false },
        ],
        { skipShadow: true },
      );
      const report = buildShadowValidationReport(dir, WEIGHTS_HASH, 25);
      assert.equal(report.holdout_editions.length, 0);
      assert.equal(report.editions_skipped.length, 1);
      assert.match(report.editions_skipped[0].reason, /scoring-shadow\.json ausente/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scoring-shadow.json de OUTRO candidato (hash diferente) é rejeitado, nunca misturado silenciosamente", () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-validation-wrong-hash-"));
    try {
      writeEditionFixture(
        dir,
        "260901",
        [
          { url: "https://x.com/a", score: 10, shadow: 10, kept: true },
          { url: "https://x.com/b", score: 5, shadow: 5, kept: false },
        ],
        { shadowHash: "outrocandidato0000" },
      );
      const report = buildShadowValidationReport(dir, WEIGHTS_HASH, 25);
      assert.equal(report.holdout_editions.length, 0);
      assert.equal(report.editions_skipped.length, 1);
      assert.match(report.editions_skipped[0].reason, /outro candidato/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("todos os itens mantidos do mesmo domínio: HHI 10000 no relatório da edição", () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-validation-hhi-"));
    try {
      const rows = [
        { url: "https://a.com/1", score: 10, shadow: 10, kept: true },
        { url: "https://a.com/2", score: 9, shadow: 9, kept: true },
        { url: "https://b.com/1", score: 1, shadow: 1, kept: false },
      ];
      writeEditionFixture(dir, "260901", rows);
      const report = buildShadowValidationReport(dir, WEIGHTS_HASH, 25);
      assert.equal(report.holdout_editions[0].kept_domain_concentration.hhi, 10000);
      assert.equal(report.holdout_editions[0].kept_domain_concentration.top_domain, "a.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
