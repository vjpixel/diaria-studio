/**
 * #12457 — `cleanup-merged-worktrees.ts` imprimia `falha ao remover ...: exit
 * null` no Windows e passava de 120 s. Causa: o `git worktree remove` rodava
 * com o timeout de 10 s das consultas; ao estourar, o `spawnSync` mata o git e
 * devolve `status: null` + stderr vazio, e o log só mostrava `exit null`.
 *
 * Cobre: diagnóstico puro (sucesso, falha com stderr, timeout, sinal, spawn
 * que não rodou), `removeWorktreeSafe` com runner injetado (teto de 30 s
 * repassado, motivo legível) e o laço principal (segue para o próximo depois
 * de uma falha, tempo por worktree e total no log, nunca lança).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeGitRemoveFailure,
  removeWorktreeSafe,
  runMainWithCheckers,
  WORKTREE_REMOVE_TIMEOUT_MS,
  type WorktreeEntry,
  type WorktreeRemoveRunResult,
} from "../scripts/cleanup-merged-worktrees.ts";

function timeoutError(): Error & { code: string } {
  return Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
}

// ── describeGitRemoveFailure (puro) ──

test("#12457 — sucesso (status 0) não é falha", () => {
  assert.equal(describeGitRemoveFailure({ status: 0, stdout: "", stderr: "" }, 30_000), null);
});

test("#12457 — falha com stderr: código de saída e stderr no motivo", () => {
  const msg = describeGitRemoveFailure(
    { status: 128, signal: null, stderr: "fatal: 'x' contains modified or untracked files\n" },
    30_000,
  );
  assert.ok(msg);
  assert.match(msg, /código 128/);
  assert.match(msg, /stderr: fatal: 'x' contains modified or untracked files/);
});

test("#12457 — timeout do spawnSync (status null, SIGTERM, ETIMEDOUT) vira 'timeout', nunca 'exit null'", () => {
  const msg = describeGitRemoveFailure(
    { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: timeoutError() },
    30_000,
  );
  assert.ok(msg);
  assert.match(msg, /^timeout: git worktree remove passou de 30s/);
  assert.match(msg, /SIGTERM/);
  assert.match(msg, /sem stderr/);
  assert.doesNotMatch(msg, /exit null/);
});

test("#12457 — morto por sinal sem timeout: nomeia o sinal", () => {
  const msg = describeGitRemoveFailure({ status: null, signal: "SIGKILL", stderr: "" }, 30_000);
  assert.ok(msg);
  assert.match(msg, /sinal SIGKILL/);
});

test("#12457 — spawn que não rodou (ENOENT) diz o código do erro", () => {
  const err = Object.assign(new Error("spawnSync git ENOENT"), { code: "ENOENT" });
  const msg = describeGitRemoveFailure({ status: null, signal: null, error: err }, 30_000);
  assert.ok(msg);
  assert.match(msg, /não rodou: ENOENT/);
});

test("#12457 — status null sem sinal nem erro ainda vira frase legível", () => {
  const msg = describeGitRemoveFailure({ status: null, signal: null }, 30_000);
  assert.ok(msg);
  assert.doesNotMatch(msg, /exit null/);
  assert.match(msg, /sem código de saída/);
});

// ── removeWorktreeSafe com runner injetado ──

function withTmpWorktree(fn: (path: string, base: string) => void) {
  const base = mkdtempSync(join(tmpdir(), "cmw-12457-"));
  try {
    fn(join(base, "agent-x"), base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("#12457 — removeWorktreeSafe repassa o teto de 30 s por worktree ao runner", () => {
  assert.equal(WORKTREE_REMOVE_TIMEOUT_MS, 30_000);
  withTmpWorktree((path, base) => {
    const calls: { args: string[]; timeoutMs: number; cwd: string }[] = [];
    const result = removeWorktreeSafe(path, base, [], {
      run: (args, opts) => {
        calls.push({ args, ...opts });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["worktree", "remove", "--force", path]);
    assert.equal(calls[0].timeoutMs, 30_000);
    assert.equal(calls[0].cwd, base);
    // git "sucesso" e diretório inexistente: nada sobrou, ok.
    assert.equal(result.ok, true);
  });
});

test("#12457 — removeWorktreeSafe: timeout devolve motivo 'timeout' com o teto usado", () => {
  withTmpWorktree((path, base) => {
    const timedOut: WorktreeRemoveRunResult = { status: null, signal: "SIGTERM", stderr: "", error: timeoutError() };
    const result = removeWorktreeSafe(path, base, [], { run: () => timedOut, timeoutMs: 5_000 });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /^timeout: git worktree remove passou de 5s/);
  });
});

test("#12457 — removeWorktreeSafe: falha com stderr devolve o stderr", () => {
  withTmpWorktree((path, base) => {
    const result = removeWorktreeSafe(path, base, [], {
      run: () => ({ status: 1, signal: null, stderr: "error: failed to delete 'x': Permission denied" }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /código 1 — stderr: error: failed to delete 'x': Permission denied/);
  });
});

test("#12457 — removeWorktreeSafe: runner que lança vira falha, nunca exceção", () => {
  withTmpWorktree((path, base) => {
    const result = removeWorktreeSafe(path, base, [], {
      run: () => {
        throw new Error("boom");
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /lançou: boom/);
  });
});

// ── laço principal: segue para o próximo, tempo por worktree e total ──

test("#12457 — main: timeout num worktree não para os seguintes; log traz motivo, tempo de cada um e o total", () => {
  const main: WorktreeEntry = { path: "/repo", branch: "master", locked: false };
  const a: WorktreeEntry = { path: "/repo/.claude/worktrees/agent-a", branch: "worktree-agent-a", locked: false };
  const b: WorktreeEntry = { path: "/repo/.claude/worktrees/agent-b", branch: "worktree-agent-b", locked: false };
  const c: WorktreeEntry = { path: "/repo/.claude/worktrees/agent-c", branch: "worktree-agent-c", locked: false };
  let now = 1_000_000;
  const attempted: string[] = [];
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (m: string) => logs.push(m);
  console.warn = (m: string) => logs.push(m);
  try {
    assert.doesNotThrow(() =>
      runMainWithCheckers({}, "/repo", {
        isMerged: () => true,
        hasOpenPr: () => false,
        branchExistsLocally: () => true,
        issueClosedAtMs: () => null,
        listWorktrees: () => [main, a, b, c],
        listActiveSessions: () => ({ sessions: [], readable: true }),
        listProcesses: () => [],
        isWorktreeDirty: () => false,
        removeWorktree: (p) => {
          attempted.push(p);
          if (p === a.path) {
            now += 30_000;
            return { ok: false, error: describeGitRemoveFailure({ status: null, signal: "SIGTERM", error: timeoutError() }, 30_000)! };
          }
          if (p === b.path) {
            now += 2_000;
            throw new Error("explodiu");
          }
          now += 1_500;
          return { ok: true };
        },
        removeWorktreeDir: () => ({ dirRemoved: true, errors: [] }),
        findHusks: () => [],
        clock: () => now,
      }),
    );
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  assert.deepEqual(attempted, [a.path, b.path, c.path]);
  const failA = logs.find((l) => l.includes(`falha ao remover ${a.path}`));
  assert.ok(failA, logs.join("\n"));
  assert.match(failA, /\(30s\): timeout: git worktree remove passou de 30s/);
  const failB = logs.find((l) => l.includes(`falha ao remover ${b.path}`));
  assert.ok(failB);
  assert.match(failB, /\(2s\): removeWorktree lançou: explodiu/);
  assert.ok(logs.some((l) => l.includes(`removido: ${c.path}`) && l.includes("1.5s")));
  assert.ok(logs.some((l) => /fim: 1 removido\(s\), 2 falha\(s\) em 33\.5s\./.test(l)), logs.join("\n"));
  assert.ok(logs.some((l) => /tempo total: 33\.5s\./.test(l)));
  assert.ok(!logs.some((l) => l.includes("exit null")));
});

test("#12457 — main: tempo total aparece também na saída antecipada (nada elegível)", () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (m: string) => logs.push(m);
  let now = 0;
  try {
    runMainWithCheckers({}, "/repo", {
      isMerged: () => false,
      hasOpenPr: () => false,
      branchExistsLocally: () => true,
      issueClosedAtMs: () => null,
      listWorktrees: () => [{ path: "/repo", branch: "master", locked: false }],
      listActiveSessions: () => ({ sessions: [], readable: true }),
      listProcesses: () => [],
      isWorktreeDirty: () => false,
      removeWorktree: () => ({ ok: true }),
      removeWorktreeDir: () => ({ dirRemoved: true, errors: [] }),
      findHusks: () => [],
      clock: () => (now += 250),
    });
  } finally {
    console.log = origLog;
  }
  assert.ok(logs.some((l) => l.includes("nenhum worktree elegível")));
  assert.ok(logs.some((l) => /tempo total: \d/.test(l)), logs.join("\n"));
});
