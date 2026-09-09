/**
 * test/lib/issue-open-pr-check.test.ts (#7788)
 *
 * Regressão determinística do módulo puro de preflight de PR aberta:
 * reproduz o caso real da issue (PR `continuo/fix-7746-pr-cap` cobrindo
 * #7746, sem número no título) + os falsos-positivo/negativo que a issue
 * exige tratar explicitamente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessOpenPrCoverage,
  deriveOpenPrCiState,
  type OpenPrInfo,
} from "../../scripts/lib/issue-open-pr-check.ts";

function pr(overrides: Partial<OpenPrInfo>): OpenPrInfo {
  return {
    number: 1,
    title: "wip",
    body: "",
    headRefName: "some-branch",
    author: { login: "someone" },
    updatedAt: "2026-09-09T10:00:00Z",
    statusCheckRollup: [],
    ...overrides,
  };
}

describe("assessOpenPrCoverage (#7788)", () => {
  it("caso real da issue: PR continuo/fix-7746-pr-cap cobre #7746 via branch, sem #N no título", () => {
    const prs = [
      pr({
        number: 7783,
        title: "fix: cap de PRs paralelas no continuo",
        body: "Implementa o cap de worktrees concorrentes.",
        headRefName: "continuo/fix-7746-pr-cap",
        author: { login: "vjpixel" },
        updatedAt: "2026-09-09T09:18:00Z",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    ];
    const result = assessOpenPrCoverage(7746, prs);
    assert.equal(result.verdict, "open-pr-covers-scope");
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].number, 7783);
    assert.equal(result.matches[0].matchKind, "branch-pattern");
    assert.equal(result.matches[0].ciState, "green");
  });

  it("2º caso real: continuo/fix-7738-daily-send-queue cobre #7738", () => {
    const prs = [
      pr({
        number: 7784,
        title: "fix: fila de envio diário",
        body: "",
        headRefName: "continuo/fix-7738-daily-send-queue",
        author: { login: "vjpixel" },
        updatedAt: "2026-09-09T10:29:00Z",
      }),
    ];
    const result = assessOpenPrCoverage(7738, prs);
    assert.equal(result.verdict, "open-pr-covers-scope");
    assert.equal(result.matches[0].matchKind, "branch-pattern");
  });

  it("#77 não casa com #7788 (boundary de dígito)", () => {
    const prs = [
      pr({
        number: 1,
        title: "fix(#77): algo completamente não relacionado",
        body: "Closes #77",
        headRefName: "fix-77-outra-coisa",
      }),
    ];
    const result = assessOpenPrCoverage(7788, prs);
    assert.equal(result.verdict, "no-open-pr");
    assert.equal(result.matches.length, 0);
  });

  it("PR que só MENCIONA a issue em prosa não conta como cobertura de escopo", () => {
    const prs = [
      pr({
        number: 2,
        title: "fix: outra coisa qualquer",
        body: "Relacionado a #7788, mas não resolve isso aqui.",
        headRefName: "fix-outra-coisa",
      }),
    ];
    const result = assessOpenPrCoverage(7788, prs);
    assert.equal(result.verdict, "no-open-pr");
    // Visível, mas não eleva o veredito.
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].matchKind, "mention-only");
  });

  it("marcador closes explícito no corpo conta como cobertura mesmo sem branch na convenção", () => {
    const prs = [
      pr({
        number: 3,
        title: "fix: sem número no título",
        body: "Closes #7788 de vez.",
        headRefName: "minha-branch-qualquer",
      }),
    ];
    const result = assessOpenPrCoverage(7788, prs);
    assert.equal(result.verdict, "open-pr-covers-scope");
    assert.equal(result.matches[0].matchKind, "closes-marker");
  });

  it("nenhuma PR aberta → no-open-pr, matches vazio", () => {
    const result = assessOpenPrCoverage(7788, []);
    assert.equal(result.verdict, "no-open-pr");
    assert.deepEqual(result.matches, []);
  });

  it("closes-marker vence branch-pattern quando ambos aparecem em PRs diferentes", () => {
    const prs = [
      pr({ number: 10, headRefName: "fix-7788-a", title: "a", body: "" }),
      pr({ number: 11, headRefName: "outra", title: "b", body: "Fixes #7788" }),
    ];
    const result = assessOpenPrCoverage(7788, prs);
    assert.equal(result.verdict, "open-pr-covers-scope");
    assert.equal(result.matches[0].matchKind, "closes-marker");
    assert.equal(result.matches[0].number, 11);
  });
});

describe("deriveOpenPrCiState (#7788)", () => {
  it("payload ausente/malformado → unknown, nunca pending nem green", () => {
    assert.equal(deriveOpenPrCiState(undefined), "unknown");
    assert.equal(deriveOpenPrCiState(null), "unknown");
  });

  it("array vazio → pending (checks ainda não registrados)", () => {
    assert.equal(deriveOpenPrCiState([]), "pending");
  });

  it("todos COMPLETED/SUCCESS → green", () => {
    assert.equal(
      deriveOpenPrCiState([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "NEUTRAL" },
      ]),
      "green",
    );
  });

  it("algum FAILURE → failing", () => {
    assert.equal(
      deriveOpenPrCiState([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ]),
      "failing",
    );
  });

  it("algum ainda rodando, nenhum falhou → pending", () => {
    assert.equal(
      deriveOpenPrCiState([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: null },
      ]),
      "pending",
    );
  });
});
