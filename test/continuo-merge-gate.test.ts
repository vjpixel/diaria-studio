import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateContinuoMergeGate,
  type ContinuoMergeGateInput,
} from "../scripts/lib/continuo-merge-gate.ts";

// Input "tudo verde" — cada teste de negação parte disto e vira UM campo
// ruim por vez, isolando qual portão decidiu.
const GREEN: ContinuoMergeGateInput = {
  superseded: false,
  verdict: "approve",
  currentHeadSha: "abc123",
  reviewedHeadSha: "abc123",
  sensitive: false,
  checksVerdict: "pass",
  mergeable: "MERGEABLE",
  diffLineCount: 10,
  diffLineThreshold: 500,
};

describe("evaluateContinuoMergeGate (#6926) — caminho feliz", () => {
  it("tudo verde → merge", () => {
    const result = evaluateContinuoMergeGate(GREEN);
    assert.equal(result.action, "merge");
  });
});

describe("evaluateContinuoMergeGate (#6926) — cada portão NEGANDO merge", () => {
  it("superseded=true → reject, incondicional (vence mesmo com verdict=reject também)", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, superseded: true, verdict: "reject" });
    assert.equal(result.action, "reject");
    assert.match(result.reason, /superseded/);
  });

  it("verdict=reject → reject", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, verdict: "reject" });
    assert.equal(result.action, "reject");
    assert.match(result.reason, /reject/);
  });

  it("verdict=null (sem review independente, ou marcador legado sem campo verdict=) → escalate, nunca merge", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, verdict: null });
    assert.equal(result.action, "escalate");
  });

  it("HEAD mudou depois do início da revisão (corrida #5716) → escalate, não reject", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, currentHeadSha: "def456" });
    assert.equal(result.action, "escalate");
    assert.match(result.reason, /5716/);
  });

  it("currentHeadSha null (gh falhou ao buscar HEAD atual) → escalate", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, currentHeadSha: null });
    assert.equal(result.action, "escalate");
  });

  it("sensitive=true (caminho sensível) → escalate", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, sensitive: true });
    assert.equal(result.action, "escalate");
  });

  it("sensitive=null (guard falhou/saída inválida) → escalate, fail-closed", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, sensitive: null });
    assert.equal(result.action, "escalate");
    assert.match(result.reason, /falhou|inválida/);
  });

  it("CI vermelho (fail) → escalate", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, checksVerdict: "fail" });
    assert.equal(result.action, "escalate");
  });

  it("CI pendente → escalate", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, checksVerdict: "pending" });
    assert.equal(result.action, "escalate");
  });

  it("CI error → escalate", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, checksVerdict: "error" });
    assert.equal(result.action, "escalate");
  });

  it("CI blocked_by_conflict → escalate", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, checksVerdict: "blocked_by_conflict" });
    assert.equal(result.action, "escalate");
  });

  it("mergeable=CONFLICTING → escalate", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, mergeable: "CONFLICTING" });
    assert.equal(result.action, "escalate");
  });

  it("mergeable=UNKNOWN → escalate", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, mergeable: "UNKNOWN" });
    assert.equal(result.action, "escalate");
  });

  it("mergeable=null → escalate", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, mergeable: null });
    assert.equal(result.action, "escalate");
  });

  it("diffLineCount null (não foi possível medir) → escalate, nunca assume diff pequeno", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, diffLineCount: null });
    assert.equal(result.action, "escalate");
  });

  it("diffLineCount >= threshold → escalate", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, diffLineCount: 500 });
    assert.equal(result.action, "escalate");
  });

  it("diffLineCount == threshold - 1 → ainda merge (limite exclusivo)", () => {
    const result = evaluateContinuoMergeGate({ ...GREEN, diffLineCount: 499 });
    assert.equal(result.action, "merge");
  });
});

describe("evaluateContinuoMergeGate (#6926) — ordem de precedência", () => {
  it("superseded vence sobre HEAD divergente, CI vermelho, etc — primeira condição decide", () => {
    const result = evaluateContinuoMergeGate({
      ...GREEN,
      superseded: true,
      currentHeadSha: "outro-sha",
      checksVerdict: "fail",
      sensitive: true,
    });
    assert.equal(result.action, "reject");
    assert.match(result.reason, /superseded/);
  });
});
