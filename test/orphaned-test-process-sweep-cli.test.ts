/**
 * test/orphaned-test-process-sweep-cli.test.ts (#8661)
 *
 * Regressão (#633) pro CLI `scripts/orphaned-test-process-sweep.ts` — item
 * 1 pendente do #7753. Todas as dependências reais (`ps`, `process.kill`,
 * plataforma) são injetadas via `MainDeps`, então este teste nunca mata um
 * processo de verdade nem depende do SO onde a suíte roda.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { main, type MainDeps } from "../scripts/orphaned-test-process-sweep.ts";
import type { ProcessInfo } from "../scripts/lib/list-processes.ts";

function makeDeps(overrides: Partial<MainDeps> & { processes?: ProcessInfo[] } = {}): {
  deps: MainDeps;
  logs: string[];
  warns: string[];
  killed: Array<{ pid: number; signal: NodeJS.Signals }>;
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const deps: MainDeps = {
    platform: "linux",
    listProcesses: () => overrides.processes ?? [],
    killPid: (pid, signal) => {
      killed.push({ pid, signal });
    },
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    ...overrides,
  };
  return { deps, logs, warns, killed };
}

const REMOVED_WORKTREE = "/home/x/.claude/worktrees/agent-removido";
const ORPHAN_PROCESS: ProcessInfo = {
  pid: 4242,
  ppid: 1,
  cmd: `node --experimental-addon-modules --test-isolation=process --import=${REMOVED_WORKTREE}/node_modules/tsx/loader.mjs test/x.test.ts`,
};

test("main: win32 sai 0 sem chamar listProcesses (plataforma não suportada)", () => {
  let listCalled = false;
  const { deps, logs } = makeDeps({
    platform: "win32",
    listProcesses: () => {
      listCalled = true;
      return [];
    },
  });
  const code = main([], deps);
  assert.equal(code, 0);
  assert.equal(listCalled, false);
  assert.match(logs[0], /não suportada/);
});

test("main: nenhum órfão encontrado -> loga e sai 0, nunca chama killPid", () => {
  const { deps, logs, killed } = makeDeps({ processes: [{ pid: 1, ppid: 0, cmd: "node --test test/x.test.ts" }] });
  const code = main([], deps);
  assert.equal(code, 0);
  assert.equal(killed.length, 0);
  assert.match(logs[0], /nenhum processo órfão encontrado/);
});

test("main --dry-run: encontra órfão mas NUNCA mata (killPid não é chamado)", () => {
  const { deps, logs, killed } = makeDeps({ processes: [ORPHAN_PROCESS] });
  const code = main(["--dry-run"], deps);
  assert.equal(code, 0);
  assert.equal(killed.length, 0, "dry-run nunca mata");
  assert.match(logs.join("\n"), /\(dry-run\) mataria PID 4242/);
});

test("main (default): mata o órfão por PID com SIGKILL — nunca por nome de imagem", () => {
  const { deps, logs, killed } = makeDeps({ processes: [ORPHAN_PROCESS] });
  const code = main([], deps);
  assert.equal(code, 0);
  assert.deepEqual(killed, [{ pid: 4242, signal: "SIGKILL" }]);
  assert.match(logs.join("\n"), /matou PID 4242/);
});

test("main: killPid lançando (processo já morreu, ESRCH) vira warning, não aborta a varredura", () => {
  const secondOrphan: ProcessInfo = {
    pid: 5555,
    ppid: 1,
    cmd: `node --test-isolation=process --import=${REMOVED_WORKTREE}/node_modules/tsx/loader.mjs test/y.test.ts`,
  };
  const { deps, logs, warns, killed } = makeDeps({
    processes: [ORPHAN_PROCESS, secondOrphan],
    killPid: (pid) => {
      if (pid === 4242) throw new Error("ESRCH");
      killed.push({ pid, signal: "SIGKILL" });
    },
  });
  const code = main([], deps);
  assert.equal(code, 0, "falha ao matar 1 PID não derruba o exit code do sweep inteiro");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /falha ao matar PID 4242/);
  assert.deepEqual(killed, [{ pid: 5555, signal: "SIGKILL" }], "o 2º órfão ainda é processado normalmente");
  assert.match(logs.join("\n"), /2 processo\(s\) órfão\(s\) processado\(s\)/);
});
