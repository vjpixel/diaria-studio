/**
 * test/triage-preserved-worktrees-detached-12394.test.ts (#12394)
 *
 * Worktree sujo em detached HEAD: até o #12394 a triagem nunca o liberava
 * (sem branch, sem PR para conferir). Critério novo: sai com resgate quando o
 * HEAD é alcançável por uma ref remota (0 commits fora do remoto); com commit
 * local, fica. Repositório git TEMPORÁRIO com remoto bare, nunca os worktrees
 * desta máquina.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTriage, type TriageDeps } from "../scripts/triage-preserved-worktrees.ts";
import { removeWorktreeSafe } from "../scripts/cleanup-merged-worktrees.ts";
import { classifyForDiscard, type TriageFacts } from "../scripts/lib/worktree-triage.ts";

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

/**
 * - `limpo-remoto`: detached no master enviado, sujo → descartável;
 * - `commit-local`: detached com commit nunca enviado, sujo → manter.
 */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "triage-12394-"));
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
  for (const name of ["limpo-remoto", "commit-local"]) {
    git(repo, "worktree", "add", "--detach", wt(name), "master");
    writeFileSync(join(wt(name), "a.txt"), `modified in ${name}\n`);
    writeFileSync(join(wt(name), "new.txt"), `untracked in ${name}\n`);
  }
  writeFileSync(join(wt("commit-local"), "c.txt"), "local only\n");
  git(wt("commit-local"), "add", "c.txt");
  git(wt("commit-local"), "commit", "--no-verify", "-m", "commit detached nunca enviado");
  return { root, repo, wt, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function deps(fx: Fixture, logs: string[], overrides: Partial<TriageDeps> = {}): TriageDeps {
  return {
    // Detached não consulta PR nenhuma; se consultar, o teste acusa.
    prsForBranch: (branch) => {
      throw new Error(`prsForBranch não deveria ser chamado (branch ${branch})`);
    },
    listActiveSessions: () => ({ sessions: [], readable: true }),
    isPidAlive: () => false,
    removeWorktree: (path) => removeWorktreeSafe(path, fx.repo, []),
    nowMs: Date.now() + 30 * DAY,
    log: (line) => logs.push(line),
    ...overrides,
  };
}

type Row = { facts: TriageFacts; decision: { verdict: string; blockers: string[] } };

test("#12394 detached HEAD sujo sem commit fora do remoto é descartável; com commit local fica", () => {
  const fx = makeFixture();
  try {
    const logs: string[] = [];
    assert.equal(runTriage({ json: "true" }, fx.repo, deps(fx, logs)), 0);
    const rows = JSON.parse(logs[0]) as Row[];
    const byName = new Map(rows.map((r) => [r.facts.name, r]));
    const ok = byName.get("wt-limpo-remoto")!;
    assert.equal(ok.facts.branch, null);
    assert.equal(ok.facts.unpushedCommits, 0);
    assert.equal(ok.decision.verdict, "descartavel", ok.decision.blockers.join("; "));
    const local = byName.get("wt-commit-local")!;
    assert.equal(local.facts.unpushedCommits, 1);
    assert.equal(local.decision.verdict, "manter");
    assert.match(local.decision.blockers.join(";"), /detached HEAD com commit fora do remoto/);
  } finally {
    fx.cleanup();
  }
});

test("#12394 --discard remove o detached descartável com resgate e mantém o de commit local", () => {
  const fx = makeFixture();
  try {
    const logs: string[] = [];
    const rescue = join(fx.root, "rescue");
    const d = deps(fx, logs);
    assert.equal(runTriage({ discard: "true", "rescue-dir": rescue }, fx.repo, d), 0, logs.join("\n"));
    assert.equal(existsSync(fx.wt("limpo-remoto")), false, logs.join("\n"));
    assert.ok(existsSync(fx.wt("commit-local")));
    const day = new Date(d.nowMs).toISOString().slice(0, 10);
    const dir = join(rescue, day, "wt-limpo-remoto");
    assert.match(readFileSync(join(dir, "tracked.diff"), "utf8"), /\+modified in limpo-remoto/);
    assert.equal(readFileSync(join(dir, "untracked", "new.txt"), "utf8"), "untracked in limpo-remoto\n");
    assert.equal(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).branch, null);
  } finally {
    fx.cleanup();
  }
});

test("#12394 --discard reconfere: commit novo ou checkout de branch entre relatório e remoção mantém", () => {
  for (const mutate of ["commit", "checkout"] as const) {
    const fx = makeFixture();
    try {
      const logs: string[] = [];
      const target = fx.wt("limpo-remoto");
      // Muda o worktree depois da coleta e antes da remoção: o descarte relê o
      // estado ao vivo. O gancho é o 1º `log`, que imprime o relatório já
      // classificado e roda antes do laço de descarte.
      let mutated = false;
      const d = deps(fx, logs, {
        log: (line) => {
          logs.push(line);
          if (mutated) return;
          mutated = true;
          const row = (JSON.parse(line) as Row[]).find((r) => r.facts.name === "wt-limpo-remoto")!;
          assert.equal(row.decision.verdict, "descartavel", "o relatório viu o estado antigo");
          if (mutate === "commit") {
            writeFileSync(join(target, "late.txt"), "tarde\n");
            git(target, "add", "late.txt");
            git(target, "commit", "--no-verify", "-m", "commit tardio");
          } else {
            git(target, "checkout", "-q", "-b", "nova-branch");
          }
        },
      });
      runTriage({ json: "true", discard: "true", "rescue-dir": join(fx.root, "rescue") }, fx.repo, d);
      assert.ok(mutated);
      assert.ok(existsSync(target), `${mutate}: o worktree deveria ficar\n${logs.join("\n")}`);
      assert.match(logs.join("\n"), mutate === "commit" ? /agora com 1 commit/ : /saiu do detached/);
    } finally {
      fx.cleanup();
    }
  }
});

test("#12394 classifyForDiscard: detached só sai com 0 commits fora do remoto", () => {
  const NOW = Date.parse("2026-11-08T12:00:00Z");
  const base: TriageFacts = {
    path: "/x/wt",
    name: "wt",
    branch: null,
    locked: false,
    lockReason: null,
    lockPidAlive: null,
    lastActivityMs: NOW - 10 * DAY,
    dirty: { tracked: 1, untracked: 1, total: 2 },
    unpushedCommits: 0,
    untrackedSize: { files: 1, bytes: 10 },
    pr: { state: "unknown", prNumbers: [] },
    inUse: false,
    registryReadable: true,
  };
  assert.equal(classifyForDiscard(base, NOW).verdict, "descartavel");
  assert.equal(classifyForDiscard({ ...base, unpushedCommits: 2 }, NOW).verdict, "manter");
  assert.equal(classifyForDiscard({ ...base, unpushedCommits: null }, NOW).verdict, "manter");
  // As demais guardas continuam valendo para detached.
  assert.equal(classifyForDiscard({ ...base, inUse: true }, NOW).verdict, "manter");
  assert.equal(classifyForDiscard({ ...base, lastActivityMs: NOW - DAY }, NOW).verdict, "manter");
});
