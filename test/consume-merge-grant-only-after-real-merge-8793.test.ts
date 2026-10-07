/**
 * test/consume-merge-grant-only-after-real-merge-8793.test.ts (#8793)
 *
 * Relato da issue (edição 260925, PR #8785): grant-merge → check-merge-grant
 * (`granted: true`) → merge-lock-acquire → `gh pr merge` BLOQUEADO pelo guard
 * do #5716 com "concessão já consumida", sem nenhum `consume-merge-grant` à
 * mão no caminho.
 *
 * Re-auditoria: `check-merge-grant` e `merge-lock-acquire` não escrevem
 * `consumedAt` (travado abaixo pelo CLI real). O único escritor no caminho
 * quente é `.claude/hooks/consume-merge-grant-on-merge.mjs`. HIPÓTESE (não
 * provada — não há snapshot de `data/sessions/` da máquina de 260925): o
 * hook tinha dois caminhos que produzem exatamente esse sintoma:
 *
 *   1. Confiava 100% no filtro `if: "Bash(gh pr merge*)"` do settings. Fora
 *      dele, `extractGhPrMergeTargetPr` devolve `undefined` para um comando
 *      SEM `gh pr merge`, e `undefined` casa com qualquer concessão — o
 *      PostToolUse do próprio `check-merge-grant` queimaria a janela.
 *   2. `PostToolUse` dispara no exit 0 do comando inteiro: `gh pr merge N |
 *      tail` com merge recusado consumia a janela, e o retry era bloqueado.
 *
 * Registro sempre em diretório temporário — nunca `data/sessions/` real.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { grantMergeWindow, machineTag, registerSession, sessionsDir } from "../scripts/lib/session-registry.ts";
import {
  decideConsumeAfterBash,
  isGhPrMergeCommand,
  resolveMergeState,
  // @ts-expect-error -- hook .mjs sem tipos
} from "../.claude/hooks/consume-merge-grant-on-merge.mjs";
// @ts-expect-error -- hook .mjs sem tipos
import { isGhPrMergeCommand as GUARD_isGhPrMergeCommand } from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";

const CLI = fileURLToPath(new URL("../scripts/lib/session-registry.ts", import.meta.url));
const TSX = pathToFileURL(fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))).href;
const CONSUME_HOOK = fileURLToPath(new URL("../.claude/hooks/consume-merge-grant-on-merge.mjs", import.meta.url));
const TAG = machineTag();

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "grant-8793-"));
  roots.push(root);
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  // Marcador do fallback validado do resolveRepoRoot (#7699) + git real pro
  // caminho principal: o CLI e o hook resolvem a raiz pelo cwd.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "diaria-studio" }));
  spawnSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function coordFile(root: string): string {
  const name = readdirSync(sessionsDir(root)).find((n) => n.startsWith("overnight-") && n.endsWith(".json"));
  assert.ok(name, "registro da coordenadora deveria existir");
  return join(sessionsDir(root), name);
}

function grantOf(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(coordFile(root), "utf8")).merge_grant;
}

function runLog(root: string): Array<{ level: string; message: string; details: Record<string, unknown> }> {
  const path = join(root, "data", "run-log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function runCli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX, CLI, ...args], { cwd: root, encoding: "utf8", timeout: 30_000 });
}

function runHook(root: string, sessionId: string, command: string, extraEnv: Record<string, string> = {}, binDir?: string) {
  // Sem GH_REPO/GH_HOST: a consulta do hook precisa falhar no repo temporário
  // sem remote (ou cair no gh falso), nunca consultar um PR real por herança.
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  delete env.GH_REPO;
  delete env.GH_HOST;
  if (binDir) {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = `${binDir}${delimiter}${env[pathKey] ?? ""}`;
  }
  return spawnSync(process.execPath, [CONSUME_HOOK], {
    cwd: root,
    env,
    input: JSON.stringify({ session_id: sessionId, tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    timeout: 15_000,
  });
}

function setupGrant(root: string, pr: number | null = 8785): void {
  registerSession(root, "overnight", "coord-8793", { tag: TAG });
  const r = grantMergeWindow(root, "overnight", "coord-8793", "benef-8793", { ...(pr !== null ? { pr } : {}), tag: TAG });
  assert.ok(r, "grant-merge deveria ter concedido");
  assert.equal(grantOf(root).consumedAt, undefined);
}

/**
 * `gh` falso no PATH, que imprime `{"state": $FAKE_GH_STATE}` (o recorte
 * `.data.repository.pullRequest` que o hook pede via `-q`) e registra cada
 * chamada em `$FAKE_GH_CALLS`.
 *
 * POSIX: script `gh` executável. Windows: um `gh.cmd` NÃO serve — o hook usa
 * `execFileSync("gh")` sem shell, e no Windows a busca no PATH sem shell só
 * acha `.exe`/`.com` (e o Node recusa `.cmd` sem shell desde o fix do
 * CVE-2024-27980). Então o `gh.exe` falso é uma cópia do próprio `node.exe`
 * e o comportamento vem de `NODE_OPTIONS=--import`, que
 * só age quando o executável se chama `gh` (o hook, que também é node, segue
 * normal).
 */
function makeFakeGh(): { binDir: string; env: (state: string, callsFile: string) => Record<string, string> } {
  const binDir = mkdtempSync(join(tmpdir(), "fake-gh-8793-"));
  roots.push(binDir);
  const script = join(binDir, "fake-gh.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      'import { basename } from "node:path";',
      'if (/^gh(\\.exe)?$/i.test(basename(process.execPath)) || process.env.FAKE_GH_DIRECT === "1") {',
      '  appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(process.argv.slice(process.env.FAKE_GH_DIRECT === "1" ? 2 : 1)) + "\\n");',
      '  process.stdout.write(JSON.stringify({ state: process.env.FAKE_GH_STATE, autoMergeRequest: null, mergeQueueEntry: null }));',
      "  process.exit(0);",
      "}",
    ].join("\n"),
    "utf8",
  );
  if (process.platform === "win32") {
    // Cópia, não hardlink: um hardlink pro node.exe que está RODANDO esta
    // suíte não pode ser apagado no Windows (EPERM na limpeza do diretório).
    copyFileSync(process.execPath, join(binDir, "gh.exe"));
    return {
      binDir,
      env: (state, callsFile) => ({
        FAKE_GH_STATE: state,
        FAKE_GH_CALLS: callsFile,
        NODE_OPTIONS: `--import=${pathToFileURL(script).href}`,
      }),
    };
  }
  const sh = join(binDir, "gh");
  writeFileSync(sh, `#!/bin/sh\nFAKE_GH_DIRECT=1 exec "${process.execPath}" "${script}" "$@"\n`, "utf8");
  chmodSync(sh, 0o755);
  return { binDir, env: (state, callsFile) => ({ FAKE_GH_STATE: state, FAKE_GH_CALLS: callsFile }) };
}

describe("#8793 — sequência da issue com o CLI real", () => {
  it("check-merge-grant e merge-lock-acquire não tocam o registro da coordenadora", () => {
    const root = makeRoot();
    setupGrant(root);
    const before = readFileSync(coordFile(root), "utf8");

    const check = runCli(root, "check-merge-grant", "--session-id", "benef-8793");
    assert.equal(check.status, 0, check.stderr);
    const parsed = JSON.parse(check.stdout.trim().split("\n").pop() ?? "{}");
    assert.equal(parsed.granted, true);
    assert.equal(parsed.grant.consumedAt, undefined);

    const lock = runCli(root, "merge-lock-acquire", "--session-id", "benef-8793");
    assert.equal(lock.status, 0, lock.stderr);
    assert.match(lock.stdout, /merge-lock-acquire ok/);

    assert.equal(readFileSync(coordFile(root), "utf8"), before, "registro da coordenadora mudou byte a byte");
    assert.ok(existsSync(join(sessionsDir(root), ".merge-lock.json")), "o lock vive em arquivo próprio");
  });

  it("o PostToolUse de check-merge-grant/merge-lock-acquire NÃO consome a janela (falharia sem o filtro do settings)", () => {
    const root = makeRoot();
    setupGrant(root);
    for (const command of [
      "npx tsx scripts/lib/session-registry.ts check-merge-grant --session-id benef-8793",
      "npx tsx scripts/lib/session-registry.ts merge-lock-acquire --pr 8785 --session-id benef-8793",
      'echo "depois: gh pr merge 8785 --squash"',
      "gh pr view 8785 --json state",
    ]) {
      const r = runHook(root, "benef-8793", command);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), "");
      assert.equal(grantOf(root).consumedAt, undefined, `consumido por: ${command}`);
    }
  });

  it("o gh pr merge do PR exato consome quando o GitHub está inacessível (fail-open) e loga a falha", () => {
    const root = makeRoot();
    setupGrant(root);
    const r = runHook(root, "benef-8793", "gh pr merge 8785 --squash --delete-branch");
    assert.equal(r.status, 0);
    assert.ok(grantOf(root).consumedAt, "o merge deveria ter carimbado consumedAt");
    const warn = runLog(root).find((e) => e.message === "merge_state_check_failed");
    assert.ok(warn, "falha da consulta deveria ir pro run-log");
    assert.equal(warn.level, "warn");
    assert.equal(warn.details.pr, 8785);
  });

  it("gh pr merge de OUTRO PR ou de OUTRA sessão não consome", () => {
    const root = makeRoot();
    setupGrant(root);
    runHook(root, "benef-8793", "gh pr merge 9999 --squash");
    runHook(root, "outra-sessao", "gh pr merge 8785 --squash");
    assert.equal(grantOf(root).consumedAt, undefined);
  });
});

describe("#8793 — E2E com gh falso no PATH", () => {
  const fake = makeFakeGh();

  it("concessão escopada + PR ainda OPEN (merge recusado via pipe) → NÃO consome e loga merge_grant_kept", () => {
    const root = makeRoot();
    setupGrant(root);
    const calls = join(root, "gh-calls.jsonl");
    const r = runHook(root, "benef-8793", "gh pr merge 8785 --squash 2>&1 | tail -5", fake.env("OPEN", calls), fake.binDir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(calls), "o gh falso deveria ter sido chamado");
    assert.equal(grantOf(root).consumedAt, undefined);
    const kept = runLog(root).find((e) => e.message === "merge_grant_kept");
    assert.deepEqual(kept?.details, { pr: 8785, state: "OPEN", reason: "merge-not-happened" });
  });

  it("concessão escopada + PR MERGED → consome", () => {
    const root = makeRoot();
    setupGrant(root);
    const calls = join(root, "gh-calls.jsonl");
    const r = runHook(root, "benef-8793", "gh pr merge 8785 --squash", fake.env("MERGED", calls), fake.binDir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(calls), "o gh falso deveria ter sido chamado");
    assert.ok(grantOf(root).consumedAt);
  });

  it("concessão GENÉRICA (sem --pr) + PR OPEN → consome como antes, sem consultar o gh", () => {
    const root = makeRoot();
    setupGrant(root, null);
    const calls = join(root, "gh-calls.jsonl");
    const r = runHook(root, "benef-8793", "gh pr merge 8785 --squash | tail -5", fake.env("OPEN", calls), fake.binDir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(calls), false, "concessão genérica não paga consulta");
    assert.ok(grantOf(root).consumedAt);
  });
});

describe("#8793 — decideConsumeAfterBash", () => {
  const fakeGh = (pr: unknown) => {
    const calls: string[][] = [];
    const fn = (_bin: string, args: string[]) => {
      calls.push(args);
      return JSON.stringify(pr);
    };
    return { fn, calls };
  };
  const scoped = (pr: number) => () => ({ pr });

  it("findLiveGrant é obrigatório", () => {
    assert.throws(() => decideConsumeAfterBash("gh pr merge 1", {} as never), TypeError);
  });

  it("comando sem gh pr merge real → nunca consome, nem consulta o gh", () => {
    const gh = fakeGh({ state: "MERGED" });
    for (const cmd of ["npx tsx x.ts check-merge-grant", "gh pr view 1", 'gh issue comment 1 --body "gh pr merge 1"', undefined]) {
      const d = decideConsumeAfterBash(cmd, { findLiveGrant: scoped(1), execFn: gh.fn });
      assert.deepEqual([d.consume, d.reason], [false, "not-a-merge-command"]);
    }
    assert.equal(gh.calls.length, 0);
  });

  it("sem concessão viva candidata → não consulta o gh (coordenadora mergeando sem grant)", () => {
    const gh = fakeGh({ state: "OPEN" });
    const d = decideConsumeAfterBash("gh pr merge 5 --squash", { findLiveGrant: () => null, execFn: gh.fn });
    assert.deepEqual([d.consume, d.reason], [false, "no-live-grant"]);
    assert.equal(gh.calls.length, 0);
  });

  it("escopada + merge recusado mascarado por pipe (OPEN sem auto-merge) → não consome e loga", () => {
    const gh = fakeGh({ state: "OPEN", autoMergeRequest: null, mergeQueueEntry: null });
    const logs: unknown[][] = [];
    const d = decideConsumeAfterBash("gh pr merge 8785 --squash 2>&1 | tail -5", {
      findLiveGrant: scoped(8785),
      execFn: gh.fn,
      log: (...a: unknown[]) => logs.push(a),
    });
    assert.deepEqual(d, { consume: false, targetPr: 8785, reason: "merge-not-happened" });
    assert.deepEqual(logs, [["info", "merge_grant_kept", { pr: 8785, state: "OPEN", reason: "merge-not-happened" }]]);
    assert.equal(gh.calls[0][0], "api");
    assert.ok(gh.calls[0].includes("number=8785"));
  });

  it("escopada + CLOSED → não consome", () => {
    const d = decideConsumeAfterBash("gh pr merge 1", { findLiveGrant: scoped(1), execFn: fakeGh({ state: "CLOSED" }).fn });
    assert.deepEqual([d.consume, d.reason], [false, "merge-not-happened"]);
  });

  it("concessão genérica (grant.pr ausente) → consome sem consultar, mesmo com PR OPEN", () => {
    const gh = fakeGh({ state: "OPEN" });
    const d = decideConsumeAfterBash("gh pr merge 8785 | tail", { findLiveGrant: () => ({}), execFn: gh.fn });
    assert.deepEqual([d.consume, d.reason], [true, "generic-grant"]);
    assert.equal(gh.calls.length, 0);
  });

  it("MERGED → merged; OPEN com autoMergeRequest ou mergeQueueEntry → auto-merge-queued", () => {
    const cases: Array<[unknown, string]> = [
      [{ state: "MERGED" }, "merged"],
      [{ state: "OPEN", autoMergeRequest: { enabledAt: "x" }, mergeQueueEntry: null }, "auto-merge-queued"],
      [{ state: "OPEN", autoMergeRequest: null, mergeQueueEntry: { id: "MQE_1" } }, "auto-merge-queued"],
    ];
    for (const [pr, reason] of cases) {
      const d = decideConsumeAfterBash("gh pr merge 1 --squash", { findLiveGrant: scoped(1), execFn: fakeGh(pr).fn });
      assert.deepEqual([d.consume, d.reason], [true, reason], JSON.stringify(pr));
    }
  });

  it("gh falhando, JSON ilegível ou resposta inesperada → unverified-fail-open, com warn no log", () => {
    const boom = () => {
      throw Object.assign(new Error("offline"), { code: "ETIMEDOUT" });
    };
    for (const [execFn, code] of [
      [boom, "ETIMEDOUT"],
      [() => "not json", "JSON_PARSE"],
      [() => "null", "UNEXPECTED_RESPONSE"],
    ] as const) {
      const logs: unknown[][] = [];
      const d = decideConsumeAfterBash("gh pr merge 1", { findLiveGrant: scoped(1), execFn, log: (...a: unknown[]) => logs.push(a) });
      assert.deepEqual([d.consume, d.reason], [true, "unverified-fail-open"]);
      assert.deepEqual(logs, [["warn", "merge_state_check_failed", { pr: 1, code }]]);
    }
  });

  it("PR indeterminado (gh pr merge sem número) → pr-undetermined, consome sem consultar (limitação conhecida)", () => {
    const gh = fakeGh({ state: "OPEN" });
    const d = decideConsumeAfterBash("gh pr merge --squash | tail", { findLiveGrant: () => ({ pr: 1 }), execFn: gh.fn });
    assert.deepEqual(d, { consume: true, targetPr: undefined, reason: "pr-undetermined" });
    assert.equal(gh.calls.length, 0);
  });
});

describe("#8793 — resolveMergeState", () => {
  it("devolve os 4 estados", () => {
    const st = (pr: unknown) => resolveMergeState(1, () => JSON.stringify(pr)).state;
    assert.equal(st({ state: "MERGED" }), "merged");
    assert.equal(st({ state: "OPEN", mergeQueueEntry: { id: "x" } }), "auto-queued");
    assert.equal(st({ state: "OPEN" }), "not-merged");
    assert.equal(resolveMergeState(undefined, () => "{}").state, "unknown");
  });
});

describe("#8793 — isGhPrMergeCommand duplicado concorda com o guard", () => {
  const samples = [
    "gh pr merge 1 --squash",
    "cd wt && gh pr merge 2",
    "npx tsx scripts/lib/session-registry.ts check-merge-grant",
    'gh pr comment 3 --body "rode gh pr merge 3"',
    "echo ok\ngh pr merge 4",
    "gh pr merge-x",
    undefined,
  ];
  for (const s of samples) {
    it(JSON.stringify(s), () => {
      assert.equal(isGhPrMergeCommand(s), GUARD_isGhPrMergeCommand(s));
    });
  }
});
