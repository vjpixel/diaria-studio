/**
 * test/lib/duplicate-preflight-provenance.test.ts (#7801)
 *
 * Regressão determinística: preflight deve detectar duplicidade quando
 * o fix está em master sob OUTRO número, mas a MESMA PROVENIÊNCIA
 * (range de diff / PR / commit de origem) aparece nos commits.
 *
 * Caso concreto da issue: #7634 (origem #7605 / 44205ff0) — fix mergeado
 * como #7743 (commit fb428a36). O grep por #7634 não acha; o grep pelo
 * identificador de origem acha.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { assessDuplicatePreflight } from "../../scripts/lib/issue-duplicate-preflight.ts";

describe("duplicate-preflight provenance (#7801)", () => {
  test("detecta closess via provenance mesmo quando #N não aparece no commit", () => {
    // Simula commit de master que cita #7743 (número do fix) e 44205ff0 (provenance de #7634)
    const provenanceCommits = [
      {
        sha: "fb428a36abc123",
        subject: "fix(#7743): resolve selfAuthorizeMerge",
        body: "fix(#7743): resolve selfAuthorizeMerge\n\nCloses #7743",
        authorDateIso: "2026-09-09T10:00:00Z",
      },
    ];
    const result = assessDuplicatePreflight({
      issueNumber: 7634,
      issueUpdatedAt: "2026-09-08T12:00:00Z",
      commits: [], // #7634 não aparece diretamente em master
      provenanceCommits,
    });
    assert.strictEqual(result.verdict, "closes-should-be-closed");
    assert.ok(result.matchingCommits.length > 0);
    assert.ok(result.recommendation.includes("detectado via proveniência"));
  });

  test("não inventa duplicidade quando provenance não casa", () => {
    const result = assessDuplicatePreflight({
      issueNumber: 9999,
      commits: [],
      provenanceCommits: [{ sha: "aaa", subject: "x", body: "ref #other", authorDateIso: "2026-09-09T10:00:00Z" }],
    });
    // Sem closes/refs no commit de provenance => resíduo declarado (conservador)
    assert.strictEqual(result.verdict, "refs-declared-residue");
  });

  test("não marca closes para commit direto que menciona outra issue (falso positivo #7801)", () => {
    // Commit direto por #7634 que contém "Closes #7743" — deve ser unknown,
    // NÃO closes-should-be-closed (o fix pertence a outra issue).
    const result = assessDuplicatePreflight({
      issueNumber: 7634,
      commits: [{ sha: "directbad", subject: "x", body: "Closes #7743", authorDateIso: "2026-09-09T10:00:00Z" }],
      provenanceCommits: [],
    });
    assert.strictEqual(result.verdict, "refs-declared-residue");
    assert.strictEqual(result.matchingCommits[0].closeMarker, "unknown");
  });

  test("unifica commits de #N e provenance sem duplicar SHA", () => {
    const sharedSha = "shareddeadbeef";
    const result = assessDuplicatePreflight({
      issueNumber: 100,
      commits: [{ sha: sharedSha, subject: "closes #100", body: "Closes #100", authorDateIso: "2026-09-09T10:00:00Z" }],
      provenanceCommits: [{ sha: sharedSha, subject: "closes #100", body: "Closes #100", authorDateIso: "2026-09-09T10:00:00Z" }],
    });
    assert.strictEqual(result.matchingCommits.length, 1); // dedup por SHA
    assert.strictEqual(result.verdict, "closes-should-be-closed");
  });

  test("regressão #7803: commit direto que menciona outra issue NÃO herda closes (só provenance aplica fallback)", () => {
    const res = assessDuplicatePreflight({
      issueNumber: 7634,
      commits: [{ sha: "d", subject: "fix(#7743)", body: "Closes #7743\nresolve", authorDateIso: "2026-09-09T10:00:00Z" }],
      provenanceCommits: [],
    });
    assert.strictEqual(res.matchingCommits[0].closeMarker, "unknown");
    assert.notStrictEqual(res.matchingCommits[0].closeMarker, "closes");
    assert.strictEqual(res.verdict, "refs-declared-residue");
  });
});
