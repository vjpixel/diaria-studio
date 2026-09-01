import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateGlmLaneGate,
  computeGlmLaneState,
  type GlmLaneState,
  type GlmLaneUnitRecord,
} from "../scripts/lib/glm-lane-gate.ts";

const GREEN: GlmLaneState = {
  unitsDispatched: 2,
  unitsCap: 10,
  firstThreeHadAnyPr: null,
  avgReviewRounds: null,
  costPerIssueUsd: null,
  sonnetLaneCostPerIssueUsd: null,
};

describe("evaluateGlmLaneGate (#6930) — caminho feliz", () => {
  it("estado neutro/sem dado suficiente → allow", () => {
    const result = evaluateGlmLaneGate(GREEN);
    assert.equal(result.allow, true);
  });
});

describe("evaluateGlmLaneGate (#6930) — cada critério de morte", () => {
  it("teto de unidades atingido → deny", () => {
    const result = evaluateGlmLaneGate({ ...GREEN, unitsDispatched: 10 });
    assert.equal(result.allow, false);
    assert.match(result.reason, /teto de 10 unidades/);
  });

  it("teto de unidades ULTRAPASSADO (>10) também nega, nunca só '=='", () => {
    const result = evaluateGlmLaneGate({ ...GREEN, unitsDispatched: 15 });
    assert.equal(result.allow, false);
  });

  it("zero PRs nos 3 primeiros despachos → deny", () => {
    const result = evaluateGlmLaneGate({ ...GREEN, firstThreeHadAnyPr: false });
    assert.equal(result.allow, false);
    assert.match(result.reason, /6922/);
  });

  it("ao menos 1 PR nos 3 primeiros → não nega por esse critério", () => {
    const result = evaluateGlmLaneGate({ ...GREEN, firstThreeHadAnyPr: true });
    assert.equal(result.allow, true);
  });

  it("firstThreeHadAnyPr null (menos de 3 unidades) → não nega por esse critério", () => {
    const result = evaluateGlmLaneGate({ ...GREEN, firstThreeHadAnyPr: null });
    assert.equal(result.allow, true);
  });

  it("média de rodadas de review > 2 → deny", () => {
    const result = evaluateGlmLaneGate({ ...GREEN, avgReviewRounds: 2.5 });
    assert.equal(result.allow, false);
    assert.match(result.reason, /rodadas de review/);
  });

  it("média de rodadas de review == 2 (limite) → não nega", () => {
    const result = evaluateGlmLaneGate({ ...GREEN, avgReviewRounds: 2 });
    assert.equal(result.allow, true);
  });

  it("avgReviewRounds null (sem dado) → nunca bloqueia", () => {
    const result = evaluateGlmLaneGate({ ...GREEN, avgReviewRounds: null });
    assert.equal(result.allow, true);
  });

  it("$/issue GLM acima do lane Sonnet → deny", () => {
    const result = evaluateGlmLaneGate({ ...GREEN, costPerIssueUsd: 5, sonnetLaneCostPerIssueUsd: 3 });
    assert.equal(result.allow, false);
    assert.match(result.reason, /\$\/issue/);
  });

  it("$/issue GLM abaixo do lane Sonnet → não nega", () => {
    const result = evaluateGlmLaneGate({ ...GREEN, costPerIssueUsd: 1, sonnetLaneCostPerIssueUsd: 3 });
    assert.equal(result.allow, true);
  });

  it("baseline do Sonnet ausente (null) → critério de custo nunca decide, mesmo com custo GLM alto", () => {
    const result = evaluateGlmLaneGate({ ...GREEN, costPerIssueUsd: 999, sonnetLaneCostPerIssueUsd: null });
    assert.equal(result.allow, true);
  });

  it("custo GLM ausente (null) → critério de custo nunca decide, mesmo com baseline Sonnet baixa", () => {
    const result = evaluateGlmLaneGate({ ...GREEN, costPerIssueUsd: null, sonnetLaneCostPerIssueUsd: 0.01 });
    assert.equal(result.allow, true);
  });
});

describe("evaluateGlmLaneGate (#6930) — precedência", () => {
  it("teto de unidades vence sobre qualquer outro critério (checado primeiro)", () => {
    const result = evaluateGlmLaneGate({
      ...GREEN,
      unitsDispatched: 10,
      firstThreeHadAnyPr: true,
      avgReviewRounds: 0,
      costPerIssueUsd: 0,
      sonnetLaneCostPerIssueUsd: 999,
    });
    assert.equal(result.allow, false);
    assert.match(result.reason, /teto/);
  });
});

function unit(overrides: Partial<GlmLaneUnitRecord> = {}): GlmLaneUnitRecord {
  return {
    issue: 1,
    startedAt: "2026-09-01T00:00:00Z",
    endedAt: "2026-09-01T00:10:00Z",
    durationSec: 600,
    costUsd: 0.01,
    prNumber: 100,
    reviewRounds: null,
    ...overrides,
  };
}

describe("computeGlmLaneState (#6930)", () => {
  it("0 registros → estado inicial neutro (tudo null, unitsDispatched=0)", () => {
    const state = computeGlmLaneState([], { unitsCap: 10, sonnetLaneCostPerIssueUsd: null });
    assert.equal(state.unitsDispatched, 0);
    assert.equal(state.firstThreeHadAnyPr, null);
    assert.equal(state.avgReviewRounds, null);
    assert.equal(state.costPerIssueUsd, null);
  });

  it("< 3 registros → firstThreeHadAnyPr permanece null (não avaliável ainda)", () => {
    const state = computeGlmLaneState([unit(), unit()], { unitsCap: 10, sonnetLaneCostPerIssueUsd: null });
    assert.equal(state.firstThreeHadAnyPr, null);
  });

  it("exatamente 3 registros, nenhum com PR → firstThreeHadAnyPr=false", () => {
    const state = computeGlmLaneState(
      [unit({ prNumber: null }), unit({ prNumber: null }), unit({ prNumber: null })],
      { unitsCap: 10, sonnetLaneCostPerIssueUsd: null },
    );
    assert.equal(state.firstThreeHadAnyPr, false);
  });

  it("3 registros, 1 com PR → firstThreeHadAnyPr=true", () => {
    const state = computeGlmLaneState(
      [unit({ prNumber: null }), unit({ prNumber: 42 }), unit({ prNumber: null })],
      { unitsCap: 10, sonnetLaneCostPerIssueUsd: null },
    );
    assert.equal(state.firstThreeHadAnyPr, true);
  });

  it("> 3 registros: só os 3 PRIMEIROS contam pro critério (unidade 4 com PR não salva um início ruim)", () => {
    const state = computeGlmLaneState(
      [unit({ prNumber: null }), unit({ prNumber: null }), unit({ prNumber: null }), unit({ prNumber: 42 })],
      { unitsCap: 10, sonnetLaneCostPerIssueUsd: null },
    );
    assert.equal(state.firstThreeHadAnyPr, false);
  });

  it("avgReviewRounds ignora registros com reviewRounds null (sem dado ainda)", () => {
    const state = computeGlmLaneState(
      [unit({ reviewRounds: null }), unit({ reviewRounds: 4 }), unit({ reviewRounds: 2 })],
      { unitsCap: 10, sonnetLaneCostPerIssueUsd: null },
    );
    assert.equal(state.avgReviewRounds, 3);
  });

  it("costPerIssueUsd só considera unidades COM pr aberta e custo conhecido", () => {
    const state = computeGlmLaneState(
      [unit({ prNumber: 1, costUsd: 0.1 }), unit({ prNumber: null, costUsd: 999 }), unit({ prNumber: 2, costUsd: 0.3 })],
      { unitsCap: 10, sonnetLaneCostPerIssueUsd: null },
    );
    assert.equal(state.costPerIssueUsd, 0.2); // média de 0.1 e 0.3, ignora a sem PR
  });

  it("sonnetLaneCostPerIssueUsd é repassado como veio (não calculado aqui)", () => {
    const state = computeGlmLaneState([], { unitsCap: 10, sonnetLaneCostPerIssueUsd: 1.23 });
    assert.equal(state.sonnetLaneCostPerIssueUsd, 1.23);
  });
});
