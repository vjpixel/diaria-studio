/**
 * #13283 — `cleanup-merged-worktrees.ts` confirmava o merge só pelo nome da
 * branch LOCAL (`gh pr list --head {branch} --state merged`). O `dev-fixer`
 * às vezes commita numa branch local de outro nome (`fixer-13239`) e envia com
 * refspec (`git push origin fixer-13239:develop/fix-13239`); o GitHub não
 * conhece `fixer-13239` e o worktree nunca saía. Agora o merge também é
 * conferido pelas branches remotas que contêm o HEAD.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRemoteBranchesContainingHead,
  remoteBranchesContainingHeadSafe,
  REMOTE_BRANCHES_PER_WORKTREE_MAX,
  runMainWithCheckers,
  selectMergedViaRemoteForRemoval,
  type WorktreeEntry,
} from "../scripts/cleanup-merged-worktrees.ts";

const fixer: WorktreeEntry = { path: "/repo/.claude/worktrees/agent-a571", branch: "fixer-13239", locked: false };
const impl: WorktreeEntry = { path: "/repo/.claude/worktrees/agent-impl", branch: "develop/fix-13239", locked: false };

// ── seletor puro ──

test("#13283 — branch local de outro nome: sai quando a branch remota que contém o HEAD tem PR mergeada", () => {
  const merged = new Set(["develop/fix-13239"]);
  const r = selectMergedViaRemoteForRemoval(
    [fixer],
    [],
    () => ["develop/fix-13239"],
    (b) => merged.has(b),
    () => false,
  );
  assert.deepEqual(r, [fixer]);
});

test("#13283 — sem branch remota contendo o HEAD (ou só PR não mergeada), fica", () => {
  assert.deepEqual(selectMergedViaRemoteForRemoval([fixer], [], () => [], () => true, () => false), []);
  assert.deepEqual(selectMergedViaRemoteForRemoval([fixer], [], () => ["develop/fix-13239"], () => false, () => false), []);
});

test("#13283 — PR aberta na branch remota (reuso de branch, #8792) ou na local preserva", () => {
  assert.deepEqual(
    selectMergedViaRemoteForRemoval([fixer], [], () => ["develop/fix-13239"], () => true, (b) => b === "develop/fix-13239"),
    [],
  );
  assert.deepEqual(
    selectMergedViaRemoteForRemoval([fixer], [], () => ["develop/fix-13239"], () => true, (b) => b === "fixer-13239"),
    [],
  );
});

test("#13283 — já selecionado por outro seletor não é avaliado de novo", () => {
  let calls = 0;
  const r = selectMergedViaRemoteForRemoval([impl], [impl], () => (calls++, ["develop/fix-13239"]), () => true, () => false);
  assert.deepEqual(r, []);
  assert.equal(calls, 0);
});

test("#13283 — parse: tira origin/, HEAD, master e main; respeita o teto", () => {
  const out = [
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/master",
    "refs/remotes/origin/main",
    "refs/remotes/origin/develop/fix-13239",
    "refs/remotes/upstream/outra",
    "",
  ].join("\r\n");
  assert.deepEqual(parseRemoteBranchesContainingHead(out), ["develop/fix-13239"]);
  const many = Array.from({ length: 9 }, (_, i) => `refs/remotes/origin/b${i}`).join("\n");
  assert.equal(parseRemoteBranchesContainingHead(many).length, REMOTE_BRANCHES_PER_WORKTREE_MAX);
});

// ── laço principal ──

test("#13283 — main: o worktree do fixer sai junto com o do implementador", () => {
  const main: WorktreeEntry = { path: "/repo", branch: "master", locked: false };
  const removed: string[] = [];
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (m: string) => logs.push(m);
  console.warn = (m: string) => logs.push(m);
  try {
    runMainWithCheckers({}, "/repo", {
      isMerged: (b) => b === "develop/fix-13239",
      hasOpenPr: () => false,
      branchExistsLocally: () => true,
      issueClosedAtMs: () => null,
      listWorktrees: () => [main, impl, fixer],
      listActiveSessions: () => ({ sessions: [], readable: true }),
      listProcesses: () => [],
      isWorktreeDirty: () => false,
      remoteBranchesContainingHead: (p) => (p === fixer.path || p === impl.path ? ["develop/fix-13239"] : []),
      removeWorktree: (p) => {
        removed.push(p);
        return { ok: true };
      },
      removeWorktreeDir: () => ({ dirRemoved: true, errors: [] }),
      findHusks: () => [],
    });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  assert.deepEqual(removed, [impl.path, fixer.path]);
  assert.ok(logs.some((l) => l.includes(`removido: ${fixer.path}`) && l.includes("#13283")), logs.join("\n"));
});

test("#13283 — main: fixer com trabalho não commitado continua preservado (#7304)", () => {
  const removed: string[] = [];
  const origLog = console.log;
  console.log = () => {};
  try {
    runMainWithCheckers({}, "/repo", {
      isMerged: (b) => b === "develop/fix-13239",
      hasOpenPr: () => false,
      branchExistsLocally: () => true,
      issueClosedAtMs: () => null,
      listWorktrees: () => [{ path: "/repo", branch: "master", locked: false }, fixer],
      listActiveSessions: () => ({ sessions: [], readable: true }),
      listProcesses: () => [],
      isWorktreeDirty: () => true,
      remoteBranchesContainingHead: () => ["develop/fix-13239"],
      removeWorktree: (p) => {
        removed.push(p);
        return { ok: true };
      },
      removeWorktreeDir: () => ({ dirRemoved: true, errors: [] }),
      findHusks: () => [],
    });
  } finally {
    console.log = origLog;
  }
  assert.deepEqual(removed, []);
});

// ── git real: branch local enviada com refspec ──

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=master", ...args], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

test("#13283 — git real: HEAD do fixer enviado com refspec aparece; worktree parado em origin/master não", () => {
  const base = mkdtempSync(join(tmpdir(), "cmw-13283-"));
  try {
    const origin = join(base, "origin.git");
    const repo = join(base, "repo");
    git(base, "init", "--bare", origin);
    git(base, "clone", origin, repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-m", "base");
    git(repo, "push", "origin", "HEAD:master");
    git(repo, "fetch", "origin");

    const fx = join(base, "wt-fixer");
    git(repo, "worktree", "add", "-b", "fixer-13239", fx, "origin/master");
    writeFileSync(join(fx, "b.txt"), "b\n");
    git(fx, "add", "b.txt");
    git(fx, "commit", "-m", "fix");
    git(fx, "push", "origin", "fixer-13239:develop/fix-13239");
    git(fx, "fetch", "origin");

    const fresh = join(base, "wt-fresh");
    git(repo, "worktree", "add", "-b", "worktree-agent-x", fresh, "origin/master");

    assert.deepEqual(remoteBranchesContainingHeadSafe(fx), ["develop/fix-13239"]);
    // HEAD já em origin/master: nenhuma branch, mesmo com develop/fix-13239 "contendo" o commit base.
    assert.deepEqual(remoteBranchesContainingHeadSafe(fresh), []);
    // Commit só local: nenhuma branch remota o contém.
    writeFileSync(join(fx, "c.txt"), "c\n");
    git(fx, "add", "c.txt");
    git(fx, "commit", "-m", "local");
    assert.deepEqual(remoteBranchesContainingHeadSafe(fx), []);
    assert.deepEqual(remoteBranchesContainingHeadSafe(join(base, "nao-existe")), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
