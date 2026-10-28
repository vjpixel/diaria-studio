/**
 * test/disk-space-guard-11446.test.ts (#11446)
 *
 * Regressão da rodada 261027e: disco do `300` em 100% com 150 worktrees, e o
 * `cleanup-merged-worktrees.ts` liberou só 4,6 GB porque nenhum seletor
 * pegava worktree limpo com HEAD já no remoto (PR ainda aberta ou sem PR).
 * Cobre o seletor novo, o wiring em `runMainWithCheckers`, a lógica pura do
 * guard de disco e o núcleo injetável do CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  selectPushedCleanForRemoval,
  isAutonomousWorktreeBranch,
  PUSHED_CLEAN_MIN_AGE_MS,
  runMainWithCheckers,
  isHeadOnRemoteSafe,
  getWorktreeLastActivityMsSafe,
  type WorktreeEntry,
} from "../scripts/cleanup-merged-worktrees.ts";
import {
  evaluateDiskSpace,
  resolveDiskGuardThresholds,
  DEFAULT_MIN_FREE_PCT,
} from "../scripts/lib/disk-space-guard.ts";
import { runDiskGuard } from "../scripts/check-disk-space-guard.ts";

const GIB = 1024 * 1024 * 1024;
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const wt = (name: string, branch: string | null): WorktreeEntry => ({
  path: `/repo/.claude/worktrees/${name}`,
  branch,
  locked: false,
});

// ── selectPushedCleanForRemoval ──

test("seletor: HEAD no remoto e parado há 4h entra; jovem, não enviado ou PR aberta ficam", () => {
  const pushedOld = wt("agent-a", "worktree-agent-a");
  const young = wt("agent-b", "worktree-agent-b");
  const unpushed = wt("agent-c", "worktree-agent-c");
  const openPr = wt("fix-1", "overnight/fix-1-x");
  const onRemote = new Set([pushedOld.path, young.path, openPr.path]);
  const activity: Record<string, number> = {
    [pushedOld.path]: NOW - 4 * HOUR,
    [young.path]: NOW - 1 * HOUR,
    [unpushed.path]: NOW - 10 * HOUR,
    [openPr.path]: NOW - 10 * HOUR,
  };
  const sel = selectPushedCleanForRemoval(
    [pushedOld, young, unpushed, openPr],
    [],
    (p) => onRemote.has(p),
    (p) => activity[p] ?? null,
    (b) => b === "overnight/fix-1-x",
    NOW,
  );
  assert.deepEqual(sel.map((e) => e.path), [pushedOld.path]);

  const pressure = selectPushedCleanForRemoval(
    [pushedOld, young, unpushed, openPr],
    [],
    (p) => onRemote.has(p),
    (p) => activity[p] ?? null,
    (b) => b === "overnight/fix-1-x",
    NOW,
    { includeOpenPr: true },
  );
  assert.deepEqual(pressure.map((e) => e.path), [pushedOld.path, openPr.path]);
});

test("seletor: atividade indeterminada nunca seleciona; já selecionado não duplica", () => {
  const a = wt("a", null);
  const b = wt("b", "x");
  const sel = selectPushedCleanForRemoval(
    [a, b],
    [b],
    () => true,
    (p) => (p === a.path ? null : NOW - 5 * HOUR),
    () => false,
    NOW,
  );
  assert.deepEqual(sel, []);
});

test("seletor: limite exato de 3h já conta", () => {
  const a = wt("a", "x");
  const sel = selectPushedCleanForRemoval([a], [], () => true, () => NOW - PUSHED_CLEAN_MIN_AGE_MS, () => false, NOW);
  assert.equal(sel.length, 1);
});

// ── wiring em runMainWithCheckers (cenário real da issue) ──

function runScenario(opts: { reclaimOpenPr?: boolean; dirty?: Set<string>; extra?: WorktreeEntry[] }) {
  const main: WorktreeEntry = { path: "/repo", branch: "master", locked: false };
  const agent = wt("agent-old", "worktree-agent-old"); // parado em origin/master, sem PR
  const prOpen = wt("fix-9-x", "overnight/fix-9-x"); // PR aberta, já enviado
  const unpushed = wt("agent-new-commit", "worktree-agent-n"); // commit local não enviado
  const removed: string[] = [];
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (m: string) => logs.push(m);
  console.warn = (m: string) => logs.push(m);
  try {
    runMainWithCheckers(opts.reclaimOpenPr ? { "reclaim-open-pr": "true" } : {}, "/repo", {
      isMerged: () => false,
      hasOpenPr: (b) => b === "overnight/fix-9-x",
      branchExistsLocally: () => true,
      issueClosedAtMs: () => null,
      listWorktrees: () => [main, agent, prOpen, unpushed, ...(opts.extra ?? [])],
      listActiveSessions: () => ({ sessions: [], readable: true }),
      listProcesses: () => [],
      isWorktreeDirty: (p) => opts.dirty?.has(p) ?? false,
      removeWorktree: (p) => {
        removed.push(p);
        return { ok: true };
      },
      removeWorktreeDir: () => ({ dirRemoved: true, errors: [] }),
      findHusks: () => [],
      isHeadOnRemote: (p) => p !== unpushed.path,
      lastActivityMs: () => NOW - 5 * HOUR,
      nowMs: NOW,
    });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return { removed, logs, agent, prOpen, unpushed };
}

test("main: remove worktree limpo já enviado, preserva o não enviado e o de PR aberta", () => {
  const r = runScenario({});
  assert.deepEqual(r.removed, [r.agent.path]);
});

test("main com --reclaim-open-pr: inclui o de PR aberta, nunca o não enviado", () => {
  const r = runScenario({ reclaimOpenPr: true });
  assert.deepEqual(r.removed.sort(), [r.agent.path, r.prOpen.path].sort());
});

test("main: worktree sujo nunca sai, mesmo já enviado e sob pressão", () => {
  const dirtyPath = "/repo/.claude/worktrees/agent-old";
  const r = runScenario({ reclaimOpenPr: true, dirty: new Set([dirtyPath]) });
  assert.ok(!r.removed.includes(dirtyPath));
});

// ── #11458: no modo normal o 4º seletor só pega worktree de rodada autônoma ──

test("isAutonomousWorktreeBranch: worktree-agent-* e overnight/* sim; editor, develop/ e HEAD destacado não", () => {
  assert.equal(isAutonomousWorktreeBranch("worktree-agent-a7b2"), true);
  assert.equal(isAutonomousWorktreeBranch("overnight/fix-1-x"), true);
  assert.equal(isAutonomousWorktreeBranch("overnight/batch-y"), true);
  assert.equal(isAutonomousWorktreeBranch("develop/fix-1"), false);
  assert.equal(isAutonomousWorktreeBranch("minha-investigacao"), false);
  assert.equal(isAutonomousWorktreeBranch("master"), false);
  assert.equal(isAutonomousWorktreeBranch(null), false);
});

test("seletor com autonomousOnly: worktree parado do editor fica, o do agente sai", () => {
  const editor = wt("investigacao", "minha-investigacao");
  const agent = wt("agent-z", "worktree-agent-z");
  const sel = selectPushedCleanForRemoval([editor, agent], [], () => true, () => NOW - 10 * HOUR, () => false, NOW, {
    autonomousOnly: true,
  });
  assert.deepEqual(sel.map((e) => e.path), [agent.path]);
});

test("main (cenário da #11458): worktree do editor em origin/master parado há 5h NÃO sai no modo normal; sai sob --reclaim-open-pr", () => {
  const editorOnMaster = wt("editor-wt", "editor-wt"); // parado em origin/master
  const editorPushed = wt("develop-fix-7", "develop/fix-7"); // branch empurrada sem PR
  const detached: WorktreeEntry = { path: "/repo/.claude/worktrees/detached", branch: null, locked: false };
  const extra = [editorOnMaster, editorPushed, detached];

  const normal = runScenario({ extra });
  assert.deepEqual(normal.removed, [normal.agent.path], "modo normal: só o worktree-agent-* sai");

  const pressure = runScenario({ reclaimOpenPr: true, extra });
  assert.deepEqual(
    pressure.removed.sort(),
    [pressure.agent.path, pressure.prOpen.path, editorOnMaster.path, editorPushed.path, detached.path].sort(),
    "guard de disco: qualquer branch limpa e enviada sai",
  );
});

test("main sem os checkers novos: comportamento anterior (nada sai por este seletor)", () => {
  const removed: string[] = [];
  const origLog = console.log;
  console.log = () => {};
  try {
    runMainWithCheckers({}, "/repo", {
      isMerged: () => false,
      hasOpenPr: () => false,
      branchExistsLocally: () => true,
      issueClosedAtMs: () => null,
      listWorktrees: () => [{ path: "/repo", branch: "master", locked: false }, wt("a", "x")],
      listActiveSessions: () => ({ sessions: [], readable: true }),
      listProcesses: () => [],
      isWorktreeDirty: () => false,
      removeWorktree: (p) => {
        removed.push(p);
        return { ok: true };
      },
      removeWorktreeDir: () => ({ dirRemoved: true, errors: [] }),
      findHusks: () => [],
      nowMs: NOW,
    });
  } finally {
    console.log = origLog;
  }
  assert.deepEqual(removed, []);
});

// ── isHeadOnRemoteSafe / getWorktreeLastActivityMsSafe com git real ──

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

test("isHeadOnRemoteSafe: true com HEAD enviado, false com commit local, false em diretório inexistente", () => {
  const dir = mkdtempSync(join(tmpdir(), "disk-guard-11446-"));
  try {
    const remote = join(dir, "remote.git");
    const work = join(dir, "work");
    git(dir, "init", "--bare", "-q", remote);
    git(dir, "init", "-q", work);
    git(work, "config", "user.email", "t@t");
    git(work, "config", "user.name", "t");
    writeFileSync(join(work, "a.txt"), "a");
    git(work, "add", "a.txt");
    git(work, "commit", "-q", "-m", "a");
    git(work, "remote", "add", "origin", remote);
    git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(work, "fetch", "-q", "origin");
    assert.equal(isHeadOnRemoteSafe(work), true);
    const activity = getWorktreeLastActivityMsSafe(work);
    assert.ok(activity !== null && activity > Date.now() - HOUR);

    writeFileSync(join(work, "b.txt"), "b");
    git(work, "add", "b.txt");
    git(work, "commit", "-q", "-m", "b");
    assert.equal(isHeadOnRemoteSafe(work), false);

    assert.equal(isHeadOnRemoteSafe(join(dir, "nao-existe")), false);
    assert.equal(getWorktreeLastActivityMsSafe(join(dir, "nao-existe")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── lógica pura do guard ──

const T = { minFreeBytes: 10 * GIB, minFreePct: 0.1 };

test("evaluateDiskSpace: ok, baixo por bytes, baixo por fração, leitura inválida", () => {
  assert.equal(evaluateDiskSpace({ totalBytes: 100 * GIB, availableBytes: 40 * GIB }, T).verdict, "ok");
  const lowBytes = evaluateDiskSpace({ totalBytes: 50 * GIB, availableBytes: 8 * GIB }, T);
  assert.equal(lowBytes.verdict, "low");
  assert.deepEqual(lowBytes.breached, ["min-free-bytes"]);
  const lowPct = evaluateDiskSpace({ totalBytes: 1000 * GIB, availableBytes: 50 * GIB }, T);
  assert.deepEqual(lowPct.breached, ["min-free-pct"]);
  assert.equal(evaluateDiskSpace({ totalBytes: 0, availableBytes: 0 }, T).verdict, "unknown");
  assert.equal(evaluateDiskSpace({ totalBytes: NaN, availableBytes: 1 }, T).verdict, "unknown");
});

test("resolveDiskGuardThresholds: flag > env > default; percentual; inválido avisa", () => {
  const d = resolveDiskGuardThresholds({}, {});
  assert.equal(d.thresholds.minFreeBytes, 10 * GIB);
  assert.equal(d.thresholds.minFreePct, DEFAULT_MIN_FREE_PCT);

  const env = resolveDiskGuardThresholds({}, { DIARIA_DISK_GUARD_MIN_FREE_GB: "20", DIARIA_DISK_GUARD_MIN_FREE_PCT: "15" });
  assert.equal(env.thresholds.minFreeBytes, 20 * GIB);
  assert.equal(env.thresholds.minFreePct, 0.15);

  const flag = resolveDiskGuardThresholds({ "min-free-gb": "5" }, { DIARIA_DISK_GUARD_MIN_FREE_GB: "20" });
  assert.equal(flag.thresholds.minFreeBytes, 5 * GIB);

  const bad = resolveDiskGuardThresholds({ "min-free-gb": "abc" }, {});
  assert.equal(bad.thresholds.minFreeBytes, 10 * GIB);
  assert.equal(bad.warnings.length, 1);
});

test("resolveDiskGuardThresholds: --min-free-pct é sempre percentual (1 = 1%, nunca 100%) — regressão PR #11453", () => {
  const one = resolveDiskGuardThresholds({ "min-free-pct": "1" }, {});
  assert.equal(one.thresholds.minFreePct, 0.01);
  assert.deepEqual(one.warnings, []);

  const oneEnv = resolveDiskGuardThresholds({}, { DIARIA_DISK_GUARD_MIN_FREE_PCT: "1" });
  assert.equal(oneEnv.thresholds.minFreePct, 0.01);

  const half = resolveDiskGuardThresholds({ "min-free-pct": "0.5" }, {});
  assert.equal(half.thresholds.minFreePct, 0.005);

  const full = resolveDiskGuardThresholds({ "min-free-pct": "100" }, {});
  assert.equal(full.thresholds.minFreePct, 1);

  const over = resolveDiskGuardThresholds({ "min-free-pct": "150" }, {});
  assert.equal(over.thresholds.minFreePct, DEFAULT_MIN_FREE_PCT);
  assert.equal(over.warnings.length, 1);

  // 1% num disco com 5% livres: ok no critério percentual (antes travava como 100%).
  const e = evaluateDiskSpace({ totalBytes: 1000 * GIB, availableBytes: 50 * GIB }, one.thresholds);
  assert.equal(e.verdict, "ok");
});

// ── núcleo do CLI ──

function guardRun(readings: Array<{ totalBytes: number; availableBytes: number } | Error>, args: Record<string, string> = {}) {
  let i = 0;
  const cleanups: Array<Record<string, string>> = [];
  const code = runDiskGuard(args, {}, "/repo", {
    measure: () => {
      const r = readings[Math.min(i++, readings.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    cleanup: (a) => cleanups.push(a),
    log: () => {},
    warn: () => {},
  });
  return { code, cleanups };
}

test("runDiskGuard: espaço ok não limpa e sai 0", () => {
  const r = guardRun([{ totalBytes: 100 * GIB, availableBytes: 50 * GIB }]);
  assert.equal(r.code, 0);
  assert.equal(r.cleanups.length, 0);
});

test("runDiskGuard: baixo + limpeza recupera sai 0, limpeza com --reclaim-open-pr", () => {
  const r = guardRun([
    { totalBytes: 100 * GIB, availableBytes: 1 * GIB },
    { totalBytes: 100 * GIB, availableBytes: 40 * GIB },
  ]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.cleanups, [{ "reclaim-open-pr": "true" }]);
});

test("runDiskGuard: continua baixo sai 1 (não abrir onda)", () => {
  const r = guardRun([{ totalBytes: 100 * GIB, availableBytes: 1 * GIB }]);
  assert.equal(r.code, 1);
  assert.equal(r.cleanups.length, 1);
});

test("runDiskGuard: --check-only não limpa; statfs falhando sai 2", () => {
  assert.equal(guardRun([{ totalBytes: 100 * GIB, availableBytes: 1 * GIB }], { "check-only": "true" }).cleanups.length, 0);
  assert.equal(guardRun([new Error("EACCES")]).code, 2);
});
