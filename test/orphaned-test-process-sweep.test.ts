/**
 * test/orphaned-test-process-sweep.test.ts (#8661)
 *
 * Regressão (#633) pra `scripts/lib/orphaned-test-process-sweep.ts` — item 1
 * pendente do #7753 ("rede de segurança: varrer processos órfãos cujo
 * cmdline aponte pro worktree corrente e matá-los"). Reproduz o cmdline
 * REAL capturado ao vivo na issue #8661: 2 processos node
 * `--test-isolation=process`, PPID=1, referenciando um worktree
 * (`.claude/worktrees/agent-a5beef84385775a4a`) que não existe mais no
 * disco — e confirma que a detecção nunca falso-positiva em processos que
 * não são o padrão exato do vazamento.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPathTokens,
  looksLikeIsolatedTestProcess,
  findOrphanedTestProcesses,
  stillMatchesOrphanSignature,
} from "../scripts/lib/orphaned-test-process-sweep.ts";
import type { ProcessInfo } from "../scripts/lib/list-processes.ts";

// ── extractPathTokens ──

test("extractPathTokens: extrai tokens POSIX absolutos, ignora flags e args relativos", () => {
  const cmd =
    "node --require /home/x/.claude/worktrees/agent-a5beef84385775a4a/node_modules/tsx/dist/preflight.cjs " +
    "--import /home/x/.claude/worktrees/agent-a5beef84385775a4a/node_modules/tsx/dist/loader.mjs " +
    "--test test/session-registry.test.ts";
  const tokens = extractPathTokens(cmd);
  assert.deepEqual(tokens, [
    "/home/x/.claude/worktrees/agent-a5beef84385775a4a/node_modules/tsx/dist/preflight.cjs",
    "/home/x/.claude/worktrees/agent-a5beef84385775a4a/node_modules/tsx/dist/loader.mjs",
  ]);
});

test("extractPathTokens: extrai path Windows (C:\\...) também", () => {
  const tokens = extractPathTokens("node --require C:\\Users\\vjpix\\wt-1\\node_modules\\tsx\\preflight.cjs --test");
  assert.deepEqual(tokens, ["C:\\Users\\vjpix\\wt-1\\node_modules\\tsx\\preflight.cjs"]);
});

test("extractPathTokens: [] quando não há nenhum token absoluto", () => {
  assert.deepEqual(extractPathTokens("node --test-isolation=process --test test/foo.test.ts"), []);
});

test("extractPathTokens: extrai o path embutido em --flag=/path (delimitado por '='), não o argumento inteiro", () => {
  const cmd = "node --experimental-addon-modules --test-isolation=process --import=/a/b/loader.mjs test/x.test.ts";
  assert.deepEqual(extractPathTokens(cmd), ["/a/b/loader.mjs"]);
});

// ── looksLikeIsolatedTestProcess ──

test("looksLikeIsolatedTestProcess: true só quando a cmdline tem --test-isolation=process", () => {
  assert.equal(
    looksLikeIsolatedTestProcess("node --experimental-addon-modules --test-isolation=process --test test/x.test.ts"),
    true,
  );
  assert.equal(looksLikeIsolatedTestProcess("node --test test/x.test.ts"), false, "sem --test-isolation=process não conta");
  assert.equal(
    looksLikeIsolatedTestProcess("node server.js"),
    false,
    "processo comum, sem nenhuma menção ao runner de teste",
  );
});

// ── findOrphanedTestProcesses ──

test("findOrphanedTestProcesses: acha o padrão exato da issue #8661 — 2 netos PPID=1 de worktree removido", () => {
  const removedWorktree = "/home/vjpixel/diaria-studio/.claude/worktrees/agent-a5beef84385775a4a";
  const processes: ProcessInfo[] = [
    {
      pid: 2987022,
      ppid: 1,
      cmd:
        `node --require ${removedWorktree}/node_modules/tsx/dist/preflight.cjs ` +
        "--import file:///usr/lib/node_modules/tsx/dist/loader.mjs --test test/session-registry.test.ts",
    },
    {
      pid: 2987028,
      ppid: 1,
      cmd:
        "node --experimental-addon-modules --test-coverage-lines=0 --test-isolation=process " +
        `--import=${removedWorktree}/node_modules/tsx/dist/loader.mjs test/session-registry.test.ts`,
    },
  ];
  // #8661: o cmdline real citado na issue tem o `preflight.cjs` sem
  // `--test-isolation=process` explícito no PRIMEIRO processo (o pai já
  // morto) — só o processo 2 (o neto de fato, PPID=1) precisa bater o
  // padrão; o teste cobre os dois pra deixar claro que o 1º é ignorado por
  // não ter a flag, não por engano de matching.
  const existsFn = (p: string) => !p.startsWith(removedWorktree);

  const orphans = findOrphanedTestProcesses(processes, existsFn);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].pid, 2987028);
  assert.equal(orphans[0].missingPath.startsWith(removedWorktree), true);
});

test("findOrphanedTestProcesses: nunca casa processo --test-isolation=process cujo path AINDA existe (worktree vivo)", () => {
  const liveWorktree = "/home/x/.claude/worktrees/agent-alive";
  const processes: ProcessInfo[] = [
    {
      pid: 111,
      ppid: 1,
      cmd: `node --experimental-addon-modules --test-isolation=process --import=${liveWorktree}/node_modules/tsx/loader.mjs --test test/x.test.ts`,
    },
  ];
  const existsFn = () => true; // tudo existe — worktree ainda vivo
  assert.deepEqual(findOrphanedTestProcesses(processes, existsFn), []);
});

test("findOrphanedTestProcesses: nunca casa processo comum (sem --test-isolation=process) mesmo com path ausente na cmdline", () => {
  const processes: ProcessInfo[] = [
    { pid: 222, ppid: 1, cmd: "node /home/x/some/deleted/script.js --forever" },
  ];
  const existsFn = () => false; // path "ausente" de propósito — não deveria importar aqui
  assert.deepEqual(
    findOrphanedTestProcesses(processes, existsFn),
    [],
    "sem --test/--test-isolation=process, não é o padrão do vazamento — nunca mata processo genérico",
  );
});

test("findOrphanedTestProcesses: [] em lista vazia", () => {
  assert.deepEqual(findOrphanedTestProcesses([], () => false), []);
});

test("findOrphanedTestProcesses: nunca casa processo --test-isolation=process com path ausente MAS ppid !== 1 (ainda filho de um processo vivo)", () => {
  // #8661 (fleet review PR #8692, type-design-analyzer): PPID=1 é o sinal
  // definidor de órfão (reparentado pro init). Sem essa checagem, um
  // processo genuinamente vivo — ainda filho de um `node --test` normal —
  // cujo cmdline por acaso referencia um path momentaneamente ausente
  // (race de rename/recriação de worktree) seria matado por engano.
  const removedWorktree = "/home/x/.claude/worktrees/agent-nao-tao-removido-assim";
  const processes: ProcessInfo[] = [
    {
      pid: 777,
      ppid: 54321, // ainda filho de um processo vivo — NÃO reparentado pro init
      cmd: `node --experimental-addon-modules --test-isolation=process --import=${removedWorktree}/node_modules/tsx/loader.mjs test/x.test.ts`,
    },
  ];
  const existsFn = (p: string) => !p.startsWith(removedWorktree);

  assert.deepEqual(
    findOrphanedTestProcesses(processes, existsFn),
    [],
    "ppid !== 1 nunca é órfão, mesmo batendo os outros 2 sinais (--test-isolation=process + path ausente)",
  );
});

// ── stillMatchesOrphanSignature (#8661 — reverificação anti-race de PID reuse) ──

test("stillMatchesOrphanSignature: false quando o processo já não existe mais (current === null)", () => {
  assert.equal(stillMatchesOrphanSignature(null, "/a/b/c"), false);
});

test("stillMatchesOrphanSignature: false quando o PID foi reciclado — cmdline atual não bate o padrão", () => {
  // Cenário do achado CRÍTICO: o PID original morreu, o SO reciclou pra um
  // processo completamente não-relacionado (aqui, um systemd unit comum).
  const reused: ProcessInfo = { pid: 999, ppid: 1, cmd: "/usr/lib/systemd/systemd-something --daemon" };
  assert.equal(stillMatchesOrphanSignature(reused, "/home/x/.claude/worktrees/agent-old"), false);
});

test("stillMatchesOrphanSignature: false quando o PID foi reciclado pra um processo com ppid !== 1", () => {
  const reused: ProcessInfo = {
    pid: 999,
    ppid: 4242, // já não é mais órfão — reciclado pra filho de outro processo vivo
    cmd: "node --test-isolation=process --import=/home/x/.claude/worktrees/agent-old/loader.mjs test/x.test.ts",
  };
  assert.equal(stillMatchesOrphanSignature(reused, "/home/x/.claude/worktrees/agent-old"), false);
});

test("stillMatchesOrphanSignature: false quando o cmdline atual não referencia mais o mesmo path esperado", () => {
  const reused: ProcessInfo = {
    pid: 999,
    ppid: 1,
    cmd: "node --test-isolation=process --import=/home/x/OUTRO/worktree/completamente-diferente/loader.mjs test/y.test.ts",
  };
  assert.equal(stillMatchesOrphanSignature(reused, "/home/x/.claude/worktrees/agent-old"), false);
});

test("stillMatchesOrphanSignature: true quando o processo ainda bate os 3 sinais (mesmo PID, ainda órfão de verdade)", () => {
  const stillOrphaned: ProcessInfo = {
    pid: 999,
    ppid: 1,
    cmd: "node --experimental-addon-modules --test-isolation=process --import=/home/x/.claude/worktrees/agent-old/node_modules/tsx/loader.mjs test/x.test.ts",
  };
  assert.equal(stillMatchesOrphanSignature(stillOrphaned, "/home/x/.claude/worktrees/agent-old"), true);
});
