import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectCiFixCandidate, CI_FIX_ATTEMPTED_LABEL, type CiFixCandidatePr } from "../scripts/lib/continuo-ci-fixer-eligibility.ts";

function pr(overrides: Partial<CiFixCandidatePr> & Pick<CiFixCandidatePr, "number">): CiFixCandidatePr {
  return {
    headRefName: `continuo/fix-${overrides.number}-x`,
    ciVerdict: "fail",
    labels: [],
    ...overrides,
  };
}

describe("selectCiFixCandidate (#7446 item 3)", () => {
  it("nenhuma PR → null", () => {
    assert.equal(selectCiFixCandidate([]), null);
  });

  it("1 PR continuo/* com CI fail, sem label → ela mesma", () => {
    assert.equal(selectCiFixCandidate([pr({ number: 7429 })]), 7429);
  });

  it("PR com CI pass → não é candidata", () => {
    assert.equal(selectCiFixCandidate([pr({ number: 7429, ciVerdict: "pass" })]), null);
  });

  it("PR com CI pending → não é candidata (não é 'sei que está quebrado')", () => {
    assert.equal(selectCiFixCandidate([pr({ number: 7429, ciVerdict: "pending" })]), null);
  });

  it("PR com CI error → não é candidata (não é veredito real sobre o código)", () => {
    assert.equal(selectCiFixCandidate([pr({ number: 7429, ciVerdict: "error" })]), null);
  });

  it("PR com CI blocked_by_conflict → não é candidata (precisa rebase, não fix de código)", () => {
    assert.equal(selectCiFixCandidate([pr({ number: 7429, ciVerdict: "blocked_by_conflict" })]), null);
  });

  it("PR já com o label de tentativa → não é candidata de novo (cap de 1 tentativa)", () => {
    assert.equal(selectCiFixCandidate([pr({ number: 7429, labels: [CI_FIX_ATTEMPTED_LABEL] })]), null);
  });

  it("branch fora de continuo/* com CI fail → não é candidata (só PR própria do contínuo)", () => {
    assert.equal(selectCiFixCandidate([pr({ number: 7416, headRefName: "develop/clarice-daily-cutover-7406" })]), null);
  });

  it("múltiplas candidatas → a mais antiga (menor number)", () => {
    const prs = [pr({ number: 7432 }), pr({ number: 7429 }), pr({ number: 7440 })];
    assert.equal(selectCiFixCandidate(prs), 7429);
  });

  it("reprodução do achado 04-05/09/2026 (#7429/#7432 vermelhas, mistura com PRs saudáveis)", () => {
    const prs = [
      pr({ number: 7403, headRefName: "chore/desliga-rampa-gmail-stage0", ciVerdict: "pass" }),
      pr({ number: 7404, headRefName: "continuo/rescue-20260904T040307Z-2689057-34a8", ciVerdict: "pass" }),
      pr({ number: 7429, headRefName: "continuo/fix-7417-shape-guard-engagement", ciVerdict: "fail" }),
      pr({ number: 7432, headRefName: "continuo/fix-7418-confirmed-empty-flag", ciVerdict: "fail" }),
    ];
    assert.equal(selectCiFixCandidate(prs), 7429);
  });
});
