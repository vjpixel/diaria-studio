/**
 * test/escopo-residual-route.test.ts (#6437)
 *
 * Regression test for the escopo-residual routing trigger added in #6437.
 * When `check-overnight-comment-coverage` detects a `mergeada` issue whose
 * PR uses `REFS #N, NÃO CLOSES` (residual scope not closed by the merge),
 * the script must surface it for explicit routing via `route-issue`.
 *
 * This test covers the PURE logic (no `gh` calls) — `deriveCandidateIssues`
 * already returns these as `CandidateIssue` with `reason:
 * "refs-not-closes-sem-comentario"` and `pr` set, which the CLI then
 * iterates to build the `residualIssues` list. The test verifies that
 * derivation is correct and that the candidate shape is what the CLI's
 * residual-routing loop expects.
 *
 * #633: PR de bugfix exige teste de regression — this file is that test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveCandidateIssues,
  isRefsNotClosesBody,
  type PlanIssueLike,
} from "../scripts/lib/overnight-comment-coverage.ts";

describe("#6437 escopo-residual — deriveCandidateIssues", () => {
  it("REFS-not-Closes issue é candidata com pr definido (shape que o CLI de roteamento espera)", () => {
    const issues: PlanIssueLike[] = [
      { number: 5791, status: "mergeada", pr: 6214 },
    ];
    const prBodies = new Map<number, string | null>([
      [6214, "REFS #5791, NÃO CLOSES (causa raiz não confirmada)"],
    ]);
    const candidates = deriveCandidateIssues(issues, prBodies);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].number, 5791);
    assert.equal(candidates[0].reason, "refs-not-closes-sem-comentario");
    assert.equal(candidates[0].pr, 6214);
  });

  it("issue sem pr definido NUNCA entra no bloco de roteamento residual", () => {
    // O CLI itera `candidates` filtrando `c.pr !== undefined` — uma
    // candidata sem `pr` não deve causar roteamento.
    const issues: PlanIssueLike[] = [
      { number: 5800, status: "pulada", motivo: "bloqueio-externo" },
    ];
    const candidates = deriveCandidateIssues(issues, new Map());
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].pr, undefined);
  });

  it("issue mergeada com Closes normal NÃO é candidata (não há escopo residual)", () => {
    const issues: PlanIssueLike[] = [
      { number: 5790, status: "mergeada", pr: 6213 },
    ];
    const prBodies = new Map<number, string | null>([
      [6213, "Closes #5790"],
    ]);
    const candidates = deriveCandidateIssues(issues, prBodies);
    assert.equal(candidates.length, 0);
  });
});

describe("#6437 escopo-residual — isRefsNotClosesBody", () => {
  it("detecta variações de acento e espaço no padrão REFS-not-Closes", () => {
    assert.equal(isRefsNotClosesBody("REFS #5791, NAO CLOSES (causa raiz)", 5791), true);
    assert.equal(isRefsNotClosesBody("REFS #5791, NÃO CLOSES", 5791), true);
    assert.equal(isRefsNotClosesBody("REFS #5791 NÃO CLOSES", 5791), true);
  });

  it("não confunde com Closes normal", () => {
    assert.equal(isRefsNotClosesBody("Closes #5791", 5791), false);
  });

  it("body vazio/nulo nunca é candidato", () => {
    assert.equal(isRefsNotClosesBody(null, 5791), false);
    assert.equal(isRefsNotClosesBody(undefined, 5791), false);
    assert.equal(isRefsNotClosesBody("", 5791), false);
  });

  it("não dispara para issue diferente daquela citada no PR", () => {
    assert.equal(isRefsNotClosesBody("REFS #5791, NÃO CLOSES", 5800), false);
  });
});