/**
 * test/pretooluse-bash-dispatch-14045.test.ts
 *
 * #14045 — os 16 guards de PreToolUse/Bash viraram um despachante único
 * (`.claude/hooks/pretooluse-bash-dispatch.mjs`): um processo `node` por Bash
 * em vez de 16. A regra é que cada guard se comporte como antes: mesma
 * decisão, mesma mensagem, mesmos efeitos (reescrita do comando pelo
 * `inject-session-id.mjs`), mesma composição entre eles e o mesmo fail-open
 * isolado. Este arquivo trava:
 * 1. equivalência: para comandos representativos, a saída do despachante é a
 *    combinação das saídas dos 16 scripts rodados um a um pelo CLI deles;
 * 2. a composição (`combineHookOutputs`), com a semântica do harness;
 * 3. a mecânica (guard que lança, estoura o tempo ou não carrega fica sem
 *    saída sem derrubar os outros; o de processo próprio só spawna quando se
 *    aplica; primeiro deny na ordem vence);
 * 4. o registro no settings.json (só o despachante no grupo Bash, com a lista
 *    completa dos 16).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  GUARDS,
  combineHookOutputs,
  dispatch,
  runGuards,
  type DispatchGuard,
} from "../.claude/hooks/pretooluse-bash-dispatch.mjs";
import { withIsolatedGhConfig } from "./helpers/isolated-gh-config.ts";
import { DISPATCHER_FILE, armedBashPreToolUseGuards, directBashPreToolUseScripts } from "./_helpers/bash-pretooluse-guards.ts";

const ROOT = join(import.meta.dirname, "..");
const HOOKS = join(ROOT, ".claude", "hooks");
const DISPATCHER = join(HOOKS, DISPATCHER_FILE);

/** Os 16 hooks que o settings.json registrava no grupo Bash antes do #14045, na ordem. */
const ORIGINAL_16 = [
  "inject-session-id.mjs",
  "block-gh-pr-merge-subagent.mjs",
  "block-gh-comment-secrets.mjs",
  "block-branch-checkout-main.mjs",
  "block-pr-create-pii-runtime-artifacts.mjs",
  "block-pr-create-tsc-failure.mjs",
  "block-pr-create-orchestrator-snapshot-stale.mjs",
  "block-pr-create-test-runner-import.mjs",
  "block-unsafe-shared-checkout-ops.mjs",
  "block-worktree-bare-push.mjs",
  "block-npm-install-node-modules-symlink.mjs",
  "block-worktree-alien-commit.mjs",
  "block-continuo-master-commit.mjs",
  "block-handwritten-pr-checks-loop.mjs",
  "block-raw-pr-review-comment.mjs",
  "block-bash-protected-path-write.mjs",
];

/** Mesma fórmula de `machineTag()` dos hooks de sessão (nome do arquivo de registro). */
const machineTag = () => (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");

type Decided = { hookSpecificOutput?: { permissionDecision?: string } } | null;

const tmpRoots: string[] = [];
after(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `${prefix}-14045-`));
  tmpRoots.push(d);
  return d;
}

const deny = (reason: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

describe("combineHookOutputs (#14045): a composição que o harness fazia entre hooks", () => {
  it("nenhuma saída, saída vazia ou texto que não é objeto JSON → null", () => {
    assert.equal(combineHookOutputs([]), null);
    assert.equal(combineHookOutputs(["", "  ", "texto solto", "[1]", "null"]), null);
  });

  it("uma saída só volta com o mesmo conteúdo (deny, reescrita, aviso)", () => {
    const outs = [
      { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "x" } },
      { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "a --session-id 's'" } } },
      { systemMessage: "aviso", hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "aviso" } },
      {
        systemMessage: "d1 fora",
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "merge" },
      },
      { systemMessage: "só aviso do D1" },
    ];
    for (const o of outs) assert.deepEqual(combineHookOutputs(["", JSON.stringify(o), ""]), o);
  });

  it("primeiro deny na ordem vence; deny descarta a reescrita do comando", () => {
    const rewrite = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "y" } } });
    assert.deepEqual(combineHookOutputs([rewrite, deny("primeiro"), deny("segundo")]), {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "primeiro" },
    });
  });

  it("deny vence ask, que vence allow, em qualquer posição", () => {
    const ask = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "a" } });
    const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    assert.equal((combineHookOutputs([allow, ask, deny("d")]) as Decided)?.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal((combineHookOutputs([allow, ask]) as Decided)?.hookSpecificOutput?.permissionDecision, "ask");
  });

  it("reescrita sem deny passa adiante; avisos e contextos de todos entram, um por linha", () => {
    const rewrite = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "y" } } });
    const warn = JSON.stringify({ systemMessage: "w1", hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "c1" } });
    const d1 = JSON.stringify({ systemMessage: "w2" });
    assert.deepEqual(combineHookOutputs([rewrite, warn, d1]), {
      systemMessage: "w1\nw2",
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "y" }, additionalContext: "c1" },
    });
  });
});

describe("despachante (#14045): mecânica com guards de teste", () => {
  function fixtureDir(files: Record<string, string>): string {
    const dir = tmp("dispatch-fixture");
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
    return dir;
  }
  const denyGuard = (reason: string) =>
    `export function runHook(data, write) { write(${JSON.stringify(deny(reason))}); }\n`;

  it("guard que lança, que não carrega ou sem runHook fica sem saída; os outros decidem", async () => {
    const dir = fixtureDir({
      "lanca.mjs": `export function runHook() { throw new Error("boom"); }\n`,
      "quebrado.mjs": `export function runHook( {\n`,
      "sem-contrato.mjs": `export const x = 1;\n`,
      "nega.mjs": denyGuard("sobrevivente"),
    });
    const guards: DispatchGuard[] = [
      { file: "lanca.mjs", mode: "in-process", timeoutMs: 1000 },
      { file: "quebrado.mjs", mode: "in-process", timeoutMs: 1000 },
      { file: "sem-contrato.mjs", mode: "in-process", timeoutMs: 1000 },
      { file: "inexistente.mjs", mode: "in-process", timeoutMs: 1000 },
      { file: "nega.mjs", mode: "in-process", timeoutMs: 1000 },
    ];
    const outs = await runGuards("{}", { guards, hooksDir: dir });
    assert.deepEqual(outs.slice(0, 4), ["", "", "", ""]);
    assert.equal(JSON.parse(await dispatch("{}", { guards, hooksDir: dir })).hookSpecificOutput.permissionDecisionReason, "sobrevivente");
  });

  it("guard que passa do teto fica sem saída, mesmo escrevendo depois", async () => {
    const dir = fixtureDir({
      "lento.mjs": `export async function runHook(data, write) { await new Promise((r) => setTimeout(r, 300)); write(${JSON.stringify(deny("tarde"))}); }\n`,
    });
    const guards: DispatchGuard[] = [{ file: "lento.mjs", mode: "in-process", timeoutMs: 50 }];
    assert.deepEqual(await runGuards("{}", { guards, hooksDir: dir }), [""]);
    await new Promise((r) => setTimeout(r, 400));
  });

  it("primeiro deny na ordem de GUARDS vence, com o motivo dele", async () => {
    const dir = fixtureDir({ "a.mjs": denyGuard("A"), "b.mjs": denyGuard("B") });
    const guards: DispatchGuard[] = [
      { file: "a.mjs", mode: "in-process", timeoutMs: 1000 },
      { file: "b.mjs", mode: "in-process", timeoutMs: 1000 },
    ];
    assert.equal(JSON.parse(await dispatch("{}", { guards, hooksDir: dir })).hookSpecificOutput.permissionDecisionReason, "A");
  });

  it("todo guard recebe o stdin cru original (ninguém vê a reescrita de outro)", async () => {
    const dir = fixtureDir({
      "reescreve.mjs": `export function runHook(data, write) { write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "outro" } } })); }\n`,
      "eco.mjs": `export function runHook(data, write) { write(JSON.stringify({ systemMessage: JSON.parse(data).tool_input.command })); }\n`,
    });
    const guards: DispatchGuard[] = [
      { file: "reescreve.mjs", mode: "in-process", timeoutMs: 1000 },
      { file: "eco.mjs", mode: "in-process", timeoutMs: 1000 },
    ];
    const out = JSON.parse(await dispatch(JSON.stringify({ tool_input: { command: "original" } }), { guards, hooksDir: dir }));
    assert.equal(out.systemMessage, "original");
    assert.deepEqual(out.hookSpecificOutput.updatedInput, { command: "outro" });
  });

  it("guard de processo próprio só spawna quando appliesTo é true, e a saída do processo conta", async () => {
    const marker = join(tmp("dispatch-spawn"), "rodou.txt");
    const script = [
      `import { writeFileSync } from "node:fs";`,
      `import { pathToFileURL } from "node:url";`,
      `export function appliesTo(p) { return p.tool_input?.command === "pesado"; }`,
      `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {`,
      `  let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => {`,
      `    writeFileSync(${JSON.stringify(marker)}, d);`,
      `    if (appliesTo(JSON.parse(d))) process.stdout.write(${JSON.stringify(deny("pesado"))});`,
      `  });`,
      `}`,
    ].join("\n");
    const dir = fixtureDir({ "pesado.mjs": script, "lanca-filtro.mjs": `export function appliesTo() { throw new Error("x"); }\n` });
    const guards: DispatchGuard[] = [
      { file: "pesado.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
      { file: "lanca-filtro.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
    ];
    assert.deepEqual(await runGuards(JSON.stringify({ tool_input: { command: "leve" } }), { guards, hooksDir: dir }), ["", ""]);
    assert.equal(existsSync(marker), false, "não se aplica: nenhum processo");
    const out = await dispatch(JSON.stringify({ tool_input: { command: "pesado" } }), { guards, hooksDir: dir });
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, "pesado");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).tool_input.command, "pesado", "o processo recebe o stdin original");
  });

  it("guard de processo próprio que passa do teto é morto e fica sem saída", async () => {
    const script = [
      `import { pathToFileURL } from "node:url";`,
      `export function appliesTo() { return true; }`,
      `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) setTimeout(() => process.stdout.write("{}"), 5000);`,
    ].join("\n");
    const dir = fixtureDir({ "trava.mjs": script });
    const t = Date.now();
    const outs = await runGuards("{}", { guards: [{ file: "trava.mjs", mode: "spawn-if-applies", timeoutMs: 200 }], hooksDir: dir });
    assert.deepEqual(outs, [""]);
    assert.ok(Date.now() - t < 4000, "não esperou o processo travado");
  });
});

describe("despachante (#14045): registro e contrato dos 16 guards reais", () => {
  it("GUARDS é exatamente a lista antiga, na mesma ordem", () => {
    assert.deepEqual(GUARDS.map((g) => g.file), ORIGINAL_16);
  });

  it("settings.json: o grupo Bash registra só o despachante, com teto acima do maior guard", () => {
    assert.deepEqual(directBashPreToolUseScripts(), [DISPATCHER_FILE]);
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"));
    const group = settings.hooks.PreToolUse.find((g: { matcher: string }) => g.matcher === "Bash");
    const maxGuardS = Math.max(...GUARDS.map((g) => g.timeoutMs)) / 1000;
    assert.ok(group.hooks[0].timeout > maxGuardS, `timeout ${group.hooks[0].timeout}s precisa passar de ${maxGuardS}s`);
    assert.deepEqual(armedBashPreToolUseGuards().slice(1), ORIGINAL_16);
  });

  it("cada guard exporta a função que o modo dele exige", async () => {
    for (const g of GUARDS) {
      const mod = await import(pathToFileURL(join(HOOKS, g.file)).href);
      const fn = g.mode === "in-process" ? "runHook" : "appliesTo";
      assert.equal(typeof mod[fn], "function", `${g.file} precisa exportar ${fn}`);
    }
  });
});

describe("despachante (#14045): equivalência com os 16 scripts rodados um a um", () => {
  // Raiz git temporária com data/sessions/: o guard de merge e o de checkout
  // leem as coordenadoras dela (cwd do comando), e o run-log vai pra ela.
  function makeRoot(withCoordinator: boolean): string {
    const root = tmp("dispatch-equiv");
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
    if (withCoordinator) {
      writeFileSync(
        join(root, "data", "sessions", `overnight-${machineTag()}-coord-14045.json`),
        JSON.stringify({ kind: "overnight", sessionId: "coord-14045", machineTag: machineTag(), lastHeartbeat: new Date().toISOString() }),
        "utf8",
      );
    }
    return root;
  }
  const env = () => ({ ...withIsolatedGhConfig(), CLAUDE_PROJECT_DIR: ROOT, DIARIA_D1_LOCKS: "0" });

  function runScript(script: string, root: string, input: string): string {
    const r = spawnSync(process.execPath, [script], { cwd: root, input, encoding: "utf8", timeout: 120_000, env: env(), windowsHide: true });
    assert.equal(r.status, 0, `${script} saiu ${r.status}: ${r.stderr}`);
    return r.stdout ?? "";
  }

  const CASES: Array<{ name: string; command: string; coordinator?: boolean; expect: "nada" | "deny" | "reescrita" }> = [
    { name: "comando comum", command: "git status --short", expect: "nada" },
    { name: "taskkill por imagem", command: "taskkill /IM node.exe /F", expect: "deny" },
    { name: "injeção de --session-id", command: "npx tsx scripts/lib/session-registry.ts claim-issue --issue 1", expect: "reescrita" },
    { name: "session-registry encadeado", command: "npx tsx scripts/lib/session-registry.ts claim-issue --issue 1 | head", expect: "deny" },
    { name: "escrita em caminho protegido", command: "echo x > .claude/settings.json", expect: "deny" },
    { name: "comentário de review cru", command: "gh api repos/o/r/pulls/1/comments -f body=x", expect: "deny" },
    { name: "laço de gh pr checks à mão", command: "while true; do gh pr checks 1; sleep 30; done", expect: "deny" },
    { name: "--body-file de nome genérico", command: "gh issue comment 1 --body-file body.md", expect: "deny" },
    { name: "dois guards negam: o primeiro vence", command: "taskkill /IM node.exe && echo x > .claude/settings.json", expect: "deny" },
    { name: "gh pr merge com coordenadora ativa", command: "gh pr merge 123 --squash", coordinator: true, expect: "deny" },
    { name: "gh pr merge sem rodada ativa", command: "gh pr merge 123 --squash", expect: "nada" },
    { name: "git checkout -b no checkout principal com rodada ativa", command: "git checkout -b x", coordinator: true, expect: "deny" },
    { name: "gh pr create (guards de processo próprio)", command: "gh pr create --title t --body b", expect: "deny" },
  ];

  for (const c of CASES) {
    it(`${c.name}: mesma saída`, () => {
      const root = makeRoot(c.coordinator === true);
      const input = JSON.stringify({
        session_id: "caller-14045",
        cwd: root,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: c.command },
      });
      const individual = ORIGINAL_16.map((f) => runScript(join(HOOKS, f), root, input));
      const expected = combineHookOutputs(individual);
      const actualRaw = runScript(DISPATCHER, root, input);
      const actual = actualRaw === "" ? null : JSON.parse(actualRaw);
      assert.deepEqual(actual, expected);
      const decision = expected?.hookSpecificOutput as Record<string, unknown> | undefined;
      if (c.expect === "nada") assert.equal(decision?.permissionDecision, undefined);
      if (c.expect === "deny") assert.equal(decision?.permissionDecision, "deny");
      if (c.expect === "reescrita") {
        assert.match(String((decision?.updatedInput as { command?: string })?.command), /--session-id 'caller-14045'/);
      }
    });
  }

  it("JSON inválido no stdin: sem saída e exit 0 (fail-open, como cada guard)", () => {
    const root = makeRoot(false);
    assert.equal(runScript(DISPATCHER, root, "não é json"), "");
  });
});
