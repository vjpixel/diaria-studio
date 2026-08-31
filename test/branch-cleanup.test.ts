import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyBranchForCleanup,
  classifyWorktreeForCleanup,
  parseWorktreeListPorcelain,
} from "../scripts/lib/branch-cleanup.ts";

describe("classifyBranchForCleanup (#6802)", () => {
  it("PR MERGED -> safe-delete, mesmo sem ser ancestral (caso real: squash-merge)", () => {
    const r = classifyBranchForCleanup({ branch: "continuo/fix-6043", prStates: ["MERGED"], isAncestorOfMaster: false });
    assert.equal(r.verdict, "safe-delete");
    assert.match(r.reason, /MERGED/);
  });

  it("é ancestral de master, sem nenhuma PR -> safe-delete (sinal secundário: push direto)", () => {
    const r = classifyBranchForCleanup({ branch: "old-direct-push", prStates: [], isAncestorOfMaster: true });
    assert.equal(r.verdict, "safe-delete");
    assert.match(r.reason, /ancestral/);
  });

  it("PR CLOSED sem merge, não ancestral -> needs-review, nunca safe-delete", () => {
    const r = classifyBranchForCleanup({ branch: "abandoned", prStates: ["CLOSED"], isAncestorOfMaster: false });
    assert.equal(r.verdict, "needs-review");
    assert.match(r.reason, /CLOSED/);
  });

  it("sem PR nenhuma, não ancestral -> needs-review (WIP nunca submetido)", () => {
    const r = classifyBranchForCleanup({ branch: "wip-nunca-teve-pr", prStates: [], isAncestorOfMaster: false });
    assert.equal(r.verdict, "needs-review");
  });

  it("múltiplas PRs pro mesmo branch, uma delas MERGED -> safe-delete (MERGED vence)", () => {
    const r = classifyBranchForCleanup({ branch: "reused-name", prStates: ["CLOSED", "MERGED"], isAncestorOfMaster: false });
    assert.equal(r.verdict, "safe-delete");
  });

  it("PR OPEN (ainda em revisão) sem ser ancestral -> needs-review, NUNCA safe-delete (fail-closed sobre trabalho em curso)", () => {
    const r = classifyBranchForCleanup({ branch: "still-open", prStates: ["OPEN"], isAncestorOfMaster: false });
    assert.equal(r.verdict, "needs-review");
  });

  it("#6802 retrospectivo: das 61 branches continuo/ medidas, ancestor-only classificava 51 como não-mergeadas — MERGED via gh corrige isso", () => {
    // Reconstrução direta do achado: branch squash-mergeada, isAncestorOfMaster
    // é false (squash nunca vira ancestral) — só a PR MERGED resolve certo.
    const r = classifyBranchForCleanup({
      branch: "continuo/fix-5894-server-ts-refactor",
      prStates: ["MERGED"],
      isAncestorOfMaster: false,
    });
    assert.equal(r.verdict, "safe-delete", "critério ingênuo (só ancestor) erraria isto — MERGED via gh é o critério primário");
  });
});

describe("parseWorktreeListPorcelain (#6802)", () => {
  it("parseia múltiplos blocos, extrai path/branch/prunable", () => {
    const out = [
      "worktree /home/vjpixel/diaria-studio",
      "HEAD abc123",
      "branch refs/heads/master",
      "",
      "worktree /tmp/wt-6143",
      "HEAD def456",
      "detached",
      "prunable gitdir file points to non-existent location",
    ].join("\n");
    const entries = parseWorktreeListPorcelain(out);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { path: "/home/vjpixel/diaria-studio", branch: "master", prunable: false });
    assert.deepEqual(entries[1], { path: "/tmp/wt-6143", branch: null, prunable: true });
  });

  it("branch com refs/heads/ prefixo é normalizada (sem o prefixo no output)", () => {
    const out = ["worktree /x", "HEAD abc", "branch refs/heads/overnight/fix-123-slug"].join("\n");
    const entries = parseWorktreeListPorcelain(out);
    assert.equal(entries[0].branch, "overnight/fix-123-slug");
  });

  it("entrada vazia -> array vazio, nunca lança", () => {
    assert.deepEqual(parseWorktreeListPorcelain(""), []);
  });

  it("bloco sem linha 'worktree' é ignorado (malformado, defesa)", () => {
    const out = "HEAD abc\nbranch refs/heads/x";
    assert.deepEqual(parseWorktreeListPorcelain(out), []);
  });
});

describe("classifyWorktreeForCleanup (#6802 item 3)", () => {
  it("porcelain SUJO -> needs-review, mesmo com branch safe-delete (fail-closed sobre diff não commitado)", () => {
    const r = classifyWorktreeForCleanup({
      path: "/x",
      branch: "continuo/fix-1",
      isPorcelainClean: false,
      branchDecision: { verdict: "safe-delete", reason: "PR MERGED" },
    });
    assert.equal(r.verdict, "needs-review");
    assert.match(r.reason, /não commitada/);
  });

  it("detached (sem branch) -> sempre needs-review, mesmo limpo", () => {
    const r = classifyWorktreeForCleanup({ path: "/x", branch: null, isPorcelainClean: true, branchDecision: null });
    assert.equal(r.verdict, "needs-review");
    assert.match(r.reason, /detached/);
  });

  it("limpo + branch safe-delete -> safe-remove", () => {
    const r = classifyWorktreeForCleanup({
      path: "/x",
      branch: "overnight/fix-6413",
      isPorcelainClean: true,
      branchDecision: { verdict: "safe-delete", reason: "PR MERGED encontrada (gh pr list --state all)" },
    });
    assert.equal(r.verdict, "safe-remove");
    assert.match(r.reason, /overnight\/fix-6413/);
  });

  it("limpo mas branch needs-review -> needs-review (nunca remove antes da branch decidir)", () => {
    const r = classifyWorktreeForCleanup({
      path: "/x",
      branch: "wip-branch",
      isPorcelainClean: true,
      branchDecision: { verdict: "needs-review", reason: "sem PR nenhuma" },
    });
    assert.equal(r.verdict, "needs-review");
  });
});
