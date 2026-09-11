/**
 * test/calibrate-scoring-weights.test.ts (#7990)
 *
 * Cobre scripts/calibrate-scoring-weights.ts — regressão de verdade que
 * aprende pesos candidato a partir do corpus histórico, com os 3
 * guardrails obrigatórios (#7972 §4). Mesmo padrão de efeito plantado
 * forte/fraco de test/calibration-power-report.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrateScoringWeights, writeCandidateWeightsFile, DEFAULT_HOLDOUT } from "../scripts/calibrate-scoring-weights.ts";

interface ArticleSpec {
  url: string;
  primary_source: boolean;
  keep: boolean;
  score_base?: number;
}

/** Monta 1 edição sintética completa: scoring-features.json + 01-approved.json + 01-categorized.json (pra evidence cases via analyze-destaque-overrides.ts). */
function writeEdition(editionsRoot: string, edition: string, articles: ArticleSpec[]): void {
  const dir = join(editionsRoot, edition, "_internal");
  mkdirSync(dir, { recursive: true });
  const rows = articles.map((a) => ({
    url: a.url,
    bucket: "radar",
    title: a.url,
    score: 50,
    score_base: a.score_base ?? 50,
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
    domain: new URL(a.url).hostname,
    title_char_count: 10,
    has_official_link: false,
    novelty_vs_past_editions: null,
    source_reputation_ctr_30d: null,
    source_reputation_ctr_90d: null,
    feature_available_since: new Date(0).toISOString(),
    launch_heuristics_sha: null,
  }));
  writeFileSync(join(dir, "scoring-features.json"), JSON.stringify({ edition, row_count: rows.length, rows }), "utf8");

  const catItems = articles.map((a) => ({ url: a.url, title: a.url }));
  writeFileSync(
    join(dir, "01-categorized.json"),
    JSON.stringify({ highlights: [], runners_up: [], lancamento: [], radar: catItems, use_melhor: [], video: [] }),
    "utf8",
  );

  const keptItems = articles.filter((a) => a.keep).map((a) => ({ url: a.url, title: a.url }));
  writeFileSync(
    join(dir, "01-approved.json"),
    JSON.stringify({ highlights: [], runners_up: [], lancamento: [], radar: keptItems, use_melhor: [], video: [] }),
    "utf8",
  );
}

/** N edições com efeito FORTE e consistente: primary_source=true quase sempre mantido, false quase sempre cortado — passa a barra de evidência e produz coeficiente grande. Domínios variados (evita rejeição por HHI). */
function writeStrongCorpus(editionsRoot: string, n: number): void {
  for (let e = 0; e < n; e++) {
    const ed = String(260700 + e);
    writeEdition(editionsRoot, ed, [
      { url: `https://source-${e % 20}.example/${ed}-a`, primary_source: true, keep: true },
      { url: `https://source-${e % 20}.example/${ed}-b`, primary_source: true, keep: true },
      { url: `https://other-${e % 20}.example/${ed}-c`, primary_source: false, keep: false },
      { url: `https://other-${e % 20}.example/${ed}-d`, primary_source: false, keep: false },
    ]);
  }
}

describe("calibrateScoringWeights (#7990)", () => {
  it("nenhuma edição no corpus: status no_eligible_features", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-empty-"));
    try {
      const result = calibrateScoringWeights(dir, dir);
      assert.equal(result.status, "no_eligible_features");
      assert.deepEqual(result.eligible_features, []);
      assert.equal(result.weights, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corpus pequeno demais (nenhuma feature passa a barra de 30 eventos/40 edições): no_eligible_features", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-small-"));
    try {
      writeStrongCorpus(dir, 3);
      const result = calibrateScoringWeights(dir, dir);
      assert.equal(result.status, "no_eligible_features");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("todas as edições cabem no holdout (0 sobra pra treino): insufficient_training_data", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-holdout-"));
    try {
      writeStrongCorpus(dir, 50); // passa a barra de evidência...
      const result = calibrateScoringWeights(dir, dir, 50); // ...mas holdout == corpus inteiro
      assert.equal(result.status, "insufficient_training_data");
      assert.equal(result.train_editions, 0);
      assert.deepEqual(result.eligible_features, ["primary_source"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("efeito FORTE e consistente, domínios diversos: produz candidato aceito, coeficiente positivo, holdout nunca no treino", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-strong-"));
    try {
      writeStrongCorpus(dir, 60);
      const result = calibrateScoringWeights(dir, dir, DEFAULT_HOLDOUT);
      assert.equal(result.status, "candidate_produced");
      assert.equal(result.train_editions, 60 - DEFAULT_HOLDOUT);
      assert.equal(result.holdout_editions, DEFAULT_HOLDOUT);
      const candidate = result.candidates.find((c) => c.feature === "primary_source")!;
      assert.ok(candidate.accepted, `deveria ser aceito: ${candidate.rejection_reasons.join(", ")}`);
      assert.ok(candidate.coefficient > 0, "efeito plantado é positivo (feature=true → mantido)");
      assert.ok(candidate.proposed_points > 0, "pontos propostos deveriam ser positivos");
      assert.equal(result.points_per_log_odds_source, "default", "rootDir de teste não tem rubric.json real");
      assert.ok(result.weights_hash);
      assert.equal(result.weights![candidate.feature], candidate.proposed_points);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("efeito plantado mas TODO o suporte concentrado em 1 único domínio: gate de HHI rejeita", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-hhi-"));
    try {
      for (let e = 0; e < 60; e++) {
        const ed = String(260700 + e);
        writeEdition(dir, ed, [
          { url: `https://monodomain.example/${ed}-a`, primary_source: true, keep: true },
          { url: `https://monodomain.example/${ed}-b`, primary_source: true, keep: true },
          { url: `https://other-${e}.example/${ed}-c`, primary_source: false, keep: false },
          { url: `https://other-${e}.example/${ed}-d`, primary_source: false, keep: false },
        ]);
      }
      const result = calibrateScoringWeights(dir, dir);
      const candidate = result.candidates.find((c) => c.feature === "primary_source")!;
      assert.equal(candidate.guardrails.hhi, 10000, "1 único domínio no suporte → HHI máximo");
      assert.equal(candidate.guardrails.hhi_rejected, true);
      assert.equal(candidate.accepted, false);
      assert.ok(candidate.rejection_reasons.some((r) => r.includes("concentração de fonte")));
      assert.equal(result.status, "all_candidates_rejected");
      assert.equal(result.weights, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evidence_cases: até 5 casos nomeados, mais recentes primeiro, só da feature aceita", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-evidence-"));
    try {
      writeStrongCorpus(dir, 60);
      const result = calibrateScoringWeights(dir, dir);
      assert.equal(result.status, "candidate_produced");
      assert.ok(result.evidence_cases.length > 0 && result.evidence_cases.length <= 5);
      for (const c of result.evidence_cases) {
        assert.ok(c.edition && c.url && c.action, "cada caso precisa ter edition/url/action preenchidos");
      }
      // mais recentes primeiro
      const editions = result.evidence_cases.map((c) => c.edition);
      const sorted = [...editions].sort((a, b) => b.localeCompare(a));
      assert.deepEqual(editions, sorted);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeCandidateWeightsFile (#7990)", () => {
  it("lança se o resultado não tiver weights/weights_hash (candidato não produzido)", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-write-empty-"));
    try {
      const result = calibrateScoringWeights(dir, dir);
      assert.throws(() => writeCandidateWeightsFile(dir, result), /result\.weights\/weights_hash ausentes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escreve context/scoring/candidate-weights/{hash}.json com o formato CandidateWeightsFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-write-"));
    try {
      writeStrongCorpus(dir, 60);
      const result = calibrateScoringWeights(dir, dir);
      assert.equal(result.status, "candidate_produced");
      const relPath = writeCandidateWeightsFile(dir, result);
      assert.equal(relPath, `context/scoring/candidate-weights/${result.weights_hash}.json`);
      const written = JSON.parse(readFileSync(join(dir, relPath), "utf8"));
      assert.equal(typeof written.label, "string");
      assert.equal(typeof written.created_at, "string");
      assert.equal(typeof written.rationale, "string");
      assert.deepEqual(written.weights, result.weights);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
