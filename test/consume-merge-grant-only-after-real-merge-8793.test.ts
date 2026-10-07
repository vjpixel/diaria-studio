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
 * quente é `.claude/hooks/consume-merge-grant-on-merge.mjs`, e ele tinha dois
 * buracos que produzem exatamente esse sintoma:
 *
 *   1. Confiava 100% no filtro `if: "Bash(gh pr merge*)"` do settings. Fora
 *      dele, `extractGhPrMergeTargetPr` devolve `undefined` para um comando
 *      SEM `gh pr merge`, e `undefined` casa com qualquer concessão — o
 *      PostToolUse do próprio `check-merge-grant` queimava a janela.
 *   2. `PostToolUse` dispara no exit 0 do comando inteiro: `gh pr merge N |
 *      tail` com merge recusado consumia a janela, e o retry era bloqueado.
 *
 * Registro sempre em diretório temporário — nunca `data/sessions/` real.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { grantMergeWindow, machineTag, registerSession, sessionsDir } from "../scripts/lib/session-registry.ts";
import {
  decideConsumeAfterBash,
  isGhPrMergeCommand,
  mergeEvidentlyDidNotHappen,
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

function runCli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX, CLI, ...args], { cwd: root, encoding: "utf8", timeout: 30_000 });
}

function runHook(root: string, sessionId: string, command: string) {
  return spawnSync(process.execPath, [CONSUME_HOOK], {
    cwd: root,
    input: JSON.stringify({ session_id: sessionId, tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    timeout: 15_000,
  });
}

function setupGrant(root: string): void {
  registerSession(root, "overnight", "coord-8793", { tag: TAG });
  const r = grantMergeWindow(root, "overnight", "coord-8793", "benef-8793", { pr: 8785, tag: TAG });
  assert.ok(r, "grant-merge deveria ter concedido");
  assert.equal(grantOf(root).consumedAt, undefined);
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

  it("o PostToolUse de check-merge-grant/merge-lock-acquire NÃO consome a janela (falhava antes do fix)", () => {
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

  it("o gh pr merge do PR exato consome (gh sem remote nesse repo temporário → fail-open consumindo)", () => {
    const root = makeRoot();
    setupGrant(root);
    const r = runHook(root, "benef-8793", "gh pr merge 8785 --squash --delete-branch");
    assert.equal(r.status, 0);
    assert.ok(grantOf(root).consumedAt, "o merge deveria ter carimbado consumedAt");
  });

  it("gh pr merge de OUTRO PR ou de OUTRA sessão não consome", () => {
    const root = makeRoot();
    setupGrant(root);
    runHook(root, "benef-8793", "gh pr merge 9999 --squash");
    runHook(root, "outra-sessao", "gh pr merge 8785 --squash");
    assert.equal(grantOf(root).consumedAt, undefined);
  });
});

describe("#8793 — decideConsumeAfterBash", () => {
  const fakeGh = (json: unknown) => {
    const calls: string[][] = [];
    const fn = (_bin: string, args: string[]) => {
      calls.push(args);
      return JSON.stringify(json);
    };
    return { fn, calls };
  };

  it("comando sem gh pr merge real → nunca consome, nem consulta o gh", () => {
    const gh = fakeGh({ state: "MERGED" });
    for (const cmd of ["npx tsx x.ts check-merge-grant", "gh pr view 1", 'gh issue comment 1 --body "gh pr merge 1"', undefined]) {
      assert.equal(decideConsumeAfterBash(cmd, { execFn: gh.fn }).consume, false);
    }
    assert.equal(gh.calls.length, 0);
  });

  it("sem concessão viva candidata → não consulta o gh (coordenadora mergeando sem grant)", () => {
    const gh = fakeGh({ state: "OPEN" });
    const d = decideConsumeAfterBash("gh pr merge 5 --squash", { hasLiveGrant: () => false, execFn: gh.fn });
    assert.equal(d.consume, false);
    assert.equal(gh.calls.length, 0);
  });

  it("merge recusado mascarado por pipe (PR segue OPEN sem auto-merge) → não consome", () => {
    const gh = fakeGh({ state: "OPEN", autoMergeRequest: null });
    const d = decideConsumeAfterBash("gh pr merge 8785 --squash 2>&1 | tail -5", { execFn: gh.fn });
    assert.deepEqual(d, { consume: false, targetPr: 8785, reason: "merge-did-not-happen" });
    assert.deepEqual(gh.calls[0], ["pr", "view", "8785", "--json", "state,autoMergeRequest"]);
  });

  it("MERGED, ou OPEN com --auto enfileirado → consome", () => {
    assert.equal(decideConsumeAfterBash("gh pr merge 1 --squash", { execFn: fakeGh({ state: "MERGED" }).fn }).consume, true);
    const auto = fakeGh({ state: "OPEN", autoMergeRequest: { enabledAt: "x" } });
    assert.equal(decideConsumeAfterBash("gh pr merge 1 --auto --squash", { execFn: auto.fn }).consume, true);
  });

  it("CLOSED → não consome", () => {
    assert.equal(mergeEvidentlyDidNotHappen(1, fakeGh({ state: "CLOSED" }).fn), true);
  });

  it("gh falhando ou JSON ilegível → fail-open consumindo (comportamento pré-#8793)", () => {
    const boom = () => {
      throw new Error("offline");
    };
    assert.equal(decideConsumeAfterBash("gh pr merge 1", { execFn: boom }).consume, true);
    assert.equal(decideConsumeAfterBash("gh pr merge 1", { execFn: () => "not json" }).consume, true);
  });

  it("PR indeterminado (gh pr merge sem número) → consome sem consultar o gh (#8188)", () => {
    const gh = fakeGh({ state: "OPEN" });
    const d = decideConsumeAfterBash("gh pr merge --squash", { execFn: gh.fn });
    assert.equal(d.consume, true);
    assert.equal(d.targetPr, undefined);
    assert.equal(gh.calls.length, 0);
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
