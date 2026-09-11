/**
 * test/compute-shadow-scores.test.ts (#7977)
 *
 * Cobre scripts/compute-shadow-scores.ts — CLI que grava
 * _internal/scoring-shadow.json a partir de scoring-features.json + um
 * arquivo de pesos candidato, sem tocar nenhum arquivo existente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { weightsHash } from "../scripts/lib/shadow-score.ts";
import { runComputeShadowScores, loadCandidateWeights, listCandidateWeightHashes } from "../scripts/compute-shadow-scores.ts";

const CANDIDATE_WEIGHTS_DIR = join(process.cwd(), "context", "scoring", "candidate-weights");

function writeFeaturesFile(editionsRoot: string, edition: string, rows: Array<Record<string, unknown>>): void {
  const dir = join(editionsRoot, edition, "_internal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scoring-features.json"), JSON.stringify({ edition, row_count: rows.length, rows }), "utf8");
}

function featureRow(url: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url,
    bucket: "radar",
    title: url,
    score: 60,
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

describe("loadCandidateWeights / listCandidateWeightHashes (#7977)", () => {
  it("o candidato real committed (340ec6d9d3e9b0f1) existe e o hash bate com o conteúdo", () => {
    assert.ok(existsSync(CANDIDATE_WEIGHTS_DIR), "context/scoring/candidate-weights/ precisa existir (git-tracked, correção de escopo da #7977)");
    const file = loadCandidateWeights("340ec6d9d3e9b0f1");
    assert.equal(weightsHash(file.weights), "340ec6d9d3e9b0f1");
  });

  it("hash inexistente lança erro nomeando o arquivo esperado", () => {
    assert.throws(() => loadCandidateWeights("0000000000000000"), /não encontrado/);
  });

  it("listCandidateWeightHashes inclui o candidato baseline real", () => {
    assert.ok(listCandidateWeightHashes().includes("340ec6d9d3e9b0f1"));
  });
});

describe("runComputeShadowScores (#7977)", () => {
  it("grava scoring-shadow.json com shadow_score_alt calculado a partir dos pesos do candidato", () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-scores-"));
    try {
      writeFeaturesFile(dir, "260901", [
        featureRow("https://x.com/a", { score_base: 50, primary_source: true }),
        featureRow("https://x.com/b", { score_base: 40, primary_source: false }),
      ]);
      const results = runComputeShadowScores(dir, { edition: "260901", weightsHash: "340ec6d9d3e9b0f1", force: false });
      assert.equal(results.length, 1);
      assert.equal(results[0].status, "written");
      assert.equal(results[0].rows, 2);

      const outPath = join(dir, "260901", "_internal", "scoring-shadow.json");
      const out = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(out.candidate_weights_hash, "340ec6d9d3e9b0f1");
      assert.equal(out.rows[0].shadow_score_alt, 60); // 50 + primary_source:+10
      assert.equal(out.rows[1].shadow_score_alt, 40); // 40 + nada
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição sem scoring-features.json é pulada (skipped-no-features), não erro", () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-scores-missing-"));
    try {
      mkdirSync(join(dir, "260902", "_internal"), { recursive: true });
      const results = runComputeShadowScores(dir, { edition: "260902", weightsHash: "340ec6d9d3e9b0f1", force: false });
      assert.equal(results.length, 1);
      assert.equal(results[0].status, "skipped-no-features");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scoring-shadow.json já existente é preservado sem --force (skipped-exists), NUNCA sobrescrito por acidente", () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-scores-exists-"));
    try {
      writeFeaturesFile(dir, "260903", [featureRow("https://x.com/a")]);
      const outPath = join(dir, "260903", "_internal", "scoring-shadow.json");
      writeFileSync(outPath, '{"sentinel": true}', "utf8");

      const results = runComputeShadowScores(dir, { edition: "260903", weightsHash: "340ec6d9d3e9b0f1", force: false });
      assert.equal(results[0].status, "skipped-exists");
      assert.deepEqual(JSON.parse(readFileSync(outPath, "utf8")), { sentinel: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--force sobrescreve um scoring-shadow.json existente", () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-scores-force-"));
    try {
      writeFeaturesFile(dir, "260904", [featureRow("https://x.com/a", { score_base: 50 })]);
      const outPath = join(dir, "260904", "_internal", "scoring-shadow.json");
      writeFileSync(outPath, '{"sentinel": true}', "utf8");

      const results = runComputeShadowScores(dir, { edition: "260904", weightsHash: "340ec6d9d3e9b0f1", force: true });
      assert.equal(results[0].status, "written");
      assert.notEqual(JSON.parse(readFileSync(outPath, "utf8")).sentinel, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nunca modifica scoring-features.json ao processar (read-only sobre o input)", () => {
    const dir = mkdtempSync(join(tmpdir(), "shadow-scores-readonly-"));
    try {
      writeFeaturesFile(dir, "260905", [featureRow("https://x.com/a")]);
      const featuresPath = join(dir, "260905", "_internal", "scoring-features.json");
      const before = readFileSync(featuresPath, "utf8");
      runComputeShadowScores(dir, { edition: "260905", weightsHash: "340ec6d9d3e9b0f1", force: false });
      assert.equal(readFileSync(featuresPath, "utf8"), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
