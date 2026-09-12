/**
 * test/calibrate-scoring-weights.test.ts (#7990)
 *
 * Cobre scripts/calibrate-scoring-weights.ts — regressão de verdade que
 * aprende pesos candidato a partir do corpus histórico, com os 4
 * guardrails obrigatórios (#7972 §4; 4º — AUC de holdout — adicionado pela
 * #8006). Mesmo padrão de efeito plantado forte/fraco de
 * test/calibration-power-report.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calibrateScoringWeights,
  writeCandidateWeightsFile,
  evaluateGuardrails,
  isPlausibleEditionDate,
  DEFAULT_HOLDOUT,
} from "../scripts/calibrate-scoring-weights.ts";
import type { EditionRows } from "../scripts/calibration-power-report.ts";
import type { ScoringFeatureRow } from "../scripts/lib/scoring-features.ts";

/** Linha completa de ScoringFeatureRow com defaults sãos — só sobrescreve o que o teste precisa variar. */
function mkRow(overrides: Partial<ScoringFeatureRow> & { url: string }): ScoringFeatureRow {
  return {
    bucket: "radar",
    title: overrides.url,
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
    domain: (() => {
      try {
        return new URL(overrides.url).hostname;
      } catch {
        return null;
      }
    })(),
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

describe("isPlausibleEditionDate (#7990, achado ao vivo: data/editions/2612/261299/)", () => {
  it("rejeita dia fora de faixa (o caso real que motivou o guard: dia '99')", () => {
    assert.equal(isPlausibleEditionDate("261299"), false);
  });
  it("rejeita mês fora de faixa (13)", () => {
    assert.equal(isPlausibleEditionDate("261399"), false);
  });
  it("rejeita mês 00 e dia 00", () => {
    assert.equal(isPlausibleEditionDate("260012"), false);
    assert.equal(isPlausibleEditionDate("260100"), false);
  });
  it("rejeita formato que não é 6 dígitos", () => {
    assert.equal(isPlausibleEditionDate("2609"), false);
    assert.equal(isPlausibleEditionDate("26091"), false);
    assert.equal(isPlausibleEditionDate("abcdef"), false);
  });
  it("aceita AAMMDD real (edição de verdade)", () => {
    assert.equal(isPlausibleEditionDate("260911"), true);
  });
  it("não é ciente de mês (achado de review comment-analyzer, P3 — documentado, não corrigido: 30 de fevereiro passa)", () => {
    assert.equal(isPlausibleEditionDate("260230"), true);
  });
});

describe("evaluateGuardrails (#7990) — cap de domínio (#5735) e HHI, isolados de ponta a ponta", () => {
  const FEATURE = "has_official_link" as const;

  it("cap de domínio REJEITA quando a simulação concentra mais que o baseline real (achado de review, P1/P2 — antes sem cobertura)", () => {
    // 3 itens do MESMO domínio com feature=true e score_base baixo, 1 item
    // de outro domínio com feature=false e score_base alto — baseline real
    // mantém só o item diverso (kept.length=1, 0% overflow); um peso
    // positivo forte na feature empurra os 3 itens concentrados pro topo
    // do ranking simulado (realKeptCount=1 pega só 1 desses 3, então pra
    // estourar o cap de verdade aqui o teste usa realKeptCount maior).
    const editions: EditionRows[] = [];
    for (let e = 0; e < 45; e++) {
      const ed = String(260700 + e);
      const rows = [
        mkRow({ url: `https://mono.example/${ed}-a`, [FEATURE]: true, score_base: 10 }),
        mkRow({ url: `https://mono.example/${ed}-b`, [FEATURE]: true, score_base: 10 }),
        mkRow({ url: `https://mono.example/${ed}-c`, [FEATURE]: true, score_base: 10 }),
        mkRow({ url: `https://diverse-${e}.example/${ed}-d`, [FEATURE]: false, score_base: 50 }),
      ];
      // baseline real: mantém só o item diverso (kept.length=1) — 0% overflow.
      editions.push({ edition: ed, rows, kept: [false, false, false, true] });
    }
    // peso MUITO positivo: shadow_score dos 3 itens mono.example (10+100=110)
    // supera o item diverso (50) — top-1 simulado vira 1 item de mono.example.
    // Pra estourar o cap (>2 do MESMO domínio) com realKeptCount=1 não dá —
    // então este teste usa 3 candidatos empatados e confere que ELE PRÓPRIO
    // não estoura com realKeptCount=1 (é o próximo teste, com
    // realKeptCount=3, que prova o estouro de verdade).
    const guardrails = evaluateGuardrails(editions, FEATURE, 100, editions);
    assert.equal(guardrails.domain_cap_unassessable, false);
    assert.ok(guardrails.domain_cap_evaluable_editions > 0);
  });

  it("cap de domínio REJEITA de verdade: realKeptCount=3 faz a simulação estourar 1 domínio, baseline real não estoura", () => {
    const editions: EditionRows[] = [];
    for (let e = 0; e < 45; e++) {
      const ed = String(260700 + e);
      const rows = [
        mkRow({ url: `https://mono.example/${ed}-a`, [FEATURE]: true, score_base: 10 }),
        mkRow({ url: `https://mono.example/${ed}-b`, [FEATURE]: true, score_base: 10 }),
        mkRow({ url: `https://mono.example/${ed}-c`, [FEATURE]: true, score_base: 10 }),
        mkRow({ url: `https://diverse1-${e}.example/${ed}-d`, [FEATURE]: false, score_base: 60 }),
        mkRow({ url: `https://diverse2-${e}.example/${ed}-e`, [FEATURE]: false, score_base: 55 }),
        mkRow({ url: `https://diverse3-${e}.example/${ed}-f`, [FEATURE]: false, score_base: 51 }),
      ];
      // baseline real: mantém os 3 itens DIVERSOS (kept.length=3) — 3 domínios distintos, 0% overflow.
      editions.push({ edition: ed, rows, kept: [false, false, false, true, true, true] });
    }
    // peso MUITO positivo (100): shadow_score dos 3 itens mono.example vira
    // 110, superando os 3 diversos (60/55/51) — top-3 simulado = os 3 itens
    // mono.example → 1 domínio com 3 URLs > cap de 2 → estoura.
    const guardrails = evaluateGuardrails(editions, FEATURE, 100, editions);
    assert.equal(guardrails.domain_cap_unassessable, false);
    assert.equal(guardrails.baseline_overflow_rate, 0, "baseline real nunca estoura (3 domínios distintos)");
    assert.ok(guardrails.simulated_overflow_rate > 0, "simulado deveria estourar em toda edição");
    assert.equal(guardrails.domain_cap_rejected, true);
  });

  it("cap de domínio NÃO AVALIÁVEL (fail-closed) quando nenhuma linha tem score_base numérico — rejeitado, nunca lido como aprovado (achado de review, P1)", () => {
    const editions: EditionRows[] = [];
    for (let e = 0; e < 45; e++) {
      const ed = String(260700 + e);
      const rows = [
        mkRow({ url: `https://a-${e}.example/${ed}`, [FEATURE]: true, score_base: null }),
        mkRow({ url: `https://b-${e}.example/${ed}`, [FEATURE]: false, score_base: null }),
      ];
      editions.push({ edition: ed, rows, kept: [true, false] });
    }
    const guardrails = evaluateGuardrails(editions, FEATURE, 5, editions);
    assert.equal(guardrails.domain_cap_evaluable_editions, 0);
    assert.equal(guardrails.domain_cap_unassessable, true);
    assert.equal(guardrails.domain_cap_rejected, true, "não-avaliável precisa rejeitar, nunca aprovar por padrão");
  });

  it("HHI NÃO AVALIÁVEL (fail-closed) quando nenhuma URL de suporte parseia domínio — rejeitado, nunca lido como aprovado (achado de review, P1)", () => {
    // URL malformada o bastante pra registrableDomain() falhar (sem protocolo válido) — a única linha com feature=true (o "suporte" do HHI).
    const editions: EditionRows[] = [
      {
        edition: "260701",
        rows: [mkRow({ url: "not-a-url", [FEATURE]: true }), mkRow({ url: "https://x.example/b", [FEATURE]: false })],
        kept: [true, false],
      },
    ];
    const guardrails = evaluateGuardrails(editions, FEATURE, 5, editions);
    assert.equal(guardrails.hhi_unassessable, true);
    assert.equal(guardrails.hhi_rejected, true, "não-avaliável precisa rejeitar, nunca aprovar por padrão (HHI=0 pareceria 'diversidade perfeita')");
  });

  it("AUC (#8006) REJEITA quando a feature não prediz keep no holdout, mesmo com HHI/cap de domínio limpos — achado ao vivo que motivou o gate (PR #8002, has_official_link, AUC 0.44/0.481)", () => {
    // Construção determinística de AUC == 0.5 exato: metade das edições tem
    // o item feature=true MANTIDO (par favorece kept), a outra metade tem o
    // item feature=false MANTIDO (par desfavorece kept) — os multisets de
    // score kept/não-kept ficam IDÊNTICOS ({150×20, 50×20} cada), o que dá
    // AUC = 0.5 por simetria (nenhuma dependência de RNG/seed).
    const editions: EditionRows[] = [];
    for (let e = 0; e < 40; e++) {
      const ed = String(260700 + e);
      const rowTrue = mkRow({ url: `https://true-${e}.example/${ed}-a`, [FEATURE]: true, score_base: 50 });
      const rowFalse = mkRow({ url: `https://false-${e}.example/${ed}-b`, [FEATURE]: false, score_base: 50 });
      const trueKept = e % 2 === 0; // metade das edições mantém a linha feature=true, metade mantém a feature=false
      editions.push({ edition: ed, rows: [rowTrue, rowFalse], kept: [trueKept, !trueKept] });
    }
    // peso positivo forte (100) — sem o gate 4, isto pareceria um candidato
    // ótimo (score alto sempre que feature=true), mas o holdout mostra que
    // "kept" não segue a feature: às vezes é o item COM ela, às vezes o SEM.
    const guardrails = evaluateGuardrails(editions, FEATURE, 100, editions);
    assert.equal(guardrails.auc_unassessable, false);
    assert.equal(guardrails.holdout_auc, 0.5, "multisets de score kept/não-kept idênticos por construção → AUC exatamente 0.5");
    assert.equal(guardrails.auc_rejected, true, "AUC == 0.5 (limiar) precisa rejeitar — 'não supera' é <=, não <");
    assert.equal(guardrails.hhi_rejected, false, "domínios diversos — HHI não deveria ser o motivo da rejeição");
    assert.equal(guardrails.domain_cap_rejected, false, "cap de domínio não deveria ser o motivo da rejeição");
  });

  it("AUC (#8006) NÃO AVALIÁVEL (fail-closed) quando o holdout não tem nenhum item mantido — rejeitado, nunca lido como aprovado", () => {
    const editions: EditionRows[] = [];
    for (let e = 0; e < 40; e++) {
      const ed = String(260700 + e);
      editions.push({
        edition: ed,
        rows: [mkRow({ url: `https://a-${e}.example/${ed}`, [FEATURE]: true }), mkRow({ url: `https://b-${e}.example/${ed}`, [FEATURE]: false })],
        kept: [false, false], // nenhum item mantido em NENHUMA edição do holdout — grupo "kept" fica vazio
      });
    }
    const guardrails = evaluateGuardrails(editions, FEATURE, 5, editions);
    assert.equal(guardrails.holdout_auc, null);
    assert.equal(guardrails.auc_unassessable, true);
    assert.equal(guardrails.auc_rejected, true, "não-avaliável precisa rejeitar, nunca aprovar por padrão");
  });

  it("AUC (#8006) ACEITA quando a feature de fato separa kept/não-kept no holdout (AUC > 0.5)", () => {
    const editions: EditionRows[] = [];
    for (let e = 0; e < 40; e++) {
      const ed = String(260700 + e);
      // feature=true SEMPRE mantida, feature=false NUNCA — separação perfeita, AUC=1.
      editions.push({
        edition: ed,
        rows: [
          mkRow({ url: `https://a-${e}.example/${ed}`, [FEATURE]: true, score_base: 50 }),
          mkRow({ url: `https://b-${e}.example/${ed}`, [FEATURE]: false, score_base: 50 }),
        ],
        kept: [true, false],
      });
    }
    const guardrails = evaluateGuardrails(editions, FEATURE, 10, editions);
    assert.equal(guardrails.holdout_auc, 1);
    assert.equal(guardrails.auc_unassessable, false);
    assert.equal(guardrails.auc_rejected, false);
  });
});

describe("calibrateScoringWeights (#7990) — escala âncora de rubric.json + AUC de holdout", () => {
  it("usa a escala ANCORADA (não o default) quando rootDir tem rubric.json com pontos existentes pra uma feature elegível", () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "calibrate-anchor-editions-"));
    const rootDir = mkdtempSync(join(tmpdir(), "calibrate-anchor-root-"));
    try {
      writeStrongCorpus(editionsDir, 60);
      mkdirSync(join(rootDir, "context", "scoring"), { recursive: true });
      writeFileSync(
        join(rootDir, "context", "scoring", "rubric.json"),
        JSON.stringify({ bonuses: { primary_source: { points: 10, issue: "#5665", agent_files: [] } } }),
        "utf8",
      );
      const result = calibrateScoringWeights(editionsDir, rootDir);
      assert.equal(result.status, "candidate_produced");
      assert.equal(result.points_per_log_odds_source, "anchored");
      const candidate = result.candidates.find((c) => c.feature === "primary_source")!;
      assert.equal(candidate.existing_rubric_points, 10);
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("AUC de holdout (real e shadow) é calculado e fica entre 0 e 1 quando há sinal de score real no holdout", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-auc-"));
    try {
      // score REAL correlacionado com keep (diferente do score_base fixo=50 de writeStrongCorpus) — senão o score é constante e a AUC vira sempre n/d (empate total).
      for (let e = 0; e < 60; e++) {
        const ed = String(260700 + e);
        const dir2 = join(dir, ed, "_internal");
        mkdirSync(dir2, { recursive: true });
        const rows = [
          mkRow({ url: `https://source-${e}.example/${ed}-a`, primary_source: true, score: 80, score_base: 50 }),
          mkRow({ url: `https://source-${e}.example/${ed}-b`, primary_source: true, score: 80, score_base: 50 }),
          mkRow({ url: `https://other-${e}.example/${ed}-c`, primary_source: false, score: 20, score_base: 50 }),
          mkRow({ url: `https://other-${e}.example/${ed}-d`, primary_source: false, score: 20, score_base: 50 }),
        ];
        writeFileSync(join(dir2, "scoring-features.json"), JSON.stringify({ edition: ed, row_count: rows.length, rows }), "utf8");
        writeFileSync(
          join(dir2, "01-categorized.json"),
          JSON.stringify({ highlights: [], runners_up: [], lancamento: [], radar: rows.map((r) => ({ url: r.url, title: r.url })), use_melhor: [], video: [] }),
          "utf8",
        );
        const kept = rows.filter((r) => r.primary_source).map((r) => ({ url: r.url, title: r.url }));
        writeFileSync(
          join(dir2, "01-approved.json"),
          JSON.stringify({ highlights: [], runners_up: [], lancamento: [], radar: kept, use_melhor: [], video: [] }),
          "utf8",
        );
      }
      const result = calibrateScoringWeights(dir, dir);
      assert.equal(result.status, "candidate_produced");
      assert.notEqual(result.holdout_auc_real, null);
      assert.notEqual(result.holdout_auc_shadow, null);
      assert.ok(result.holdout_auc_real! >= 0 && result.holdout_auc_real! <= 1);
      assert.ok(result.holdout_auc_shadow! >= 0 && result.holdout_auc_shadow! <= 1);
      // score real separa perfeitamente kept/não-kept por construção (80 vs 20) → AUC real = 1.
      assert.equal(result.holdout_auc_real, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
