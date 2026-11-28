/**
 * test/worktree-remove-partial-14335.test.ts (#14335)
 *
 * Regressão (#633): `git worktree remove --force` que para no meio. No
 * Windows (Neo, 27/11/2026) um teste pendurado com a DLL do `sharp` carregada
 * de dentro do worktree fez o git sair com "Invalid argument" depois de já ter
 * apagado o `.git` (ordem do readdir, alfabética no NTFS; para no primeiro erro) e desregistrado o
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
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  resolveWorktreeRemoval,
  findPartialRemovalOrphans,
  findWorktreeHusks,
  commandReferencesPath,
  findLiveProcessesInPath,
  normalizePathKey,
  cleanupPartialRemovalLeftover,
  buildExcludedPathKeys,
  isExcludedPath,
  PARTIAL_REMOVAL_ORPHAN_MIN_IDLE_MS,
} from "../scripts/lib/worktree-remove.ts";
import {
  parseWin32ProcessJson,
  listProcessesForWorktreeGuard,
  listProcessesStrict,
  WIN32_PROCESS_QUERY_TIMEOUT_MS,
  type ListProcessesOps,
  type ProcessInfo,
} from "../scripts/lib/list-processes.ts";
import {
  runMainWithCheckers,
  removeWorktreeSafe,
  buildRealCheckers,
  describeRemovalOutcome,
} from "../scripts/cleanup-merged-worktrees.ts";
import { rescueOrphanDir, gitReachableBlobs, makeOrphanRescuer } from "../scripts/lib/orphan-rescue.ts";
import { cleanupIntegrationBranch, type TrainRunner } from "../scripts/lib/merge-train-live.ts";

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

  const rescued: string[] = [];
  const result = resolveWorktreeRemoval({ ok: false, error: gitError }, dir, {
    getLiveProcesses: () => [],
    rescue: (p) => {
      rescued.push(p);
      return { ok: true, rescueDir: null };
    },
  });

  assert.deepEqual(result, { ok: true, outcome: "partial-cleaned" });
  assert.deepEqual(rescued, [dir], "resgate roda antes de apagar");
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

test("#14335 listProcessesForWorktreeGuard (guard ANTIGO, antes do git): lê o CIM no Windows; falha vira [] só aqui", () => {
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
    listProcessesStrict: () => [],
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
        rescueOrphan: () => ({ ok: true, rescueDir: "/repo/data/worktree-rescue/2026-11-27/agent-a29f" }),
        removeWorktreeDir: (p) => {
          removed.push(p);
          return { dirRemoved: true, errors: [] };
        },
      }),
    ),
  );
  assert.deepEqual(removed, [orphan]);
  assert.ok(logs.some((l) => l.includes("resgate em /repo/data/worktree-rescue/2026-11-27/agent-a29f")), logs.join("\n"));
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
        // O guard antigo (fail-soft) não vê nada; o snapshot estrito da varredura vê.
        listProcesses: () => [],
        listProcessesStrict: () => [{ pid: 62860, ppid: 52900, cmd: `node --require ${orphan}/node_modules/tsx/dist/preflight.cjs --test` }],
        rescueOrphan: () => ({ ok: true, rescueDir: null }),
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
        listProcessesStrict: () => {
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

// ── coordenador, finding 1: processo vivo e resgate na remoção parcial ──

test("#14335 resolveWorktreeRemoval: remoção parcial com processo vivo no caminho -> preserva, PID no erro, sem resgate nem remoção", () => {
  const base = mktmp("diaria-wtrm-14335-live-");
  const { dir } = makePartialRemovalLeftover(base, "agent-vivo");
  let rescued = 0;
  const result = resolveWorktreeRemoval({ ok: false, error: "Invalid argument" }, dir, {
    getLiveProcesses: () => [{ pid: 62860, ppid: 52900, cmd: `node --require ${dir}\\node_modules\\tsx\\dist\\preflight.cjs` }],
    rescue: () => {
      rescued++;
      return { ok: true, rescueDir: null };
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error!, /PID 62860/);
  assert.equal(rescued, 0);
  assert.equal(existsSync(join(dir, "package.json")), true);
  rmSync(base, { recursive: true, force: true });
});

test("#14335 resolveWorktreeRemoval: remoção parcial sem resgate configurado -> nada é apagado", () => {
  const base = mktmp("diaria-wtrm-14335-norescue-");
  const { dir } = makePartialRemovalLeftover(base, "agent-sem-resgate");
  const result = resolveWorktreeRemoval({ ok: false, error: "Invalid argument" }, dir, { getLiveProcesses: () => [] });
  assert.equal(result.ok, false);
  assert.match(result.error!, /varredura de órfãos/);
  assert.equal(existsSync(join(dir, "package.json")), true);
  rmSync(base, { recursive: true, force: true });
});

test("#14335 resolveWorktreeRemoval: resgate falhou -> preserva a pasta", () => {
  const base = mktmp("diaria-wtrm-14335-rescuefail-");
  const { dir } = makePartialRemovalLeftover(base, "agent-resgate-falhou");
  const result = resolveWorktreeRemoval({ ok: false, error: "Invalid argument" }, dir, {
    getLiveProcesses: () => [],
    rescue: () => ({ ok: false, error: "resgate falhou (disco cheio), pasta preservada" }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error!, /disco cheio/);
  assert.equal(existsSync(join(dir, "package.json")), true);
  rmSync(base, { recursive: true, force: true });
});

test("#14335 cleanupIntegrationBranch (merge-train-live): remoção parcial com processo vivo REAL no caminho é preservada", async () => {
  const base = mktmp("diaria-wtrm-14335-mtl-");
  const { dir } = makePartialRemovalLeftover(base, "wt-integracao");
  const repo = makeRepoWithCommittedFiles(base);
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", dir], { stdio: "ignore" });
  try {
    await waitFor(() => listProcessesForWorktreeGuard().some((p) => p.pid === holder.pid));
    const warnings: string[] = [];
    const runner = {
      exec: (_cmd: string, args: string[]) =>
        args[0] === "worktree" ? { ok: false, stdout: "", stderr: "error: failed to delete: Invalid argument" } : { ok: true, stdout: "", stderr: "" },
      sleep: async () => {},
      now: () => 0,
      mkTempDir: () => "",
      warn: (m: string) => warnings.push(m),
    } as unknown as TrainRunner;
    const result = cleanupIntegrationBranch(runner, "merge-train/x", dir, repo);
    assert.equal(result.ok, false);
    assert.match(result.error!, new RegExp(`PID ${holder.pid}`));
    assert.equal(existsSync(join(dir, "package.json")), true, "nada apagado com processo vivo");
  } finally {
    holder.kill();
  }
  rmSync(base, { recursive: true, force: true });
});

test("#14335 branch-cleanup.ts: a remoção passa snapshot de processos e resgate ao resolveWorktreeRemoval", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "branch-cleanup.ts"), "utf8");
  assert.match(
    src,
    /resolveWorktreeRemoval\(removeResult, w\.path, \{\s*getLiveProcesses: \(\) => listProcessesStrict\(\),\s*rescue: makeOrphanRescuer\(cwd\),/,
  );
});

// ── coordenador, finding 2: resgate antes de apagar ──

function runGit(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** Repo com `README.md`, `package.json` e `scripts/x.ts` (o conteúdo de `makePartialRemovalLeftover`) commitados, e `data/` presente. */
function makeRepoWithCommittedFiles(base: string): string {
  const repo = join(base, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "data"));
  writeFileSync(join(repo, "package.json"), "{}\n");
  writeFileSync(join(repo, "README.md"), "# readme\n");
  writeFileSync(join(repo, "scripts", "x.ts"), "export {};\n");
  runGit(base, ["init", "-q", repo]);
  runGit(repo, ["add", "package.json", "README.md", "scripts/x.ts"]);
  runGit(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", "commit", "-qm", "i"]);
  return repo;
}

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout esperando condição");
    await new Promise((r) => setTimeout(r, 200));
  }
}

test("#14335 rescueOrphanDir: copia só o que não está no repo (_internal/, rastreado editado), ignora node_modules, registra link sem seguir", () => {
  const base = mktmp("diaria-wtrm-14335-rescue-");
  const repo = makeRepoWithCommittedFiles(base);
  const { dir, target } = makePartialRemovalLeftover(base, "agent-com-trabalho");
  writeFileSync(join(dir, "README.md"), "# readme\r\n"); // mesmo conteúdo com CRLF (autocrlf): está no repo
  mkdirSync(join(dir, "_internal"));
  writeFileSync(join(dir, "_internal", "notas.json"), '{"trabalho":"não rastreado"}');
  writeFileSync(join(dir, "scripts", "x.ts"), "export const editado = 1;\n");
  symlinkSync(target, join(dir, "data"), "junction");
  const rescueRoot = join(repo, "data", "worktree-rescue");
  const nowMs = Date.UTC(2026, 10, 27);

  const r = rescueOrphanDir(dir, { rescueRoot, blobsPresent: gitReachableBlobs(repo), nowMs });

  assert.ok(r.rescueDir);
  assert.equal(r.reused, false);
  assert.equal(r.copied, 2);
  assert.equal(r.alreadyInRepo, 2, "package.json e README.md (CRLF) já estão no repo");
  assert.equal(r.symlinks, 1);
  assert.match(r.rescueDir!.replace(/\\/g, "/"), /data\/worktree-rescue\/2026-11-27\/agent-com-trabalho$/);
  assert.equal(readFileSync(join(r.rescueDir!, "files", "_internal", "notas.json"), "utf8"), '{"trabalho":"não rastreado"}');
  assert.equal(readFileSync(join(r.rescueDir!, "files", "scripts", "x.ts"), "utf8"), "export const editado = 1;\n");
  assert.equal(existsSync(join(r.rescueDir!, "files", "node_modules")), false, "node_modules fica fora");
  assert.equal(existsSync(join(r.rescueDir!, "files", "package.json")), false);
  const meta = JSON.parse(readFileSync(join(r.rescueDir!, "meta.json"), "utf8"));
  assert.deepEqual(Object.keys(meta.symlinks), ["data"]);
  assert.equal(readFileSync(join(target, "canary.txt"), "utf8"), "conteúdo do alvo da junction", "alvo do link intacto");

  // 2º resgate com o MESMO conteúdo reaproveita o anterior, sem cópia nova.
  const r2 = rescueOrphanDir(dir, { rescueRoot, blobsPresent: gitReachableBlobs(repo), nowMs: nowMs + 86_400_000 });
  assert.equal(r2.reused, true);
  assert.equal(r2.rescueDir, r.rescueDir);
  assert.equal(r2.copied, 0);
  assert.equal(existsSync(`${r.rescueDir}-2`), false);
  // Conteúdo mudou: resgate novo, em `-2`, sem sobrescrever o anterior.
  writeFileSync(join(dir, "_internal", "notas.json"), '{"trabalho":"mudou"}');
  const r3 = rescueOrphanDir(dir, { rescueRoot, blobsPresent: gitReachableBlobs(repo), nowMs });
  assert.equal(r3.reused, false);
  assert.match(r3.rescueDir!.replace(/\\/g, "/"), /agent-com-trabalho-2$/);
  assert.equal(readFileSync(join(r.rescueDir!, "files", "_internal", "notas.json"), "utf8"), '{"trabalho":"não rastreado"}');
  rmSync(base, { recursive: true, force: true });
});

test("#14335 rescueOrphanDir: tudo já no repo -> nenhum diretório de resgate criado", () => {
  const base = mktmp("diaria-wtrm-14335-rescue-nada-");
  const repo = makeRepoWithCommittedFiles(base);
  const dir = join(base, "agent-limpo");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
  writeFileSync(join(dir, "scripts", "x.ts"), "export {};\n");
  const r = rescueOrphanDir(dir, { rescueRoot: join(repo, "data", "worktree-rescue"), blobsPresent: gitReachableBlobs(repo) });
  assert.deepEqual(r, { rescueDir: null, copied: 0, alreadyInRepo: 2, symlinks: 0, reused: false });
  assert.equal(existsSync(join(repo, "data", "worktree-rescue")), false);
  rmSync(base, { recursive: true, force: true });
});

test("#14335 makeOrphanRescuer + cleanupPartialRemovalLeftover: sem data/, acima do teto ou repo inválido -> resgate falha e a pasta fica", () => {
  const base = mktmp("diaria-wtrm-14335-rescue-falha-");
  const repo = makeRepoWithCommittedFiles(base);
  const { dir } = makePartialRemovalLeftover(base, "agent-falha");
  mkdirSync(join(dir, "_internal"));
  writeFileSync(join(dir, "_internal", "a.txt"), "trabalho");

  rmSync(join(repo, "data"), { recursive: true });
  const semData = cleanupPartialRemovalLeftover(dir, { getLiveProcesses: () => [], rescue: makeOrphanRescuer(repo) });
  assert.equal(semData.ok, false);
  assert.match((semData as { error: string }).error, /não existe para guardar o resgate/);
  assert.equal(existsSync(join(dir, "_internal", "a.txt")), true);
  assert.equal(existsSync(join(repo, "data")), false, "nunca cria um data/ de verdade");

  mkdirSync(join(repo, "data"));
  assert.throws(
    () =>
      rescueOrphanDir(dir, {
        rescueRoot: join(repo, "data", "worktree-rescue"),
        blobsPresent: gitReachableBlobs(repo),
        limits: { maxFiles: 0, maxBytes: 1e9 },
      }),
    /teto do resgate/,
  );
  const repoInvalido = cleanupPartialRemovalLeftover(dir, { getLiveProcesses: () => [], rescue: makeOrphanRescuer(join(base, "nao-e-repo")) });
  assert.equal(repoInvalido.ok, false);
  assert.equal(existsSync(join(dir, "_internal", "a.txt")), true);

  const okResult = cleanupPartialRemovalLeftover(dir, { getLiveProcesses: () => [], rescue: makeOrphanRescuer(repo) });
  assert.equal(okResult.ok, true);
  assert.equal(existsSync(dir), false);
  const rescueDir = (okResult as { rescueDir: string }).rescueDir;
  assert.equal(readFileSync(join(rescueDir, "files", "_internal", "a.txt"), "utf8"), "trabalho");
  rmSync(base, { recursive: true, force: true });
});

test("#14335 runMainWithCheckers: resgate da pasta órfã falhou -> não apaga", () => {
  const removed: string[] = [];
  const logs = captureLogs(() =>
    runMainWithCheckers(
      {},
      "/repo",
      baseCheckers({
        findOrphans: () => ["/repo/.claude/worktrees/agent-x"],
        rescueOrphan: () => ({ ok: false, error: "resgate falhou (x), pasta preservada" }),
        removeWorktreeDir: (p) => {
          removed.push(p);
          return { dirRemoved: true, errors: [] };
        },
      }),
    ),
  );
  assert.deepEqual(removed, []);
  assert.ok(logs.some((l) => l.includes("preservada (#14335)") && l.includes("resgate falhou")), logs.join("\n"));
});

test("#14335 runMainWithCheckers: sem rescueOrphan configurado, nenhuma pasta órfã é apagada", () => {
  const removed: string[] = [];
  captureLogs(() =>
    runMainWithCheckers(
      {},
      "/repo",
      baseCheckers({
        findOrphans: () => ["/repo/.claude/worktrees/agent-x"],
        removeWorktreeDir: (p) => {
          removed.push(p);
          return { dirRemoved: true, errors: [] };
        },
      }),
    ),
  );
  assert.deepEqual(removed, []);
});

// ── review de 5 agentes (coordenador) ──

test("#14335 listProcessesStrict: falha ou timeout do PowerShell LANÇA (não vira []); passa o teto de 30 s ao execFileSync", () => {
  const seen: Array<Record<string, unknown>> = [];
  const okOps = {
    platform: "win32",
    selfPid: 3,
    execFileSync: ((_f: string, _a: string[], o: Record<string, unknown>) => {
      seen.push(o);
      return JSON.stringify({ ProcessId: 3, ParentProcessId: 1, CommandLine: "node z" });
    }) as unknown as ListProcessesOps["execFileSync"],
  } as ListProcessesOps;
  assert.deepEqual(listProcessesStrict(okOps), [{ pid: 3, ppid: 1, cmd: "node z" }]);
  assert.equal(seen[0].timeout, WIN32_PROCESS_QUERY_TIMEOUT_MS);
  assert.equal(WIN32_PROCESS_QUERY_TIMEOUT_MS, 30_000);

  const timeoutOps = {
    platform: "win32",
    execFileSync: (() => {
      throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
    }) as unknown as ListProcessesOps["execFileSync"],
  } as ListProcessesOps;
  assert.throws(() => listProcessesStrict(timeoutOps), /ETIMEDOUT/);
  const posixFail = {
    platform: "linux",
    execFileSync: (() => {
      throw new Error("ps quebrado");
    }) as unknown as ListProcessesOps["execFileSync"],
  } as ListProcessesOps;
  assert.throws(() => listProcessesStrict(posixFail), /ps quebrado/);
});

test("#14335 cleanupPartialRemovalLeftover: não conseguir listar processos (timeout) PRESERVA a pasta, sem resgate", () => {
  const base = mktmp("diaria-wtrm-14335-listfail-");
  const { dir } = makePartialRemovalLeftover(base, "agent-sem-lista");
  let rescued = 0;
  const result = cleanupPartialRemovalLeftover(dir, {
    getLiveProcesses: () => {
      throw new Error("spawnSync powershell.exe ETIMEDOUT");
    },
    rescue: () => {
      rescued++;
      return { ok: true, rescueDir: null };
    },
  });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /não deu para listar processos.*ETIMEDOUT/);
  assert.equal(rescued, 0);
  assert.equal(existsSync(join(dir, "package.json")), true);
  rmSync(base, { recursive: true, force: true });
});

test("#14335 runMainWithCheckers: listagem estrita falhou (ou ausente) -> nenhuma pasta órfã é apagada", () => {
  for (const strict of [
    () => {
      throw new Error("powershell ausente");
    },
    undefined,
  ]) {
    const removed: string[] = [];
    const logs = captureLogs(() =>
      runMainWithCheckers(
        {},
        "/repo",
        baseCheckers({
          findOrphans: () => ["/repo/.claude/worktrees/agent-x"],
          listProcessesStrict: strict,
          rescueOrphan: () => ({ ok: true, rescueDir: null }),
          removeWorktreeDir: (p) => {
            removed.push(p);
            return { dirRemoved: true, errors: [] };
          },
        }),
      ),
    );
    assert.deepEqual(removed, []);
    assert.ok(logs.some((l) => l.includes("preservada (#14335)") && /listar|listagem/.test(l)), logs.join("\n"));
  }
});

test("#14335 removeWorktreeSafe ponta a ponta: git apaga o .git e falha -> snapshot NOVO de processos, resgate, rescueDir no resultado", () => {
  const base = mktmp("diaria-wtrm-14335-e2e-");
  const { dir } = makePartialRemovalLeftover(base, "agent-e2e");
  writeFileSync(join(dir, ".git"), "gitdir: /repo/.git/worktrees/agent-e2e\n");
  const run = () => {
    rmSync(join(dir, ".git")); // o git apagou o .git e parou no meio
    return { status: 255, stderr: `error: failed to delete '${dir}': Invalid argument`, stdout: "" };
  };
  const rescued: string[] = [];
  let snapshots = 0;
  const result = removeWorktreeSafe(dir, base, [], {
    run,
    getLiveProcesses: () => {
      snapshots++;
      return [];
    },
    rescue: (p) => {
      rescued.push(p);
      return { ok: true, rescueDir: join(base, "data", "worktree-rescue", "2026-11-28", "agent-e2e") };
    },
  });
  assert.deepEqual(result, {
    ok: true,
    outcome: "partial-cleaned",
    rescueDir: join(base, "data", "worktree-rescue", "2026-11-28", "agent-e2e"),
  });
  assert.equal(snapshots, 1, "snapshot novo depois do git");
  assert.deepEqual(rescued, [dir]);
  assert.equal(existsSync(dir), false);
  assert.match(describeRemovalOutcome(result), /resgate em .*agent-e2e/);
  assert.equal(describeRemovalOutcome({ ok: true, outcome: "removed" }), "");
  rmSync(base, { recursive: true, force: true });
});

test("#14335 removeWorktreeSafe: o snapshot antigo vazio não vale na remoção parcial; o novo vê o processo e preserva", () => {
  const base = mktmp("diaria-wtrm-14335-e2e-live-");
  const { dir } = makePartialRemovalLeftover(base, "agent-e2e-vivo");
  writeFileSync(join(dir, ".git"), "gitdir: x\n");
  const result = removeWorktreeSafe(dir, base, [], {
    run: () => {
      rmSync(join(dir, ".git"));
      return { status: 255, stderr: "Invalid argument", stdout: "" };
    },
    getLiveProcesses: () => [{ pid: 777, ppid: 1, cmd: `node ${dir}/x.js` }],
    rescue: () => ({ ok: true, rescueDir: null }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error!, /PID 777/);
  assert.equal(existsSync(join(dir, "package.json")), true);
  rmSync(base, { recursive: true, force: true });
});

test("#14335 buildRealCheckers: guard antigo com listProcessesForWorktreeGuard; varredura com listProcessesStrict", () => {
  const c = buildRealCheckers("/repo-que-nao-existe");
  assert.equal(c.listProcesses, listProcessesForWorktreeGuard);
  assert.equal(c.listProcessesStrict, listProcessesStrict);
  assert.equal(typeof c.rescueOrphan, "function");
  assert.equal(typeof c.findOrphans, "function");
});

test("#14335 buildExcludedPathKeys/isExcludedPath: 'C:\\...' do join casa 'c:/.../' do git, em qualquer SO", () => {
  const keys = buildExcludedPathKeys(["C:/Users/vjpix/Projects/diaria-studio/.claude/worktrees/agent-a29f/"]);
  assert.equal(isExcludedPath("C:\\Users\\vjpix\\Projects\\diaria-studio\\.claude\\worktrees\\agent-a29f", keys), true);
  assert.equal(isExcludedPath("c:\\users\\VJPIX\\projects\\diaria-studio\\.claude\\worktrees\\agent-a29f", keys), true);
  assert.equal(isExcludedPath("C:\\Users\\vjpix\\Projects\\diaria-studio\\.claude\\worktrees\\agent-a29f0", keys), false);
  const posix = buildExcludedPathKeys(["/home/u/wt/Agent"]);
  assert.equal(isExcludedPath("/home/u/wt/Agent", posix), true);
  assert.equal(isExcludedPath("/home/u/wt/agent", posix), false, "POSIX mantém a caixa");
});

test("#14335 rescueOrphanDir: blob só no object DB (não alcançável por ref) e arquivo vazio são copiados", () => {
  const base = mktmp("diaria-wtrm-14335-reach-");
  const repo = makeRepoWithCommittedFiles(base);
  const dir = join(base, "agent-reach");
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), "{}\n"); // alcançável (commitado)
  writeFileSync(join(dir, "solto.txt"), "só no object DB\n");
  writeFileSync(join(dir, "vazio.txt"), "");
  // `hash-object -w` grava o blob no DB sem nenhuma ref apontando (como o índice de um worktree removido).
  runGit(repo, ["hash-object", "-w", join(dir, "solto.txt")]);
  const r = rescueOrphanDir(dir, { rescueRoot: join(repo, "data", "worktree-rescue"), blobsPresent: gitReachableBlobs(repo) });
  assert.equal(r.copied, 2);
  assert.equal(readFileSync(join(r.rescueDir!, "files", "solto.txt"), "utf8"), "só no object DB\n");
  assert.equal(existsSync(join(r.rescueDir!, "files", "vazio.txt")), true);
  assert.equal(existsSync(join(r.rescueDir!, "files", "package.json")), false);
  rmSync(base, { recursive: true, force: true });
});

test("#14335 resolveWorktreeRemoval: rescueDir do resgate chega ao resultado; cleanupIntegrationBranch loga o destino", () => {
  const base = mktmp("diaria-wtrm-14335-dest-");
  const repo = makeRepoWithCommittedFiles(base);
  const { dir } = makePartialRemovalLeftover(base, "wt-dest");
  mkdirSync(join(dir, "_internal"));
  writeFileSync(join(dir, "_internal", "a.txt"), "trabalho");
  const warnings: string[] = [];
  const runner = {
    exec: (_cmd: string, args: string[]) =>
      args[0] === "worktree" ? { ok: false, stdout: "", stderr: "Invalid argument" } : { ok: true, stdout: "", stderr: "" },
    sleep: async () => {},
    now: () => 0,
    mkTempDir: () => "",
    warn: (m: string) => warnings.push(m),
  } as unknown as TrainRunner;
  const result = cleanupIntegrationBranch(runner, "merge-train/x", dir, repo);
  assert.equal(result.ok, true, warnings.join("\n"));
  assert.equal(existsSync(dir), false);
  const dest = warnings.find((w) => w.includes("remoção parcial") && w.includes("resgate em"));
  assert.ok(dest, warnings.join("\n"));
  const rescueDir = dest!.split("resgate em ")[1];
  assert.equal(readFileSync(join(rescueDir, "files", "_internal", "a.txt"), "utf8"), "trabalho");
  rmSync(base, { recursive: true, force: true });
});

// ── proteção de dado antes do merge (coordenador) ──

test("#14335 listProcessesStrict (Windows): exit 0 com lista vazia ou sem o próprio PID LANÇA", () => {
  const opsWith = (json: string) =>
    ({
      platform: "win32",
      selfPid: 4242,
      execFileSync: (() => json) as unknown as ListProcessesOps["execFileSync"],
    }) as ListProcessesOps;
  assert.throws(() => listProcessesStrict(opsWith("")), /vazia/);
  assert.throws(() => listProcessesStrict(opsWith("[]")), /vazia/);
  assert.throws(
    () => listProcessesStrict(opsWith(JSON.stringify([{ ProcessId: 1, ParentProcessId: 0, CommandLine: "x" }]))),
    /não contém o próprio processo \(PID 4242\)/,
  );
  assert.deepEqual(
    listProcessesStrict(opsWith(JSON.stringify([{ ProcessId: 4242, ParentProcessId: 1, CommandLine: "node" }]))),
    [{ pid: 4242, ppid: 1, cmd: "node" }],
  );
  // O guard antigo segue fail-soft e não faz essa conferência.
  assert.deepEqual(listProcessesForWorktreeGuard(opsWith("[]")), []);
});

test("#14335 rescueOrphanDir: cópia do resgate anterior apagada ou alterada -> não reaproveita, copia de novo", () => {
  const base = mktmp("diaria-wtrm-14335-intact-");
  const repo = makeRepoWithCommittedFiles(base);
  const dir = join(base, "agent-intacto");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "a.txt"), "trabalho A");
  writeFileSync(join(dir, "_internal", "b.txt"), "trabalho B");
  const rescueRoot = join(repo, "data", "worktree-rescue");
  const nowMs = Date.UTC(2026, 10, 28);

  const r1 = rescueOrphanDir(dir, { rescueRoot, blobsPresent: gitReachableBlobs(repo), nowMs });
  assert.equal(r1.reused, false);
  // Cópia alterada depois do resgate.
  writeFileSync(join(r1.rescueDir!, "files", "_internal", "a.txt"), "corrompido");
  const r2 = rescueOrphanDir(dir, { rescueRoot, blobsPresent: gitReachableBlobs(repo), nowMs });
  assert.equal(r2.reused, false);
  assert.notEqual(r2.rescueDir, r1.rescueDir);
  assert.equal(readFileSync(join(r2.rescueDir!, "files", "_internal", "a.txt"), "utf8"), "trabalho A");
  // Cópia apagada.
  rmSync(join(r2.rescueDir!, "files", "_internal", "b.txt"));
  const r3 = rescueOrphanDir(dir, { rescueRoot, blobsPresent: gitReachableBlobs(repo), nowMs });
  assert.equal(r3.reused, false);
  assert.equal(readFileSync(join(r3.rescueDir!, "files", "_internal", "b.txt"), "utf8"), "trabalho B");
  // Íntegra: agora reaproveita.
  const r4 = rescueOrphanDir(dir, { rescueRoot, blobsPresent: gitReachableBlobs(repo), nowMs });
  assert.equal(r4.reused, true);
  assert.equal(r4.rescueDir, r3.rescueDir);
  rmSync(base, { recursive: true, force: true });
});

test("#14335 rescueOrphanDir: meta.json registra in_repo {rel: blob} dos não copiados, e o blob reconstrói o arquivo", () => {
  const base = mktmp("diaria-wtrm-14335-inrepo-");
  const repo = makeRepoWithCommittedFiles(base);
  const dir = join(base, "agent-inrepo");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "_internal"));
  writeFileSync(join(dir, "package.json"), "{}\n");
  writeFileSync(join(dir, "README.md"), "# readme\r\n"); // casa pelo hash LF
  writeFileSync(join(dir, "scripts", "x.ts"), "export {};\n");
  writeFileSync(join(dir, "_internal", "n.txt"), "fora do repo");
  const r = rescueOrphanDir(dir, { rescueRoot: join(repo, "data", "worktree-rescue"), blobsPresent: gitReachableBlobs(repo) });
  const meta = JSON.parse(readFileSync(join(r.rescueDir!, "meta.json"), "utf8"));
  assert.deepEqual(Object.keys(meta.in_repo).sort(), ["README.md", "package.json", "scripts/x.ts"]);
  assert.equal(meta.in_repo["_internal/n.txt"], undefined);
  for (const [rel, sha] of Object.entries(meta.in_repo as Record<string, string>)) {
    assert.match(sha, /^[0-9a-f]{40}$/);
    const content = runGit(repo, ["cat-file", "blob", sha]);
    assert.equal(content, readFileSync(join(dir, rel), "utf8").replace(/\r\n/g, "\n"), rel);
  }
  rmSync(base, { recursive: true, force: true });
});
