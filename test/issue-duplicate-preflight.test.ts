/**
 * test/issue-duplicate-preflight.test.ts (#7020)
 *
 * Cobre `scripts/lib/issue-duplicate-preflight.ts` (lógica pura, os 3
 * vereditos) e a regressão real: os 4 casos da rodada 260901b (#6875,
 * #6822/#6857, #6802, #6798 itens 1/3) já resolvidas em master antes do
 * dispatch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCommitCloseMarker,
  citesIssueNumber,
  assessDuplicatePreflight,
  type MasterCommitInfo,
} from "../scripts/lib/issue-duplicate-preflight.ts";

function commit(overrides: Partial<MasterCommitInfo> = {}): MasterCommitInfo {
  return {
    sha: "abc123def456",
    subject: "fix(#6875): algo",
    body: "fix(#6875): algo\n\nCloses #6875",
    authorDateIso: "2026-08-20T10:00:00Z",
    ...overrides,
  };
}

describe("parseCommitCloseMarker", () => {
  it("Closes #N → closes", () => {
    assert.equal(parseCommitCloseMarker("fix: algo\n\nCloses #6875", 6875), "closes");
  });

  it("case-insensitive: closes #N minúsculo também casa", () => {
    assert.equal(parseCommitCloseMarker("closes #6875", 6875), "closes");
  });

  it("REFS #N, NÃO CLOSES (...) → refs", () => {
    assert.equal(
      parseCommitCloseMarker("REFS #6798, NÃO CLOSES (item 5 pendente)", 6798),
      "refs",
    );
  });

  it("sem marcador nenhum → unknown", () => {
    assert.equal(parseCommitCloseMarker("fix(#6875): menciona a issue sem marcador", 6875), "unknown");
  });

  it("Closes de OUTRA issue não casa com a issue perguntada", () => {
    assert.equal(parseCommitCloseMarker("Closes #6876", 6875), "unknown");
  });

  it("#N não casa dentro de #N0 nem #1N (boundary de dígito)", () => {
    assert.equal(citesIssueNumber("Closes #68750", 6875), false);
    assert.equal(citesIssueNumber("Closes #16875", 6875), false);
    assert.equal(citesIssueNumber("Closes #6875", 6875), true);
    assert.equal(citesIssueNumber("Closes #6875.", 6875), true);
    assert.equal(citesIssueNumber("(#6875)", 6875), true);
  });
});

describe("assessDuplicatePreflight — 3 vereditos", () => {
  it("veredito 1: sem commit em master → not-in-master", () => {
    const r = assessDuplicatePreflight({ issueNumber: 6875, commits: [] });
    assert.equal(r.verdict, "not-in-master");
    assert.equal(r.matchingCommits.length, 0);
    assert.equal(r.resolvedAfterLastUpdate, false);
  });

  it("veredito 2: commit com Closes já em master, issue ainda aberta → closes-should-be-closed", () => {
    const r = assessDuplicatePreflight({
      issueNumber: 6875,
      issueUpdatedAt: "2026-08-15T00:00:00Z",
      commits: [commit({ body: "fix(#6875): resolve\n\nCloses #6875", authorDateIso: "2026-08-20T10:00:00Z" })],
    });
    assert.equal(r.verdict, "closes-should-be-closed");
    assert.equal(r.matchingCommits.length, 1);
    assert.match(r.recommendation, /CLOSEOUT/);
  });

  it("veredito 3: commit com Refs (resíduo declarado) → refs-declared-residue", () => {
    const r = assessDuplicatePreflight({
      issueNumber: 6798,
      commits: [
        commit({
          sha: "2fd157bb",
          body: "fix(#6798): corta alarme\n\nREFS #6798, NÃO CLOSES (item 5 pendente)",
          authorDateIso: "2026-09-01T00:00:00Z",
        }),
      ],
    });
    assert.equal(r.verdict, "refs-declared-residue");
    assert.match(r.recommendation, /resíduo/);
  });

  it("commit sem marcador (unknown) trata como refs-declared-residue (conservador)", () => {
    const r = assessDuplicatePreflight({
      issueNumber: 6802,
      commits: [commit({ body: "fix(#6802): sem marcador formal", sha: "cafefeed" })],
    });
    assert.equal(r.verdict, "refs-declared-residue");
  });

  it("resolvedAfterLastUpdate: commit posterior ao updatedAt da issue → true", () => {
    const r = assessDuplicatePreflight({
      issueNumber: 6852,
      issueUpdatedAt: "2026-08-10T00:00:00Z",
      commits: [commit({ body: "Closes #6852", authorDateIso: "2026-08-25T00:00:00Z" })],
    });
    assert.equal(r.resolvedAfterLastUpdate, true);
  });

  it("resolvedAfterLastUpdate: commit ANTERIOR ao updatedAt → false", () => {
    const r = assessDuplicatePreflight({
      issueNumber: 6852,
      issueUpdatedAt: "2026-08-25T00:00:00Z",
      commits: [commit({ body: "Closes #6852", authorDateIso: "2026-08-10T00:00:00Z" })],
    });
    assert.equal(r.resolvedAfterLastUpdate, false);
  });

  it("resolvedAfterLastUpdate: sem issueUpdatedAt → sempre false, nunca lança", () => {
    const r = assessDuplicatePreflight({
      issueNumber: 6852,
      commits: [commit({ body: "Closes #6852", authorDateIso: "2026-08-10T00:00:00Z" })],
    });
    assert.equal(r.resolvedAfterLastUpdate, false);
  });

  it("múltiplos commits: usa o mais RECENTE pra decidir o veredito", () => {
    const r = assessDuplicatePreflight({
      issueNumber: 6900,
      commits: [
        commit({ sha: "old1", body: "REFS #6900, NÃO CLOSES (parcial)", authorDateIso: "2026-08-01T00:00:00Z" }),
        commit({ sha: "new1", body: "Closes #6900", authorDateIso: "2026-08-20T00:00:00Z" }),
      ],
    });
    assert.equal(r.verdict, "closes-should-be-closed");
    assert.equal(r.matchingCommits[0].sha, "new1");
  });
});
