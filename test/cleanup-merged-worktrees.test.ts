/**
 * test/cleanup-merged-worktrees.test.ts (#4335)
 *
 * Cobre a lógica PURA de scripts/cleanup-merged-worktrees.ts: parse do
 * `git worktree list --porcelain`, filtro por diretório e seleção dos
 * worktrees com PR mergeada — tudo com um checker `isMerged` injetável, sem
 * precisar de worktrees reais nem chamadas de rede pro `gh`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWorktreePorcelain,
  filterUnderWorktreesDir,
  selectMergedForRemoval,
} from "../scripts/cleanup-merged-worktrees.ts";

// ── parseWorktreePorcelain ──

test("parseWorktreePorcelain — parseia múltiplos blocos com branch", () => {
  const output = [
    "worktree C:/Users/vjpix/Projects/diaria-studio",
    "HEAD 13cf4e408e3f7880c15c76145091e0037d2ad755",
    "branch refs/heads/master",
    "",
    "worktree C:/Users/vjpix/Projects/diaria-studio/.claude/worktrees/agent-abc123",
    "HEAD a33bcd3c4b320447890451878e581f0b7015c656",
    "branch refs/heads/overnight/fix-4326",
    "",
  ].join("\n");

  const entries = parseWorktreePorcelain(output);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, "C:/Users/vjpix/Projects/diaria-studio");
  assert.equal(entries[0].branch, "master");
  assert.equal(entries[1].path, "C:/Users/vjpix/Projects/diaria-studio/.claude/worktrees/agent-abc123");
  assert.equal(entries[1].branch, "overnight/fix-4326");
});

test("parseWorktreePorcelain — worktree detached (sem 'branch') vira branch null", () => {
  const output = [
    "worktree /repo/.claude/worktrees/agent-xyz",
    "HEAD 1234567",
    "detached",
    "",
  ].join("\n");
  const entries = parseWorktreePorcelain(output);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].branch, null);
});

test("parseWorktreePorcelain — sem linha em branco final ainda fecha o último bloco", () => {
  const output = ["worktree /repo", "HEAD abc", "branch refs/heads/master"].join("\n");
  const entries = parseWorktreePorcelain(output);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].branch, "master");
});

test("parseWorktreePorcelain — output vazio retorna array vazio", () => {
  assert.deepEqual(parseWorktreePorcelain(""), []);
});

test("parseWorktreePorcelain — normaliza backslash pra forward slash no path (Windows)", () => {
  const output = ["worktree C:\\Users\\vjpix\\repo", "branch refs/heads/master", ""].join("\n");
  const entries = parseWorktreePorcelain(output);
  assert.equal(entries[0].path, "C:/Users/vjpix/repo");
});

// ── filterUnderWorktreesDir ──

test("filterUnderWorktreesDir — mantém só os sob o diretório, nunca o worktree principal do repo", () => {
  const entries = [
    { path: "C:/repo", branch: "master" },
    { path: "C:/repo/.claude/worktrees/agent-a", branch: "overnight/fix-1" },
    { path: "C:/repo/.claude/worktrees/agent-b", branch: "develop/fix-2" },
  ];
  const result = filterUnderWorktreesDir(entries, "C:/repo/.claude/worktrees");
  assert.equal(result.length, 2);
  assert.ok(result.every((e) => e.path.includes(".claude/worktrees")));
});

test("filterUnderWorktreesDir — não confunde prefixo parcial de path (ex: 'worktrees-old')", () => {
  const entries = [
    { path: "C:/repo/.claude/worktrees-old/agent-x", branch: "b" },
    { path: "C:/repo/.claude/worktrees/agent-y", branch: "b2" },
  ];
  const result = filterUnderWorktreesDir(entries, "C:/repo/.claude/worktrees");
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "C:/repo/.claude/worktrees/agent-y");
});

test("filterUnderWorktreesDir — tolera barra final no worktreesDir", () => {
  const entries = [{ path: "C:/repo/.claude/worktrees/agent-a", branch: "b" }];
  const result = filterUnderWorktreesDir(entries, "C:/repo/.claude/worktrees/");
  assert.equal(result.length, 1);
});

// ── selectMergedForRemoval ──

test("selectMergedForRemoval — só seleciona os que o checker confirma como mergeados", () => {
  const entries = [
    { path: "/a", branch: "overnight/fix-1" },
    { path: "/b", branch: "overnight/fix-2" },
    { path: "/c", branch: "develop/fix-3" },
  ];
  const merged = new Set(["overnight/fix-1", "develop/fix-3"]);
  const result = selectMergedForRemoval(entries, (b) => merged.has(b));
  assert.deepEqual(
    result.map((e) => e.path).sort(),
    ["/a", "/c"],
  );
});

test("selectMergedForRemoval — worktree detached (branch null) nunca é selecionado, mesmo com checker sempre-true", () => {
  const entries = [{ path: "/a", branch: null }];
  const result = selectMergedForRemoval(entries, () => true);
  assert.equal(result.length, 0);
});

test("selectMergedForRemoval — nenhum mergeado -> array vazio (fail-soft: nunca remove por engano)", () => {
  const entries = [
    { path: "/a", branch: "overnight/fix-1" },
    { path: "/b", branch: "overnight/fix-2" },
  ];
  const result = selectMergedForRemoval(entries, () => false);
  assert.deepEqual(result, []);
});

test("selectMergedForRemoval — lista vazia de entrada -> array vazio", () => {
  assert.deepEqual(selectMergedForRemoval([], () => true), []);
});
