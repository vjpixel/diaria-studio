/**
 * test/worktree-remove-partial-14335.test.ts (#14335)
 *
 * Regressão (#633): `git worktree remove --force` que para no meio. No
 * Windows (Neo, 27/11/2026) um teste pendurado com a DLL do `sharp` carregada
 * de dentro do worktree fez o git sair com "Invalid argument" depois de já ter
 * apagado o `.git` (ordem alfabética, para no primeiro erro) e desregistrado o
 * worktree. A pasta ficou com arquivos rastreados e a junction de workspace
 * em `node_modules/`, invisível a todas as varreduras.
 *
 * Cobre: (1) o fallback de `resolveWorktreeRemoval` quando o git falhou sem
 * deixar `.git`; (2) a varredura `findPartialRemovalOrphans`; (3) a
 * comparação de path com `\` e caixa diferente do Windows; (4) a listagem de
 * processos no Windows para o guard do #8661; (5) a varredura de órfãos em
 * `runMainWithCheckers`, inclusive sem worktree elegível. Todo alvo de link é
 * um diretório descartável sob `mkdtemp`, e cada teste confere que ele
 * sobrevive intacto.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveWorktreeRemoval,
  findPartialRemovalOrphans,
  findWorktreeHusks,
  commandReferencesPath,
  findLiveProcessesInPath,
  normalizePathKey,
  PARTIAL_REMOVAL_ORPHAN_MIN_IDLE_MS,
} from "../scripts/lib/worktree-remove.ts";
import {
  parseWin32ProcessJson,
  listProcessesForWorktreeGuard,
  type ListProcessesOps,
  type ProcessInfo,
} from "../scripts/lib/list-processes.ts";
import { runMainWithCheckers } from "../scripts/cleanup-merged-worktrees.ts";

function mktmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Monta a pasta como o git a deixou no incidente: sem `.git`, com arquivos depois de `node_modules` e uma junction de workspace. */
function makePartialRemovalLeftover(base: string, name: string): { dir: string; target: string } {
  const dir = join(base, name);
  const target = join(base, `${name}-ALVO-descartavel`);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "canary.txt"), "conteúdo do alvo da junction");
  mkdirSync(join(dir, "node_modules", "@img", "sharp-win32-x64", "lib"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "@img", "sharp-win32-x64", "lib", "libvips-42.dll"), "dll");
  symlinkSync(target, join(dir, "node_modules", "arquivo"), "junction");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "x.ts"), "export {};\n");
  writeFileSync(join(dir, "package.json"), "{}\n");
  writeFileSync(join(dir, "README.md"), "# readme\n");
  return { dir, target };
}

// ── resolveWorktreeRemoval ──

test("#14335 resolveWorktreeRemoval: git falhou com 'Invalid argument' depois de apagar o .git -> limpa a sobra, alvo da junction intacto", () => {
  const base = mktmp("diaria-wtrm-14335-partial-");
  const { dir, target } = makePartialRemovalLeftover(base, "agent-a29f");
  const gitError = "git worktree remove saiu com código 255 — stderr: error: failed to delete 'C:/x/agent-a29f': Invalid argument";

  const result = resolveWorktreeRemoval({ ok: false, error: gitError }, dir);

  assert.deepEqual(result, { ok: true });
  assert.equal(existsSync(dir), false, "a pasta órfã precisa sumir");
  assert.equal(readFileSync(join(target, "canary.txt"), "utf8"), "conteúdo do alvo da junction");
  rmSync(base, { recursive: true, force: true });
});

test("#14335 resolveWorktreeRemoval: git falhou com o .git ainda presente -> sem fallback, erro do git intacto", () => {
  const base = mktmp("diaria-wtrm-14335-gitkept-");
  const { dir } = makePartialRemovalLeftover(base, "agent-locked");
  writeFileSync(join(dir, ".git"), "gitdir: /repo/.git/worktrees/agent-locked\n");

  const result = resolveWorktreeRemoval({ ok: false, error: "cannot remove a locked working tree" }, dir);

  assert.deepEqual(result, { ok: false, error: "cannot remove a locked working tree" });
  assert.equal(existsSync(join(dir, "package.json")), true, "nada apagado");
  rmSync(base, { recursive: true, force: true });
});

test("#14335 resolveWorktreeRemoval: git falhou e o diretório já não existe -> devolve o erro do git", () => {
  const base = mktmp("diaria-wtrm-14335-gone-");
  const result = resolveWorktreeRemoval({ ok: false, error: "boom" }, join(base, "nao-existe"));
  assert.deepEqual(result, { ok: false, error: "boom" });
  rmSync(base, { recursive: true, force: true });
});

// ── findPartialRemovalOrphans ──

test("#14335 findPartialRemovalOrphans: acha a sobra parada; pula casca, worktree com .git, registrado (separador/caixa diferentes) e recente", () => {
  const base = mktmp("diaria-wtrm-14335-scan-");
  const { dir: orphan } = makePartialRemovalLeftover(base, "agent-orfa");
  const { dir: recent } = makePartialRemovalLeftover(base, "agent-recente");
  const { dir: tracked } = makePartialRemovalLeftover(base, "agent-registrado");
  const live = join(base, "agent-vivo");
  mkdirSync(live);
  writeFileSync(join(live, ".git"), "gitdir: /repo/.git/worktrees/agent-vivo\n");
  writeFileSync(join(live, "package.json"), "{}\n");
  const husk = join(base, "agent-casca");
  mkdirSync(join(husk, "node_modules"), { recursive: true });

  const now = 10 * PARTIAL_REMOVAL_ORPHAN_MIN_IDLE_MS;
  const mtimes = new Map<string, number>([
    [orphan, 0],
    [recent, now - 60_000],
    [tracked, 0],
    [live, 0],
    [husk, 0],
  ]);
  // `git worktree list` devolve `/` e pode vir com outra caixa no Windows.
  const trackedFromGit = tracked.replace(/\\/g, "/");
  const trackedKey = /^[A-Za-z]:/.test(trackedFromGit) ? trackedFromGit.toUpperCase() : trackedFromGit;

  const found = findPartialRemovalOrphans(base, new Set([trackedKey]), {
    nowMs: now,
    getMtimeMs: (p) => mtimes.get(p) ?? null,
  });

  assert.deepEqual(found, [orphan]);
  rmSync(base, { recursive: true, force: true });
});

test("#14335 findPartialRemovalOrphans: diretório base ausente -> []", () => {
  assert.deepEqual(findPartialRemovalOrphans(join(tmpdir(), "diaria-nao-existe-14335")), []);
});

test("#14335 findWorktreeHusks: exclui o worktree registrado mesmo com separador diferente", () => {
  const base = mktmp("diaria-wtrm-14335-husk-");
  const husk = join(base, "agent-casca");
  mkdirSync(join(husk, "node_modules"), { recursive: true });
  assert.deepEqual(findWorktreeHusks(base, new Set([husk.replace(/\\/g, "/")])), []);
  assert.deepEqual(findWorktreeHusks(base), [husk]);
  rmSync(base, { recursive: true, force: true });
});

// ── path no Windows ──

test("#14335 commandReferencesPath: cmdline do Windows com '\\' casa o path do git com '/', sem diferenciar caixa", () => {
  const wt = "C:/Users/vjpix/Projects/diaria-studio/.claude/worktrees/agent-a29f3ece039f9efb6";
  const cmd =
    '"C:\\Program Files\\nodejs\\node.exe" --require C:\\Users\\vjpix\\Projects\\diaria-studio\\.claude\\worktrees\\agent-a29f3ece039f9efb6\\node_modules\\tsx\\dist\\preflight.cjs --test-isolation=process test\\shorts-corte-lock-signal-12004.test.ts';
  assert.equal(commandReferencesPath(cmd, wt), true);
  assert.equal(commandReferencesPath(cmd.toLowerCase(), wt), true);
  assert.equal(commandReferencesPath(cmd, `${wt}0`), false, "prefixo textual de outro worktree não casa");
  assert.equal(commandReferencesPath(cmd, wt.replace(/\//g, "\\")), true, "path com '\\' também casa");
  assert.equal(normalizePathKey("C:\\A\\B\\"), "c:/a/b");
  assert.equal(normalizePathKey("/home/X/y/"), "/home/X/y", "path POSIX mantém a caixa");
});

// ── listagem de processos no Windows ──

test("#14335 parseWin32ProcessJson: array, objeto solto e CommandLine nulo", () => {
  const arr = parseWin32ProcessJson(
    JSON.stringify([
      { ProcessId: 62860, ParentProcessId: 52900, CommandLine: "node.exe --test x" },
      { ProcessId: 4, ParentProcessId: 0, CommandLine: null },
      { ProcessId: null, ParentProcessId: 1, CommandLine: "lixo" },
    ]),
  );
  assert.deepEqual(arr, [
    { pid: 62860, ppid: 52900, cmd: "node.exe --test x" },
    { pid: 4, ppid: 0, cmd: "" },
  ]);
  assert.deepEqual(parseWin32ProcessJson(JSON.stringify({ ProcessId: 7, ParentProcessId: 1, CommandLine: "a" })), [
    { pid: 7, ppid: 1, cmd: "a" },
  ]);
  assert.deepEqual(parseWin32ProcessJson("  "), []);
  assert.throws(() => parseWin32ProcessJson("{não é json"));
});

test("#14335 listProcessesForWorktreeGuard: no Windows lê o CIM pelo PowerShell; falha vira [] (comportamento anterior)", () => {
  const calls: string[] = [];
  const okOps = {
    platform: "win32",
    execFileSync: ((file: string) => {
      calls.push(file);
      return JSON.stringify([{ ProcessId: 9, ParentProcessId: 1, CommandLine: "node x" }]);
    }) as unknown as ListProcessesOps["execFileSync"],
  } as ListProcessesOps;
  assert.deepEqual(listProcessesForWorktreeGuard(okOps), [{ pid: 9, ppid: 1, cmd: "node x" }]);
  assert.deepEqual(calls, ["powershell.exe"]);

  const failOps = {
    platform: "win32",
    execFileSync: (() => {
      throw new Error("powershell ausente");
    }) as unknown as ListProcessesOps["execFileSync"],
  } as ListProcessesOps;
  const origWrite = process.stderr.write.bind(process.stderr);
  const errs: string[] = [];
  process.stderr.write = ((s: string) => {
    errs.push(String(s));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.deepEqual(listProcessesForWorktreeGuard(failOps), []);
  } finally {
    process.stderr.write = origWrite;
  }
  assert.ok(errs.some((e) => e.includes("#14335")));

  const posixOps = {
    platform: "linux",
    execFileSync: ((file: string) => {
      calls.push(file);
      return "10 1 node y\n";
    }) as unknown as ListProcessesOps["execFileSync"],
  } as ListProcessesOps;
  assert.deepEqual(listProcessesForWorktreeGuard(posixOps), [{ pid: 10, ppid: 1, cmd: "node y" }]);
  assert.equal(calls.at(-1), "ps");
});

test("#14335 findLiveProcessesInPath: o teste pendurado do incidente (cmdline com '\\') bloqueia a remoção do worktree", () => {
  const wt = "C:/Users/vjpix/Projects/diaria-studio/.claude/worktrees/agent-a29f3ece039f9efb6";
  const snapshot: ProcessInfo[] = [
    {
      pid: 62860,
      ppid: 52900,
      cmd: "node.exe --require C:\\Users\\vjpix\\Projects\\diaria-studio\\.claude\\worktrees\\agent-a29f3ece039f9efb6\\node_modules\\tsx\\dist\\preflight.cjs --test-isolation=process",
    },
    { pid: 1, ppid: 0, cmd: "node C:\\outro\\lugar.js" },
  ];
  assert.deepEqual(
    findLiveProcessesInPath(wt, snapshot).map((p) => p.pid),
    [62860],
  );
});

// ── runMainWithCheckers ──

function baseCheckers(overrides: Partial<Parameters<typeof runMainWithCheckers>[2]>): Parameters<typeof runMainWithCheckers>[2] {
  return {
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
    ...overrides,
  };
}

function captureLogs(fn: () => void): string[] {
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (m: string) => logs.push(m);
  console.warn = (m: string) => logs.push(m);
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return logs;
}

test("#14335 runMainWithCheckers: sem worktree elegível, ainda varre e remove a pasta de remoção parcial", () => {
  const removed: string[] = [];
  const orphan = "/repo/.claude/worktrees/agent-a29f";
  const logs = captureLogs(() =>
    runMainWithCheckers(
      {},
      "/repo",
      baseCheckers({
        findOrphans: () => [orphan],
        removeWorktreeDir: (p) => {
          removed.push(p);
          return { dirRemoved: true, errors: [] };
        },
      }),
    ),
  );
  assert.deepEqual(removed, [orphan]);
  assert.ok(logs.some((l) => l.includes("pasta de remoção parcial removida (#14335)")), logs.join("\n"));
  assert.ok(logs.some((l) => l.includes("varredura de remoção parcial (#14335): 1/1")));
});

test("#14335 runMainWithCheckers: pasta referenciada por processo vivo é preservada, com o PID no aviso", () => {
  const removed: string[] = [];
  const orphan = "/repo/.claude/worktrees/agent-a29f";
  const logs = captureLogs(() =>
    runMainWithCheckers(
      {},
      "/repo",
      baseCheckers({
        findOrphans: () => [orphan],
        listProcesses: () => [{ pid: 62860, ppid: 52900, cmd: `node --require ${orphan}/node_modules/tsx/dist/preflight.cjs --test` }],
        removeWorktreeDir: (p) => {
          removed.push(p);
          return { dirRemoved: true, errors: [] };
        },
      }),
    ),
  );
  assert.deepEqual(removed, []);
  assert.ok(logs.some((l) => l.includes("preservada (#14335)") && l.includes("PID 62860")), logs.join("\n"));
});

test("#14335 runMainWithCheckers: --dry-run só relata a pasta, não remove nem lista processos", () => {
  let listed = 0;
  const removed: string[] = [];
  const logs = captureLogs(() =>
    runMainWithCheckers(
      { "dry-run": "true" },
      "/repo",
      baseCheckers({
        findOrphans: () => ["/repo/.claude/worktrees/agent-x"],
        listProcesses: () => {
          listed++;
          return [];
        },
        removeWorktreeDir: (p) => {
          removed.push(p);
          return { dirRemoved: true, errors: [] };
        },
      }),
    ),
  );
  assert.deepEqual(removed, []);
  assert.equal(listed, 0);
  assert.ok(logs.some((l) => l.includes("(dry-run) 1 pasta(s) de remoção parcial (#14335)")), logs.join("\n"));
});
