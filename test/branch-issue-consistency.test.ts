import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkBranchIssueConsistency,
  extractIssueNumberFromBranch,
  extractIssueNumbersFromCommitMessages,
} from "../scripts/lib/branch-issue-consistency.ts";

describe("extractIssueNumberFromBranch (#6804)", () => {
  it("continuo/fix-N-slug extrai N", () => {
    assert.equal(extractIssueNumberFromBranch("continuo/fix-6043-onboarding"), 6043);
  });
  it("continuo/batch-N-slug extrai N", () => {
    assert.equal(extractIssueNumberFromBranch("continuo/batch-5327-5329-loop-fixes"), 5327);
  });
  it("overnight/ e develop/ também reconhecidos", () => {
    assert.equal(extractIssueNumberFromBranch("overnight/fix-6800-sync-retry"), 6800);
    assert.equal(extractIssueNumberFromBranch("develop/fix-5416-lint-batch-mode"), 5416);
  });
  it("branch sem número (batch-slug puro) -> null, não erro", () => {
    assert.equal(extractIssueNumberFromBranch("continuo/batch-observability-fixes"), null);
  });
  it("branch fora da convenção (sem prefixo de trilha) -> null", () => {
    assert.equal(extractIssueNumberFromBranch("feature/random-thing"), null);
  });
});

describe("extractIssueNumbersFromCommitMessages", () => {
  it("extrai múltiplos #N de múltiplas mensagens, dedup", () => {
    const msgs = ["fix(#100): a\nCloses #100", "fix(#200): b"];
    assert.deepEqual(extractIssueNumbersFromCommitMessages(msgs), [100, 200]);
  });
  it("sem nenhum #N -> array vazio", () => {
    assert.deepEqual(extractIssueNumbersFromCommitMessages(["mensagem sem issue"]), []);
  });
  it("mesma issue repetida em várias mensagens conta 1x", () => {
    assert.deepEqual(extractIssueNumbersFromCommitMessages(["fix(#5): a", "fix(#5): b — parte 2"]), [5]);
  });
});

describe("checkBranchIssueConsistency — retrospectivo dos casos reais da #6804", () => {
  it("continuo/fix-6043-onboarding com commit do #6005 -> MISMATCH (caso severo real, P0 #6043 achado errado)", () => {
    const r = checkBranchIssueConsistency("continuo/fix-6043-onboarding", [
      "feat(#6005): Parte B — D1/D2/D3 do Instagram viram carrossel de 5 slides",
    ]);
    assert.equal(r.consistent, false);
    assert.equal(r.branchIssue, 6043);
    assert.deepEqual(r.commitIssues, [6005]);
  });

  it("continuo/fix-6005-benchmarks-instagram com commit do #6016/#6007 -> MISMATCH (2º caso real)", () => {
    const r = checkBranchIssueConsistency("continuo/fix-6005-benchmarks-instagram", [
      "Closes #6016 — dívida do fix #6007. Branch: continuo/fix-6016-divida-fix-6007",
    ]);
    assert.equal(r.consistent, false);
    assert.equal(r.branchIssue, 6005);
    assert.deepEqual(r.commitIssues, [6016, 6007]);
  });

  it("continuo/fix-5894-server-ts-refactor com #5894+#5897+#5892 -> CONSISTENT (5894 está entre os commits, caso de acumulação, fora de escopo — ver docstring do módulo)", () => {
    const r = checkBranchIssueConsistency("continuo/fix-5894-server-ts-refactor", [
      "fix(#5894): a",
      "fix(#5897): b",
      "fix(#5892): c",
    ]);
    assert.equal(r.consistent, true);
    assert.equal(r.branchIssue, 5894);
  });

  it("branch sem número extraível -> sempre consistent, independente dos commits", () => {
    const r = checkBranchIssueConsistency("continuo/batch-cluster-thing", ["fix(#999): x"]);
    assert.equal(r.consistent, true);
    assert.equal(r.branchIssue, null);
  });

  it("caso feliz: branch e commit citam a mesma issue -> consistent", () => {
    const r = checkBranchIssueConsistency("continuo/fix-7000-slug", ["fix(#7000): resolve o bug"]);
    assert.equal(r.consistent, true);
  });

  it("branch numerada com lista de commits VAZIA -> mismatch (pr-test-analyzer, PR #6848: PR sem commits ainda / payload malformado chegando na função pura)", () => {
    const r = checkBranchIssueConsistency("continuo/fix-8000-slug", []);
    assert.equal(r.consistent, false);
    assert.equal(r.branchIssue, 8000);
    assert.deepEqual(r.commitIssues, []);
  });
});
