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
import { describe, it, expect } from "vitest";
import { assessDuplicatePreflight } from "../../scripts/lib/issue-duplicate-preflight.ts";

describe("duplicate-preflight provenance (#7801)", () => {
  it("detecta closess via provenance mesmo quando #N não aparece no commit", () => {
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
    expect(result.verdict).toBe("closes-should-be-closed");
    expect(result.matchingCommits.length).toBeGreaterThan(0);
    expect(result.recommendation).toContain("detectado via proveniência");
  });

  it("não inventa duplicidade quando provenance não casa", () => {
    const result = assessDuplicatePreflight({
      issueNumber: 9999,
      commits: [],
      provenanceCommits: [{ sha: "aaa", subject: "x", body: "ref #other", authorDateIso: "2026-09-09T10:00:00Z" }],
    });
    // Sem closes/refs no commit de provenance => resíduo declarado (conservador)
    expect(result.verdict).toBe("refs-declared-residue");
  });

  it("unifica commits de #N e provenance sem duplicar SHA", () => {
    const sharedSha = "shareddeadbeef";
    const result = assessDuplicatePreflight({
      issueNumber: 100,
      commits: [{ sha: sharedSha, subject: "closes #100", body: "Closes #100", authorDateIso: "2026-09-09T10:00:00Z" }],
      provenanceCommits: [{ sha: sharedSha, subject: "closes #100", body: "Closes #100", authorDateIso: "2026-09-09T10:00:00Z" }],
    });
    expect(result.matchingCommits.length).toBe(1); // dedup por SHA
    expect(result.verdict).toBe("closes-should-be-closed");
  });
});
