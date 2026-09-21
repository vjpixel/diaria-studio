/**
 * test/orphaned-test-process-sweep-cli.test.ts (#8661)
 *
 * Regressão (#633) pro CLI `scripts/orphaned-test-process-sweep.ts` — item
 * 1 pendente do #7753, mais o guard anti-race de reuso de PID (achado
 * CRÍTICO do fleet review da PR #8692, silent-failure-hunter). Todas as
 * dependências reais (`ps`, `process.kill`, plataforma) são injetadas via
 * `MainDeps`, então este teste nunca mata um processo de verdade nem
 * depende do SO onde a suíte roda.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { main, type MainDeps } from "../scripts/orphaned-test-process-sweep.ts";
import type { ProcessInfo } from "../scripts/lib/list-processes.ts";

const REMOVED_WORKTREE = "/home/x/.claude/worktrees/agent-removido";
const ORPHAN_PROCESS: ProcessInfo = {
  pid: 4242,
  ppid: 1,
  cmd: `node --experimental-addon-modules --test-isolation=process --import=${REMOVED_WORKTREE}/node_modules/tsx/loader.mjs test/x.test.ts`,
};

function errnoError(code: string, message = code): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function makeDeps(
  overrides: Partial<MainDeps> & { processes?: ProcessInfo[] } = {},
): {
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
    // Default: a reverificação "confirma" o mesmo processo do snapshot —
    // testes que não são sobre a reverificação em si (dry-run, kill normal,
    // ESRCH no kill) não precisam se preocupar com esse detalhe.
    readProcessNow: (pid) => (overrides.processes ?? []).find((p) => p.pid === pid) ?? null,
    killPid: (pid, signal) => {
      killed.push({ pid, signal });
    },
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    ...overrides,
  };
  return { deps, logs, warns, killed };
}

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

test("main --dry-run: encontra órfão mas NUNCA mata (killPid não é chamado, nem readProcessNow)", () => {
  let readCalled = false;
  const { deps, logs, killed } = makeDeps({
    processes: [ORPHAN_PROCESS],
    readProcessNow: () => {
      readCalled = true;
      return ORPHAN_PROCESS;
    },
  });
  const code = main(["--dry-run"], deps);
  assert.equal(code, 0);
  assert.equal(killed.length, 0, "dry-run nunca mata");
  assert.equal(readCalled, false, "dry-run não precisa reverificar — não vai matar de qualquer forma");
  assert.match(logs.join("\n"), /\(dry-run\) mataria PID 4242/);
});

test("main (default): reverifica e mata o órfão por PID com SIGKILL — nunca por nome de imagem", () => {
  const { deps, logs, killed } = makeDeps({ processes: [ORPHAN_PROCESS] });
  const code = main([], deps);
  assert.equal(code, 0);
  assert.deepEqual(killed, [{ pid: 4242, signal: "SIGKILL" }]);
  assert.match(logs.join("\n"), /matou PID 4242/);
});

test("main: killPid lançando ESRCH vira log benigno (processo morreu na janela entre reverificação e kill), não warning", () => {
  const secondOrphan: ProcessInfo = {
    pid: 5555,
    ppid: 1,
    cmd: `node --test-isolation=process --import=${REMOVED_WORKTREE}/node_modules/tsx/loader.mjs test/y.test.ts`,
  };
  const { deps, logs, warns, killed } = makeDeps({
    processes: [ORPHAN_PROCESS, secondOrphan],
    killPid: (pid) => {
      if (pid === 4242) throw errnoError("ESRCH");
      killed.push({ pid, signal: "SIGKILL" });
    },
  });
  const code = main([], deps);
  assert.equal(code, 0, "falha ao matar 1 PID não derruba o exit code do sweep inteiro");
  assert.equal(warns.length, 0, "ESRCH é benigno — não é warning (achado médio do fleet review #8692)");
  assert.match(logs.join("\n"), /PID 4242 já havia morrido no instante do kill \(ESRCH\)/);
  assert.deepEqual(killed, [{ pid: 5555, signal: "SIGKILL" }], "o 2º órfão ainda é processado normalmente");
  assert.match(logs.join("\n"), /2 processo\(s\) órfão\(s\) processado\(s\)/);
});

test("main: killPid lançando erro que NÃO é ESRCH (ex: EPERM) ainda vira warning", () => {
  const { deps, warns } = makeDeps({
    processes: [ORPHAN_PROCESS],
    killPid: () => {
      throw errnoError("EPERM", "permission denied");
    },
  });
  main([], deps);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /falha ao matar PID 4242/);
});

// ── guard anti-race de reuso de PID (#8661, achado CRÍTICO fleet review #8692) ──

test("main: PID reciclado pra processo NÃO-relacionado antes do kill -> NUNCA mata, warning específico de reuso", () => {
  const { deps, logs, warns, killed } = makeDeps({
    processes: [ORPHAN_PROCESS],
    // Simula o cenário do achado crítico: entre o snapshot e o kill, o PID
    // 4242 já não é mais o processo órfão — foi reciclado pra outra coisa
    // (aqui, um systemd unit comum, sem nenhuma relação com o worktree).
    readProcessNow: (pid) => (pid === 4242 ? { pid: 4242, ppid: 1, cmd: "/usr/lib/systemd/systemd-udevd" } : null),
  });
  const code = main([], deps);
  assert.equal(code, 0);
  assert.equal(killed.length, 0, "NUNCA mata quando a reverificação não bate — é exatamente o que o guard existe pra evitar");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /PID 4242 não bate mais o padrão esperado — provável reuso de PID, pulando kill/);
  assert.match(logs.join("\n"), /1 processo\(s\) órfão\(s\) processado\(s\)/, "ainda conta como 'processado' — decidido não matar, não é erro do sweep");
});

test("main: PID já não existe mais na hora do kill (morreu sozinho) -> log informativo, NUNCA warning, NUNCA mata", () => {
  const { deps, logs, warns, killed } = makeDeps({
    processes: [ORPHAN_PROCESS],
    readProcessNow: () => null, // já morreu entre o snapshot e a reverificação
  });
  const code = main([], deps);
  assert.equal(code, 0);
  assert.equal(killed.length, 0);
  assert.equal(warns.length, 0, "processo já morto sozinho é o caminho feliz, não uma falha");
  assert.match(logs.join("\n"), /PID 4242 já não existe mais \(morreu sozinho entre o snapshot e agora\)/);
});
