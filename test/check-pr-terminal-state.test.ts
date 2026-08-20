/**
 * test/check-pr-terminal-state.test.ts (#5831)
 *
 * Cobre `scripts/lib/pr-terminal-state.ts` — a lógica pura do gate de
 * "todo PR aberto por esta sessão chegou a um estado terminal". O I/O (gh
 * CLI) fica no entrypoint `scripts/check-pr-terminal-state.ts`, testado
 * aqui só via as funções puras que ele orquestra (mesmo padrão de
 * `test/check-overnight-comment-coverage.test.ts` para o gate irmão).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkPrTerminalState,
  findRegisteredNotTerminal,
  findUnregisteredBranchCandidates,
  PR_ACCOUNTED_STATUSES,
  type OpenPrLike,
  type PlanIssueWithPrLike,
} from "../scripts/lib/pr-terminal-state.ts";

// ─── findRegisteredNotTerminal ──────────────────────────────────────────────

describe("findRegisteredNotTerminal", () => {
  it("PR registrado, aberto, status pendente → divergência (achado real #5823/#5815)", () => {
    const openPrs: OpenPrLike[] = [{ number: 5823, headRefName: "develop/fix-5815" }];
    const planIssues: PlanIssueWithPrLike[] = [{ number: 5815, status: "pendente", pr: 5823 }];
    const result = findRegisteredNotTerminal(openPrs, planIssues);
    assert.deepEqual(result, [
      { kind: "registered-not-terminal", pr: 5823, issueNumbers: [5815], statuses: ["pendente"] },
    ]);
  });

  it("PR registrado, aberto, status mergeada → não é divergência (contradição rara, fora de escopo)", () => {
    const openPrs: OpenPrLike[] = [{ number: 100, headRefName: "develop/fix-1" }];
    const planIssues: PlanIssueWithPrLike[] = [{ number: 1, status: "mergeada", pr: 100 }];
    assert.deepEqual(findRegisteredNotTerminal(openPrs, planIssues), []);
  });

  it("PR registrado, aberto, status draft-ci-vermelho → não é divergência (handoff intencional pro overnight)", () => {
    const openPrs: OpenPrLike[] = [{ number: 100, headRefName: "develop/fix-1" }];
    const planIssues: PlanIssueWithPrLike[] = [{ number: 1, status: "draft-ci-vermelho", pr: 100 }];
    assert.deepEqual(findRegisteredNotTerminal(openPrs, planIssues), []);
  });

  it("PR registrado mas já fechado no GitHub (não está em openPrs) → não é divergência", () => {
    const openPrs: OpenPrLike[] = [];
    const planIssues: PlanIssueWithPrLike[] = [{ number: 1, status: "pendente", pr: 100 }];
    assert.deepEqual(findRegisteredNotTerminal(openPrs, planIssues), []);
  });

  it("issue sem status (undefined) e PR aberto → divergência, statuses[0] undefined", () => {
    const openPrs: OpenPrLike[] = [{ number: 100 }];
    const planIssues: PlanIssueWithPrLike[] = [{ number: 1, pr: 100 }];
    const result = findRegisteredNotTerminal(openPrs, planIssues);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].statuses, [undefined]);
  });

  it("lote: PR compartilhado por múltiplas issues, nenhuma terminal → divergência lista todas as issues", () => {
    const openPrs: OpenPrLike[] = [{ number: 200 }];
    const planIssues: PlanIssueWithPrLike[] = [
      { number: 10, status: "pendente", pr: 200 },
      { number: 11, status: "pulada", pr: 200 },
    ];
    const result = findRegisteredNotTerminal(openPrs, planIssues);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].issueNumbers, [10, 11]);
  });

  it("lote: PR compartilhado, ao menos uma issue já mergeada → não é divergência (accounted)", () => {
    const openPrs: OpenPrLike[] = [{ number: 200 }];
    const planIssues: PlanIssueWithPrLike[] = [
      { number: 10, status: "mergeada", pr: 200 },
      { number: 11, status: "pendente", pr: 200 },
    ];
    assert.deepEqual(findRegisteredNotTerminal(openPrs, planIssues), []);
  });

  it("plan.json sem nenhuma issue com pr → nada a checar", () => {
    const openPrs: OpenPrLike[] = [{ number: 5823 }];
    const planIssues: PlanIssueWithPrLike[] = [{ number: 1, status: "elegivel" }];
    assert.deepEqual(findRegisteredNotTerminal(openPrs, planIssues), []);
  });

  it("PR_ACCOUNTED_STATUSES contém os 3 literais documentados", () => {
    assert.equal(PR_ACCOUNTED_STATUSES.has("mergeada"), true);
    assert.equal(PR_ACCOUNTED_STATUSES.has("draft-ci-vermelho"), true);
    assert.equal(PR_ACCOUNTED_STATUSES.has("fechada-sem-merge"), true);
    assert.equal(PR_ACCOUNTED_STATUSES.has("pendente"), false);
  });
});

// ─── findUnregisteredBranchCandidates ──────────────────────────────────────

describe("findUnregisteredBranchCandidates", () => {
  it("PR aberto em branch develop/ sem registro em plan.json → candidato", () => {
    const openPrs: OpenPrLike[] = [{ number: 5823, headRefName: "develop/fix-5815-x" }];
    const planIssues: PlanIssueWithPrLike[] = [];
    const result = findUnregisteredBranchCandidates(openPrs, planIssues);
    assert.deepEqual(result, [{ kind: "unregistered-branch-candidate", pr: 5823, headRefName: "develop/fix-5815-x" }]);
  });

  it("PR aberto em branch overnight/ sem registro → candidato", () => {
    const openPrs: OpenPrLike[] = [{ number: 1, headRefName: "overnight/batch-x" }];
    assert.equal(findUnregisteredBranchCandidates(openPrs, []).length, 1);
  });

  it("PR aberto em branch fix/ sem registro → candidato", () => {
    const openPrs: OpenPrLike[] = [{ number: 1, headRefName: "fix/legacy-thing" }];
    assert.equal(findUnregisteredBranchCandidates(openPrs, []).length, 1);
  });

  it("PR já registrado em plan.json → não é candidato (mesmo em branch develop/)", () => {
    const openPrs: OpenPrLike[] = [{ number: 5823, headRefName: "develop/fix-5815" }];
    const planIssues: PlanIssueWithPrLike[] = [{ number: 5815, status: "pendente", pr: 5823 }];
    assert.deepEqual(findUnregisteredBranchCandidates(openPrs, planIssues), []);
  });

  it("PR em branch fora da convenção (ex: renovate/, autor externo) → não é candidato", () => {
    const openPrs: OpenPrLike[] = [{ number: 1, headRefName: "renovate/bump-deps" }];
    assert.deepEqual(findUnregisteredBranchCandidates(openPrs, []), []);
  });

  it("headRefName ausente/null → nunca lança, não vira candidato", () => {
    const openPrs: OpenPrLike[] = [{ number: 1 }, { number: 2, headRefName: null }];
    assert.deepEqual(findUnregisteredBranchCandidates(openPrs, []), []);
  });

  it("prefixos customizados (parâmetro opcional) são respeitados", () => {
    const openPrs: OpenPrLike[] = [{ number: 1, headRefName: "custom/x" }];
    const result = findUnregisteredBranchCandidates(openPrs, [], ["custom/"]);
    assert.equal(result.length, 1);
  });
});

// ─── checkPrTerminalState ───────────────────────────────────────────────────

describe("checkPrTerminalState", () => {
  it("nenhum PR aberto → ok", () => {
    const verdict = checkPrTerminalState([], []);
    assert.equal(verdict.status, "ok");
    assert.deepEqual(verdict.registeredNotTerminal, []);
    assert.deepEqual(verdict.unregisteredCandidates, []);
  });

  it("PR aberto, registrado, terminal → ok", () => {
    const openPrs: OpenPrLike[] = [{ number: 1, headRefName: "develop/fix-1" }];
    const planIssues: PlanIssueWithPrLike[] = [{ number: 1, status: "mergeada", pr: 1 }];
    const verdict = checkPrTerminalState(openPrs, planIssues);
    assert.equal(verdict.status, "ok");
  });

  it("PR aberto, registrado, não-terminal → divergent (cenário 1)", () => {
    const openPrs: OpenPrLike[] = [{ number: 5823, headRefName: "develop/fix-5815" }];
    const planIssues: PlanIssueWithPrLike[] = [{ number: 5815, status: "pendente", pr: 5823 }];
    const verdict = checkPrTerminalState(openPrs, planIssues);
    assert.equal(verdict.status, "divergent");
    assert.equal(verdict.registeredNotTerminal.length, 1);
    assert.equal(verdict.unregisteredCandidates.length, 0);
  });

  it("PR aberto em branch da sessão, não registrado → divergent (cenário 2)", () => {
    const openPrs: OpenPrLike[] = [{ number: 5823, headRefName: "develop/fix-5815" }];
    const verdict = checkPrTerminalState(openPrs, []);
    assert.equal(verdict.status, "divergent");
    assert.equal(verdict.registeredNotTerminal.length, 0);
    assert.equal(verdict.unregisteredCandidates.length, 1);
  });

  it("PR aberto fora da convenção de branch e não registrado → ok (não é desta linha de skills)", () => {
    const openPrs: OpenPrLike[] = [{ number: 1, headRefName: "feature/random-thing" }];
    const verdict = checkPrTerminalState(openPrs, []);
    assert.equal(verdict.status, "ok");
  });

  it("mistura dos dois cenários no mesmo veredito", () => {
    const openPrs: OpenPrLike[] = [
      { number: 5823, headRefName: "develop/fix-5815" }, // cenário 1: registrado, não-terminal
      { number: 6000, headRefName: "overnight/fix-6001" }, // cenário 2: não-registrado
    ];
    const planIssues: PlanIssueWithPrLike[] = [{ number: 5815, status: "pendente", pr: 5823 }];
    const verdict = checkPrTerminalState(openPrs, planIssues);
    assert.equal(verdict.status, "divergent");
    assert.equal(verdict.registeredNotTerminal.length, 1);
    assert.equal(verdict.unregisteredCandidates.length, 1);
  });
});
