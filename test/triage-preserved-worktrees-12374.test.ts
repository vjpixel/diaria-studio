/**
 * test/triage-preserved-worktrees-12374.test.ts (#12374)
 *
 * Triagem + descarte com resgate dos worktrees que o cleanup preserva por
 * sujeira. Repositório git TEMPORÁRIO (mkdtemp) com remoto bare, worktrees
 * reais e `gh` mockado via `prsForBranch`. Nunca toca os worktrees desta
 * máquina.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTriage, type TriageDeps } from "../scripts/triage-preserved-worktrees.ts";
import { removeWorktreeSafe } from "../scripts/cleanup-merged-worktrees.ts";
import {
  classifyForDiscard,
  parseLockPid,
  parseLockReasons,
  summarizePorcelainStatus,
  summarizePrState,
  LOCK_STALE_THRESHOLD_MS,
  type TriageFacts,
} from "../scripts/lib/worktree-triage.ts";
import type { SessionRecord } from "../scripts/lib/session-registry.ts";

const DAY = 24 * 60 * 60 * 1000;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=.no-hooks", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr}`);
  return r.stdout;
}

interface Fixture {
  root: string;
  repo: string;
  wt: (name: string) => string;
  cleanup: () => void;
}

const BRANCHES: Record<string, string> = {
  a: "overnight/fix-101-a", // mergeada, suja → descartável
  b: "overnight/fix-102-b", // PR aberta → manter
  c: "overnight/fix-103-c", // lock de processo vivo → manter
  d: "overnight/fix-104-d", // em uso por sessão → manter
  e: "overnight/fix-105-e", // fechada, commit não enviado → descartável
  f: "overnight/fix-106-f", // lock de processo morto e velho → descartável
  g: "overnight/fix-107-g", // sem PR → manter
  h: "overnight/fix-108-h", // gh falhou → manter
};

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "triage-12374-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  git(root, "init", "--bare", "-b", "master", remote);
  git(root, "init", "-b", "master", repo);
  writeFileSync(join(repo, "a.txt"), "original\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "--no-verify", "-m", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "master");
  const wt = (name: string) => join(root, "wts", `wt-${name}`).replace(/\\/g, "/");
  for (const [name, branch] of Object.entries(BRANCHES)) {
    git(repo, "worktree", "add", "-b", branch, wt(name), "master");
    git(wt(name), "push", "origin", branch);
  }
  for (const name of ["a", "b", "c", "d", "f", "g", "h"]) {
    writeFileSync(join(wt(name), "a.txt"), `modified in ${name}\n`);
    writeFileSync(join(wt(name), "new.txt"), `untracked in ${name}\n`);
  }
  writeFileSync(join(wt("e"), "e.txt"), "local only\n");
  git(wt("e"), "add", "e.txt");
  git(wt("e"), "commit", "--no-verify", "-m", "commit nunca enviado da e");
  git(repo, "worktree", "lock", "--reason", `claude agent c (pid ${process.pid})`, wt("c"));
  git(repo, "worktree", "lock", "--reason", "claude agent f (pid 999999)", wt("f"));
  return { root, repo, wt, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function deps(fx: Fixture, logs: string[], overrides: Partial<TriageDeps> = {}): TriageDeps {
  const prs: Record<string, Array<{ number: number; state: string }> | null> = {
    [BRANCHES.a]: [{ number: 9001, state: "MERGED" }],
    [BRANCHES.b]: [
      { number: 9002, state: "MERGED" },
      { number: 9003, state: "OPEN" },
    ],
    [BRANCHES.c]: [{ number: 9004, state: "MERGED" }],
    [BRANCHES.d]: [{ number: 9005, state: "MERGED" }],
    [BRANCHES.e]: [{ number: 9006, state: "CLOSED" }],
    [BRANCHES.f]: [{ number: 9007, state: "MERGED" }],
    [BRANCHES.g]: [],
    [BRANCHES.h]: null,
  };
  return {
    prsForBranch: (branch) => (branch in prs ? prs[branch] : null),
    listActiveSessions: () => ({
      sessions: [{ sessionId: "outra", stale: false, branch: BRANCHES.d } as unknown as SessionRecord],
      readable: true,
    }),
    isPidAlive: (pid) => pid === process.pid,
    removeWorktree: (path) => removeWorktreeSafe(path, fx.repo, []),
    nowMs: Date.now() + 30 * DAY,
    log: (line) => logs.push(line),
    ...overrides,
  };
}

test("#12374 relatório é somente leitura e classifica cada caso", () => {
  const fx = makeFixture();
  try {
    const logs: string[] = [];
    const code = runTriage({ json: "true" }, fx.repo, deps(fx, logs));
    assert.equal(code, 0);
    const rows = JSON.parse(logs[0]) as Array<{ facts: TriageFacts; decision: { verdict: string; blockers: string[] } }>;
    const byName = new Map(rows.map((r) => [r.facts.name, r]));
    assert.equal(rows.length, 8);
    assert.equal(byName.get("wt-a")!.decision.verdict, "descartavel");
    assert.deepEqual(byName.get("wt-a")!.facts.dirty, { tracked: 1, untracked: 1, total: 2 });
    assert.equal(byName.get("wt-e")!.decision.verdict, "descartavel");
    assert.equal(byName.get("wt-e")!.facts.unpushedCommits, 1);
    assert.equal(byName.get("wt-f")!.decision.verdict, "descartavel");
    assert.match(byName.get("wt-b")!.decision.blockers.join(";"), /PR aberta/);
    assert.match(byName.get("wt-c")!.decision.blockers.join(";"), /processo vivo/);
    assert.match(byName.get("wt-d")!.decision.blockers.join(";"), /sessão viva/);
    assert.match(byName.get("wt-g")!.decision.blockers.join(";"), /sem PR/);
    assert.match(byName.get("wt-h")!.decision.blockers.join(";"), /indeterminado/);
    for (const name of Object.keys(BRANCHES)) assert.ok(existsSync(fx.wt(name)), `wt-${name} não pode sumir no relatório`);
    assert.equal(existsSync(join(fx.repo, "data")), false);
  } finally {
    fx.cleanup();
  }
});

test("#12374 relatório em markdown lista descartáveis primeiro", () => {
  const fx = makeFixture();
  try {
    const logs: string[] = [];
    runTriage({}, fx.repo, deps(fx, logs));
    const report = logs.join("\n");
    assert.match(report, /8 worktree\(s\) avaliado\(s\), 3 descartável/);
    const firstRow = report.split("\n").find((l) => l.startsWith("| wt-"))!;
    assert.match(firstRow, /descartavel/);
  } finally {
    fx.cleanup();
  }
});

test("#12374 --discard salva o resgate e remove só os descartáveis", () => {
  const fx = makeFixture();
  try {
    const logs: string[] = [];
    const rescue = join(fx.root, "rescue");
    const d = deps(fx, logs);
    const code = runTriage({ discard: "true", "rescue-dir": rescue }, fx.repo, d);
    assert.equal(code, 0, logs.join("\n"));
    for (const name of ["a", "e", "f"]) assert.equal(existsSync(fx.wt(name)), false, `wt-${name} deveria sair`);
    for (const name of ["b", "c", "d", "g", "h"]) assert.ok(existsSync(fx.wt(name)), `wt-${name} deveria ficar`);
    const listed = git(fx.repo, "worktree", "list", "--porcelain");
    assert.doesNotMatch(listed, /wt-a\b/);
    assert.match(listed, /wt-c/);

    const day = new Date(d.nowMs).toISOString().slice(0, 10);
    const a = join(rescue, day, "wt-a");
    assert.match(readFileSync(join(a, "tracked.diff"), "utf8"), /\+modified in a/);
    assert.equal(readFileSync(join(a, "untracked.txt"), "utf8"), "new.txt\n");
    assert.equal(JSON.parse(readFileSync(join(a, "meta.json"), "utf8")).branch, BRANCHES.a);
    const e = join(rescue, day, "wt-e");
    assert.match(readFileSync(join(e, "unpushed-commits.patch"), "utf8"), /commit nunca enviado da e/);
  } finally {
    fx.cleanup();
  }
});

test("#12374 --discard reconfere a PR antes de remover e respeita --only", () => {
  const fx = makeFixture();
  try {
    const logs: string[] = [];
    let calls = 0;
    const base = deps(fx, logs);
    const d = deps(fx, logs, {
      prsForBranch: (branch) => {
        // A 2ª consulta da wt-a (logo antes de remover) já vê uma PR aberta.
        if (branch === BRANCHES.a && ++calls > 1) return [{ number: 9010, state: "OPEN" }];
        return base.prsForBranch(branch);
      },
    });
    runTriage({ discard: "true", "rescue-dir": join(fx.root, "rescue"), only: "wt-a,wt-e" }, fx.repo, d);
    assert.ok(existsSync(fx.wt("a")), "PR aberta no meio do caminho manda manter");
    assert.equal(existsSync(fx.wt("e")), false);
    assert.ok(existsSync(fx.wt("f")), "fora do --only");
  } finally {
    fx.cleanup();
  }
});

test("#12374 --discard sem data/ e sem --rescue-dir recusa sem remover nada", () => {
  const fx = makeFixture();
  try {
    const logs: string[] = [];
    const code = runTriage({ discard: "true" }, fx.repo, deps(fx, logs));
    assert.equal(code, 1);
    assert.match(logs.join("\n"), /--discard recusado/);
    for (const name of Object.keys(BRANCHES)) assert.ok(existsSync(fx.wt(name)));
  } finally {
    fx.cleanup();
  }
});

test("#12374 registro de sessões ilegível bloqueia todo descarte", () => {
  const fx = makeFixture();
  try {
    const logs: string[] = [];
    mkdirSync(join(fx.repo, "data"));
    runTriage({ discard: "true" }, fx.repo, deps(fx, logs, { listActiveSessions: () => ({ sessions: [], readable: false }) }));
    for (const name of Object.keys(BRANCHES)) assert.ok(existsSync(fx.wt(name)));
  } finally {
    fx.cleanup();
  }
});

// ── lógica pura ─────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-11-07T12:00:00Z");
function facts(over: Partial<TriageFacts> = {}): TriageFacts {
  return {
    path: "/x/wt",
    name: "wt",
    branch: "overnight/fix-1-x",
    locked: false,
    lockReason: null,
    lockPidAlive: null,
    lastActivityMs: NOW - 10 * DAY,
    dirty: { tracked: 1, untracked: 0, total: 1 },
    unpushedCommits: 0,
    pr: { state: "merged", prNumbers: [1] },
    inUse: false,
    registryReadable: true,
    ...over,
  };
}

test("#12374 summarizePrState: aberta vence mergeada; falha vira unknown", () => {
  assert.equal(summarizePrState([{ number: 1, state: "MERGED" }, { number: 2, state: "OPEN" }]).state, "open");
  assert.equal(summarizePrState([{ number: 1, state: "CLOSED" }, { number: 2, state: "MERGED" }]).state, "merged");
  assert.equal(summarizePrState([{ number: 1, state: "CLOSED" }]).state, "closed");
  assert.equal(summarizePrState([]).state, "none");
  assert.equal(summarizePrState(null).state, "unknown");
});

test("#12374 parseLockReasons/parseLockPid", () => {
  const porcelain = [
    "worktree C:\\r",
    "HEAD abc",
    "branch refs/heads/master",
    "",
    "worktree C:/r/.claude/worktrees/agent-1",
    "branch refs/heads/x",
    "locked claude agent agent-1 (pid 4242)",
    "",
    "worktree /r/wt2",
    "detached",
    "locked",
    "",
  ].join("\n");
  const m = parseLockReasons(porcelain);
  assert.equal(m.get("C:/r/.claude/worktrees/agent-1"), "claude agent agent-1 (pid 4242)");
  assert.equal(m.get("/r/wt2"), null);
  assert.equal(m.has("C:/r"), false);
  assert.equal(parseLockPid("claude agent agent-1 (pid 4242)"), 4242);
  assert.equal(parseLockPid("manual"), null);
  assert.equal(parseLockPid(null), null);
});

test("#12374 summarizePorcelainStatus separa rastreado de untracked", () => {
  assert.deepEqual(summarizePorcelainStatus(" M a.txt\n?? b.txt\nA  c.txt\n"), { tracked: 2, untracked: 1, total: 3 });
  assert.deepEqual(summarizePorcelainStatus(""), { tracked: 0, untracked: 0, total: 0 });
});

test("#12374 classifyForDiscard: cada guarda bloqueia sozinha", () => {
  assert.equal(classifyForDiscard(facts(), NOW).verdict, "descartavel");
  assert.equal(classifyForDiscard(facts({ pr: { state: "closed", prNumbers: [1] } }), NOW).verdict, "descartavel");
  const blocked: Array<Partial<TriageFacts>> = [
    { inUse: true },
    { registryReadable: false },
    { pr: { state: "open", prNumbers: [1] } },
    { pr: { state: "none", prNumbers: [] } },
    { pr: { state: "unknown", prNumbers: [] } },
    { branch: null },
    { lastActivityMs: null },
    { lastActivityMs: NOW - 1 * DAY },
    { dirty: null },
    { unpushedCommits: null },
    { locked: true, lockPidAlive: true },
    { locked: true, lockPidAlive: null },
    { locked: true, lockPidAlive: false, lastActivityMs: NOW - LOCK_STALE_THRESHOLD_MS + DAY },
  ];
  for (const over of blocked) {
    assert.equal(classifyForDiscard(facts(over), NOW).verdict, "manter", JSON.stringify(over));
  }
  assert.equal(
    classifyForDiscard(facts({ locked: true, lockPidAlive: false, lastActivityMs: NOW - LOCK_STALE_THRESHOLD_MS - DAY }), NOW).verdict,
    "descartavel",
  );
  assert.equal(classifyForDiscard(facts({ lastActivityMs: NOW - 1 * DAY }), NOW, 0).verdict, "descartavel");
});
