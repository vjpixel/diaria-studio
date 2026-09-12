/**
 * test/calibrate-track-a-weights.test.ts (#7980)
 *
 * Cobre scripts/calibrate-track-a-weights.ts — regressão logística L2
 * restrita à população/features do Track A, guardrails de HHI e AUC de
 * holdout, e a escrita do arquivo de pesos candidato em
 * context/scoring/candidate-weights-track-a/.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrateTrackAWeights, writeTrackACandidateWeightsFile, trackAWeightsHash } from "../scripts/calibrate-track-a-weights.ts";

/** Escreve 1 edição sintética Track A com domínio ROTACIONADO (pra manter o suporte da feature diversificado o bastante e não estourar o gate de HHI por acaso do fixture). */
function writeTrackAEdition(editionsRoot: string, edition: string, domainIndex: number, items: Array<{ slug: string; primary_source: boolean; approved: boolean }>): void {
  const dir = join(editionsRoot, edition, "_internal");
  mkdirSync(dir, { recursive: true });
  const domain = `source${domainIndex % 10}.com`; // registrableDomain colapsa subdomínios do MESMO 2º nível — precisa variar o 2º nível em si pra diversificar o suporte de HHI
  const urlFor = (slug: string) => `https://${domain}/${edition}-${slug}`;

  const categorized = { highlights: items.map((i) => ({ article: { url: urlFor(i.slug), title: i.slug } })) };
  const approved = { highlights: items.filter((i) => i.approved).map((i) => ({ article: { url: urlFor(i.slug), title: i.slug } })) };
  writeFileSync(join(dir, "01-categorized.json"), JSON.stringify(categorized), "utf8");
  writeFileSync(join(dir, "01-approved.json"), JSON.stringify(approved), "utf8");

  const rows = items.map((i) => ({
    url: urlFor(i.slug),
    bucket: "highlights",
    title: i.slug,
    score: 50,
    score_base: 50,
    primary_source: i.primary_source,
    hands_on: false,
    academy: false,
    howto_br: false,
    howto_br_source: false,
    cluster_sources_count: 0,
    negative_impact: false,
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

function writeStrongConsistentCorpus(editionsRoot: string, n: number): void {
  for (let e = 0; e < n; e++) {
    const ed = String(260700 + e);
    writeTrackAEdition(editionsRoot, ed, e, [
      { slug: "a", primary_source: true, approved: true },
      { slug: "b", primary_source: false, approved: false },
    ]);
  }
}

/**
 * Mesmo corpus de `writeStrongConsistentCorpus`, mas a correlação
 * feature↔aprovação é INVERTIDA a partir de `reverseFromEdition` (índice,
 * não incluso o piso) — usado pra forçar o gate de AUC de holdout a
 * rejeitar: o coeficiente é aprendido no TREINO (correlação normal) mas o
 * shadow score aplicado ao HOLDOUT (correlação invertida) prediz pior que
 * aleatório fora da amostra. `primary_source` (o indicador da feature)
 * nunca muda — só o rótulo `approved` se inverte no holdout, preservando
 * a rotação de domínio (HHI) e o piso de eventos/edições/janelas
 * (`passes_evidence_bar_track_a` é calculado sobre a população INTEIRA,
 * treino+holdout, e continua passando: janelas do treino votam positivo,
 * a do holdout vota negativo, 2 de 3 já satisfaz `MIN_CONSISTENT_WINDOWS`).
 */
function writeCorpusWithReversedHoldout(editionsRoot: string, n: number, reverseFromEdition: number): void {
  for (let e = 0; e < n; e++) {
    const ed = String(260700 + e);
    const reversed = e >= reverseFromEdition;
    writeTrackAEdition(editionsRoot, ed, e, [
      { slug: "a", primary_source: true, approved: !reversed },
      { slug: "b", primary_source: false, approved: reversed },
    ]);
  }
}

describe("calibrateTrackAWeights (#7980)", () => {
  it("corpus vazio/pequeno: status no_eligible_features, nunca fabrica um candidato", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-a-empty-"));
    try {
      writeStrongConsistentCorpus(dir, 3);
      const result = calibrateTrackAWeights(dir, dir);
      assert.equal(result.status, "no_eligible_features");
      assert.equal(result.weights, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("efeito forte, consistente, domínios diversificados (60 edições): candidato ACEITO, pesos produzidos", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-a-strong-"));
    try {
      writeStrongConsistentCorpus(dir, 60);
      const result = calibrateTrackAWeights(dir, dir, 20);
      assert.equal(result.status, "candidate_produced", JSON.stringify(result.candidates, null, 2));
      assert.ok(result.weights);
      assert.ok(result.weights!.primary_source! > 0, "efeito positivo deveria propor pontos positivos");
      assert.equal(result.weights_hash, trackAWeightsHash(result.weights!));
      assert.ok(result.evidence_cases.length > 0);
      assert.ok(result.evidence_cases.length <= 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("suporte da feature concentrado num ÚNICO domínio: gate de HHI rejeita mesmo com efeito forte", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-a-hhi-"));
    try {
      // domainIndex sempre 0 — TODO o suporte cai no mesmo domínio, HHI máximo.
      for (let e = 0; e < 60; e++) {
        const ed = String(260700 + e);
        writeTrackAEdition(dir, ed, 0, [
          { slug: "a", primary_source: true, approved: true },
          { slug: "b", primary_source: false, approved: false },
        ]);
      }
      const result = calibrateTrackAWeights(dir, dir, 20);
      assert.equal(result.status, "all_candidates_rejected");
      const c = result.candidates.find((x) => x.feature === "primary_source")!;
      assert.equal(c.accepted, false);
      assert.ok(c.rejection_reasons.some((r) => r.includes("concentração de fonte")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holdout com correlação invertida (feature aprendida no treino não prediz fora da amostra): gate de AUC rejeita", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-a-auc-"));
    try {
      // 60 edições: primeiras 40 (treino) com correlação normal, últimas 20
      // (holdout, mesmo N do #7980 pros demais testes) com correlação
      // INVERTIDA — o coeficiente positivo aprendido no treino produz um
      // shadow score que, no holdout, prediz o OPOSTO de `approved`.
      writeCorpusWithReversedHoldout(dir, 60, 40);
      const result = calibrateTrackAWeights(dir, dir, 20);
      assert.equal(result.status, "all_candidates_rejected", JSON.stringify(result.candidates, null, 2));
      const c = result.candidates.find((x) => x.feature === "primary_source")!;
      assert.equal(c.accepted, false);
      assert.equal(c.guardrails.auc_rejected, true);
      assert.ok(c.guardrails.holdout_auc !== null && c.guardrails.holdout_auc <= 0.5, `holdout_auc esperado <= 0.5, recebido ${c.guardrails.holdout_auc}`);
      assert.ok(c.rejection_reasons.some((r) => r.includes("poder preditivo")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--holdout >= total de edições do corpus: status insufficient_training_data, 0 edições sobram pro treino", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-a-insufficient-"));
    try {
      // 40 edições é o piso mínimo pra passar a barra de evidência
      // (evaluable_editions >= 40) — holdout igual ao total força
      // trainSet.length === 0 sem deixar de ser elegível.
      writeStrongConsistentCorpus(dir, 40);
      const result = calibrateTrackAWeights(dir, dir, 40);
      assert.equal(result.status, "insufficient_training_data", JSON.stringify(result, null, 2));
      assert.equal(result.train_editions, 0);
      assert.equal(result.holdout_editions, 40);
      assert.equal(result.weights, null);
      assert.equal(result.weights_hash, null);
      assert.equal(result.weights_file, null);
      assert.deepEqual(result.candidates, []);
      assert.ok(result.eligible_features.includes("primary_source"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeTrackACandidateWeightsFile escreve em context/scoring/candidate-weights-track-a/, nunca no diretório de Track B", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-a-write-"));
    try {
      writeStrongConsistentCorpus(dir, 60);
      const result = calibrateTrackAWeights(dir, dir, 20);
      assert.equal(result.status, "candidate_produced");
      const relPath = writeTrackACandidateWeightsFile(dir, result);
      assert.match(relPath, /^context\/scoring\/candidate-weights-track-a\//);
      assert.ok(existsSync(join(dir, relPath)));
      assert.ok(!existsSync(join(dir, "context", "scoring", "candidate-weights")), "não deve criar/tocar o diretório de Track B");
      const written = JSON.parse(readFileSync(join(dir, relPath), "utf8"));
      assert.deepEqual(written.weights, result.weights);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
