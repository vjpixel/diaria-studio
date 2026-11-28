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
  FILTER_TOTAL_TIMEOUT_MS,
  GUARDS,
  STARTUP_MARGIN_MS,
  killProcessTree,
  worstCaseMs,
  combineHookOutputs,
  dispatch,
  runGuards,
  type DispatchGuard,
} from "../.claude/hooks/pretooluse-bash-dispatch.mjs";
import { withIsolatedGhConfig } from "./_helpers/isolated-gh-config.ts";
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

/** Guards que entraram no despachante depois do #14045, no fim da lista. */
const ADDED_AFTER_14045 = ["block-pr-create-preflight.mjs"]; // #14216
const CURRENT_GUARDS = [...ORIGINAL_16, ...ADDED_AFTER_14045];

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
      { file: "lanca.mjs", mode: "worker", timeoutMs: 1000 },
      { file: "quebrado.mjs", mode: "worker", timeoutMs: 1000 },
      { file: "sem-contrato.mjs", mode: "worker", timeoutMs: 1000 },
      { file: "inexistente.mjs", mode: "worker", timeoutMs: 1000 },
      { file: "nega.mjs", mode: "worker", timeoutMs: 1000 },
    ];
    const run = await runGuards("{}", { guards, hooksDir: dir });
    assert.deepEqual(run.outputs.slice(0, 4), ["", "", "", ""]);
    const out = JSON.parse(await dispatch("{}", { guards, hooksDir: dir }));
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, "sobrevivente");
    // P2 do review: a falha de cada um aparece no systemMessage, não só no stderr.
    for (const f of ["lanca.mjs", "quebrado.mjs", "sem-contrato.mjs", "inexistente.mjs"]) {
      assert.match(out.systemMessage, new RegExp(`${f.replace(".", "\\.")} .*guard sem decisão`));
    }
  });

  it("falha de guard sem deny de ninguém: systemMessage visível, sem decisão", async () => {
    const dir = fixtureDir({ "lanca.mjs": `export function runHook() { throw new Error("boom"); }\n` });
    const out = JSON.parse(await dispatch("{}", { guards: [{ file: "lanca.mjs", mode: "worker", timeoutMs: 1000 }], hooksDir: dir }));
    assert.match(out.systemMessage, /lanca\.mjs lançou: boom/);
    assert.equal(out.hookSpecificOutput, undefined);
  });

  it("guard que passa do teto fica sem saída, mesmo escrevendo depois", async () => {
    const dir = fixtureDir({
      "lento.mjs": `export async function runHook(data, write) { await new Promise((r) => setTimeout(r, 300)); write(${JSON.stringify(deny("tarde"))}); }\n`,
    });
    const guards: DispatchGuard[] = [{ file: "lento.mjs", mode: "worker", timeoutMs: 50 }];
    const run = await runGuards("{}", { guards, hooksDir: dir });
    assert.deepEqual(run.outputs, [""]);
    assert.match(run.notices.join("\n"), /lento\.mjs passou de 50 ms/);
    await new Promise((r) => setTimeout(r, 400));
  });

  // P1 do review da PR #14107: guard SÍNCRONO travado não pode zerar os outros.
  const busyGuard = `export function runHook() { for (;;) {} }\n`;

  it("P1: guard síncrono travado ANTES do que nega: o deny sai no teto do travado, não no do grupo", async () => {
    const dir = fixtureDir({ "trava.mjs": busyGuard, "nega.mjs": denyGuard("nega") });
    const guards: DispatchGuard[] = [
      { file: "trava.mjs", mode: "worker", timeoutMs: 500 },
      { file: "nega.mjs", mode: "worker", timeoutMs: 10_000 },
    ];
    const t = Date.now();
    const out = JSON.parse(await dispatch("{}", { guards, hooksDir: dir }));
    const elapsed = Date.now() - t;
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, "nega");
    assert.match(out.systemMessage, /trava\.mjs passou de 500 ms/);
    assert.ok(elapsed < 5000, `deny saiu em ${elapsed} ms`);
  });

  it("P1: deny ANTES do travado sai na hora, sem esperar o teto do travado", async () => {
    const dir = fixtureDir({ "nega.mjs": denyGuard("nega"), "trava.mjs": busyGuard });
    const guards: DispatchGuard[] = [
      { file: "nega.mjs", mode: "worker", timeoutMs: 10_000 },
      { file: "trava.mjs", mode: "worker", timeoutMs: 60_000 },
    ];
    const t = Date.now();
    const run = await runGuards("{}", { guards, hooksDir: dir });
    const elapsed = Date.now() - t;
    assert.equal(run.early, true);
    const combined = combineHookOutputs(run.outputs) as { hookSpecificOutput: { permissionDecisionReason: string } };
    assert.equal(combined.hookSpecificOutput.permissionDecisionReason, "nega");
    assert.ok(elapsed < 5000, `deny saiu em ${elapsed} ms (teto do travado: 60 s)`);
  });

  it("P1: deny antecipado respeita a ordem: com um anterior pendente, espera ele (que pode negar primeiro)", async () => {
    const dir = fixtureDir({
      "nega-tarde.mjs": `export async function runHook(d, write) { await new Promise((r) => setTimeout(r, 300)); write(${JSON.stringify(deny("primeiro"))}); }\n`,
      "nega-cedo.mjs": denyGuard("segundo"),
    });
    const guards: DispatchGuard[] = [
      { file: "nega-tarde.mjs", mode: "worker", timeoutMs: 5000 },
      { file: "nega-cedo.mjs", mode: "worker", timeoutMs: 5000 },
    ];
    assert.equal(JSON.parse(await dispatch("{}", { guards, hooksDir: dir })).hookSpecificOutput.permissionDecisionReason, "primeiro");
  });

  it("P1: guard de processo próprio preso num execFileSync de sleep é morto no teto e o deny sai", async () => {
    const script = [
      `import { execFileSync } from "node:child_process";`,
      `import { pathToFileURL } from "node:url";`,
      `export function appliesTo() { return true; }`,
      `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {`,
      `  execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { windowsHide: true });`,
      `}`,
    ].join("\n");
    const dir = fixtureDir({ "dorme.mjs": script, "nega.mjs": denyGuard("nega") });
    const guards: DispatchGuard[] = [
      { file: "dorme.mjs", mode: "spawn-if-applies", timeoutMs: 800 },
      { file: "nega.mjs", mode: "worker", timeoutMs: 10_000 },
    ];
    const t = Date.now();
    const out = JSON.parse(await dispatch("{}", { guards, hooksDir: dir }));
    const elapsed = Date.now() - t;
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, "nega");
    assert.match(out.systemMessage, /dorme\.mjs passou de 800 ms/);
    assert.ok(elapsed < 6000, `deny saiu em ${elapsed} ms`);
  });

  it("P2: os guards correm em paralelo, então o tempo do grupo é o maior teto, não a soma", async () => {
    const dir = fixtureDir({ "a.mjs": busyGuard, "b.mjs": busyGuard, "c.mjs": busyGuard });
    const guards: DispatchGuard[] = ["a.mjs", "b.mjs", "c.mjs"].map((file) => ({ file, mode: "worker", timeoutMs: 700 }));
    const sum = guards.reduce((s, g) => s + g.timeoutMs, 0);
    const t = Date.now();
    const run = await runGuards("{}", { guards, hooksDir: dir });
    const elapsed = Date.now() - t;
    assert.equal(run.notices.length, 3);
    assert.ok(elapsed < sum, `${elapsed} ms precisa ficar abaixo da soma dos tetos (${sum} ms)`);
  });

  it("P3: filtro que lança é registrado; com onFilterError run o guard roda por precaução", async () => {
    const marker = join(tmp("dispatch-filter"), "rodou.txt");
    const runs = (name: string) =>
      [
        `import { writeFileSync } from "node:fs";`,
        `import { pathToFileURL } from "node:url";`,
        `export function appliesTo() { throw new Error("filtro quebrado"); }`,
        `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeFileSync(${JSON.stringify(marker)} + "${name}", "x");`,
      ].join("\n");
    const dir = fixtureDir({ "roda.mjs": runs("roda"), "pula.mjs": runs("pula") });
    const guards: DispatchGuard[] = [
      { file: "roda.mjs", mode: "spawn-if-applies", timeoutMs: 10_000, onFilterError: "run" },
      { file: "pula.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
    ];
    const out = JSON.parse(await dispatch("{}", { guards, hooksDir: dir }));
    assert.equal(existsSync(marker + "roda"), true, "onFilterError run: rodou");
    assert.equal(existsSync(marker + "pula"), false, "padrão: não rodou");
    assert.match(out.systemMessage, /roda\.mjs filtro lançou \(filtro quebrado\), guard rodado por precaução/);
    assert.match(out.systemMessage, /pula\.mjs filtro lançou \(filtro quebrado\);/);
  });

  it("P3: o guard de PII e o de merge rodam por precaução quando o filtro lança", () => {
    const failClosed = GUARDS.filter((g) => g.onFilterError === "run").map((g) => g.file);
    assert.deepEqual(failClosed, ["block-gh-pr-merge-subagent.mjs", "block-pr-create-pii-runtime-artifacts.mjs"]);
  });

  it("primeiro deny na ordem de GUARDS vence, com o motivo dele", async () => {
    const dir = fixtureDir({ "a.mjs": denyGuard("A"), "b.mjs": denyGuard("B") });
    const guards: DispatchGuard[] = [
      { file: "a.mjs", mode: "worker", timeoutMs: 1000 },
      { file: "b.mjs", mode: "worker", timeoutMs: 1000 },
    ];
    assert.equal(JSON.parse(await dispatch("{}", { guards, hooksDir: dir })).hookSpecificOutput.permissionDecisionReason, "A");
  });

  it("todo guard recebe o stdin cru original (ninguém vê a reescrita de outro)", async () => {
    const dir = fixtureDir({
      "reescreve.mjs": `export function runHook(data, write) { write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "outro" } } })); }\n`,
      "eco.mjs": `export function runHook(data, write) { write(JSON.stringify({ systemMessage: JSON.parse(data).tool_input.command })); }\n`,
    });
    const guards: DispatchGuard[] = [
      { file: "reescreve.mjs", mode: "worker", timeoutMs: 1000 },
      { file: "eco.mjs", mode: "worker", timeoutMs: 1000 },
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
    const leve = await runGuards(JSON.stringify({ tool_input: { command: "leve" } }), { guards, hooksDir: dir });
    assert.deepEqual(leve.outputs, ["", ""]);
    assert.equal(existsSync(marker), false, "não se aplica: CLI não executado");
    assert.match(leve.notices.join("\n"), /lanca-filtro\.mjs filtro lançou/, "filtro que lança é registrado");
    const out = await dispatch(JSON.stringify({ tool_input: { command: "pesado" } }), { guards, hooksDir: dir });
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, "pesado");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).tool_input.command, "pesado", "o processo recebe o stdin original");
  });

  for (const [name, source] of [
    ["appliesTo síncrono", "export function appliesTo() { while (true) {} }"],
    ["import síncrono", "while (true) {}"],
    ["import assíncrono", "setInterval(() => {}, 1000); await new Promise(() => {});"],
  ]) {
    it(`#14302: ${name} travado não impede outro guard de negar`, () => {
      const dir = fixtureDir({ "filtro.mjs": source, "nega.mjs": denyGuard("deny preservado") });
      const output = dispatchIsolated(dir, [
        { file: "filtro.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
        { file: "nega.mjs", mode: "worker", timeoutMs: 3000 },
      ]);
      assert.equal(output.hookSpecificOutput.permissionDecisionReason, "deny preservado");
      assert.match(output.systemMessage, /filtro\.mjs filtro não decidiu em 700 ms;/);
    });
  }

  /** CLI que nega com `reason` (e grava `marker`, se dado) quando roda como processo próprio. */
  const cliDeny = (reason: string, appliesTo: string, marker?: string) =>
    [
      `import { writeFileSync } from "node:fs";`,
      `import { pathToFileURL } from "node:url";`,
      appliesTo,
      `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {`,
      marker ? `  writeFileSync(${JSON.stringify(marker)}, "x");` : "",
      `  process.stdout.write(${JSON.stringify(deny(reason))});`,
      `}`,
    ].join("\n");

  /**
   * Roda o despachante num processo externo com teto (a regressão antiga não
   * pode travar a suíte), com passo de filtro de 700 ms.
   */
  function dispatchIsolated(dir: string, guards: DispatchGuard[]) {
    const runner = join(dir, "runner.mjs");
    writeFileSync(runner, `
      import { dispatch } from ${JSON.stringify(pathToFileURL(DISPATCHER).href)};
      const out = await dispatch("{}", { hooksDir: ${JSON.stringify(dir)}, guards: ${JSON.stringify(guards)}, filterStepMs: 700, filterTotalMs: 3000 });
      process.stdout.write(out);
    `);
    const result = spawnSync(process.execPath, [runner], { encoding: "utf8", timeout: 8000, windowsHide: true });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  it("#14302: filtro em laço de guard onFilterError run vira deny (o CLI roda por precaução)", () => {
    const marker = join(tmp("dispatch-filter-run"), "rodou.txt");
    const dir = fixtureDir({ "merge.mjs": cliDeny("merge negado", "export function appliesTo() { while (true) {} }", marker) });
    const output = dispatchIsolated(dir, [{ file: "merge.mjs", mode: "spawn-if-applies", timeoutMs: 10_000, onFilterError: "run" }]);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(output.hookSpecificOutput.permissionDecisionReason, "merge negado");
    assert.equal(existsSync(marker), true, "o CLI do guard fail-closed rodou");
    assert.match(output.systemMessage, /merge\.mjs filtro não decidiu em 700 ms, guard rodado por precaução/);
  });

  it("#14302: filtro travado não derruba os filtros seguintes (Worker nova para o resto)", () => {
    const dir = fixtureDir({
      "trava.mjs": "export function appliesTo() { while (true) {} }",
      "depois.mjs": cliDeny("depois negou", "export function appliesTo() { return true; }"),
    });
    const output = dispatchIsolated(dir, [
      { file: "trava.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
      { file: "depois.mjs", mode: "spawn-if-applies", timeoutMs: 10_000 },
    ]);
    assert.equal(output.hookSpecificOutput.permissionDecisionReason, "depois negou");
    assert.match(output.systemMessage, /trava\.mjs filtro não decidiu em 700 ms;/);
  });

  it("guard de processo próprio que passa do teto é morto e fica sem saída", async () => {
    const marker = join(tmp("dispatch-cli-timeout"), "cli-rodou.txt");
    const script = [
      `import { writeFileSync } from "node:fs";`,
      `import { pathToFileURL } from "node:url";`,
      `export function appliesTo() { return true; }`,
      `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {`,
      `  writeFileSync(${JSON.stringify(marker)}, "x");`,
      `  setTimeout(() => process.stdout.write("{}"), 8000);`,
      `}`,
    ].join("\n");
    const dir = fixtureDir({ "trava.mjs": script });
    const t = Date.now();
    const run = await runGuards("{}", { guards: [{ file: "trava.mjs", mode: "spawn-if-applies", timeoutMs: 1500 }], hooksDir: dir });
    assert.deepEqual(run.outputs, [""]);
    assert.equal(existsSync(marker), true, "o CLI chegou a rodar: o teto pegou o CLI, não o filtro");
    assert.match(run.notices.join("\n"), /trava\.mjs passou de 1500 ms/);
    assert.ok(Date.now() - t < 6000, "não esperou o processo travado");
  });
});

describe("despachante (#14045): registro e contrato dos 16 guards reais", () => {
  it("GUARDS é exatamente a lista antiga, na mesma ordem (guard novo só no fim)", () => {
    assert.deepEqual(GUARDS.map((g) => g.file), CURRENT_GUARDS);
  });

  it("settings.json: o grupo Bash registra só o despachante", () => {
    assert.deepEqual(directBashPreToolUseScripts(), [DISPATCHER_FILE]);
    assert.deepEqual(armedBashPreToolUseGuards().slice(1), CURRENT_GUARDS);
  });

  it("P2: o teto do grupo no settings.json cobre o pior caso (cadeia em série = soma; aqui cada guard é um elo só)", () => {
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"));
    const groupMs = settings.hooks.PreToolUse.find((g: { matcher: string }) => g.matcher === "Bash").hooks[0].timeout * 1000;
    // Nenhum guard espera outro: a cadeia em série mais longa tem um guard só,
    // e a soma dela é o maior teto individual. Mais a folga de partida.
    // Cada elo é a fase de filtros (#14302) seguida do CLI do guard.
    const longestSerialChainMs = FILTER_TOTAL_TIMEOUT_MS + Math.max(...GUARDS.map((g) => g.timeoutMs));
    assert.equal(worstCaseMs(), longestSerialChainMs + STARTUP_MARGIN_MS);
    assert.ok(groupMs >= worstCaseMs(), `teto do grupo ${groupMs} ms < pior caso ${worstCaseMs()} ms`);
    // Referência: em série (o modelo antigo de dentro do despachante) seria a soma.
    const sumMs = GUARDS.reduce((s, g) => s + g.timeoutMs, 0);
    assert.ok(sumMs > groupMs, "se algum dia os guards voltarem a rodar em série, este teto não cobre: revisar");
  });

  it("P1: os guards que leem data/sessions rodam em processo próprio (morto no teto), nunca numa Worker", () => {
    const dataReaders = [
      "block-gh-pr-merge-subagent.mjs",
      "block-branch-checkout-main.mjs",
      "block-unsafe-shared-checkout-ops.mjs",
      "block-worktree-alien-commit.mjs",
    ];
    for (const f of dataReaders) assert.equal(GUARDS.find((g) => g.file === f)?.mode, "spawn-if-applies", f);
  });

  it("cada guard exporta a função que o modo dele exige", async () => {
    for (const g of GUARDS) {
      const mod = await import(pathToFileURL(join(HOOKS, g.file)).href);
      const fn = g.mode === "worker" ? "runHook" : "appliesTo";
      assert.equal(typeof mod[fn], "function", `${g.file} precisa exportar ${fn}`);    }
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
      const individual = CURRENT_GUARDS.map((f) => runScript(join(HOOKS, f), root, input));
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

  it("JSON inválido no stdin: sem decisão, exit 0, com aviso visível (P2 do review)", () => {
    const root = makeRoot(false);
    const out = JSON.parse(runScript(DISPATCHER, root, "não é json"));
    assert.equal(out.hookSpecificOutput, undefined);
    assert.match(out.systemMessage, /stdin não é JSON/);
  });
});

describe("despachante (#14045): re-review da PR #14107", () => {
  function fixtureDir(files: Record<string, string>): string {
    const dir = tmp("dispatch-rereview");
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
    return dir;
  }
  const denyGuard = (reason: string) => `export function runHook(data, write) { write(${JSON.stringify(deny(reason))}); }\n`;
  const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: "Bash", tool_input: { command }, ...extra });

  it("1: Worker presa numa chamada nativa (execFileSync) + outro guard negando: o deny sai no teto da presa", async () => {
    const stuck = `import { execFileSync } from "node:child_process";\nexport function runHook() { execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { windowsHide: true }); }\n`;
    const dir = fixtureDir({ "presa.mjs": stuck, "nega.mjs": denyGuard("nega") });
    const guards: DispatchGuard[] = [
      { file: "presa.mjs", mode: "worker", timeoutMs: 400 },
      { file: "nega.mjs", mode: "worker", timeoutMs: 10_000 },
    ];
    const t = Date.now();
    const out = JSON.parse(await dispatch("{}", { guards, hooksDir: dir }));
    const elapsed = Date.now() - t;
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, "nega");
    assert.match(out.systemMessage, /presa\.mjs passou de 400 ms/);
    assert.ok(elapsed < 2500, `deny saiu em ${elapsed} ms (a chamada presa dura 3 s)`);
  });

  it("1: por isso só guard puro roda em Worker: os de worker não importam node:fs nem node:child_process", () => {
    const workers = GUARDS.filter((g) => g.mode === "worker").map((g) => g.file);
    assert.deepEqual(workers, ["inject-session-id.mjs", "block-handwritten-pr-checks-loop.mjs", "block-raw-pr-review-comment.mjs"]);
    for (const f of workers) {
      const src = readFileSync(join(HOOKS, f), "utf8");
      assert.doesNotMatch(src, /from\s+["']node:(?:fs|child_process)["']/, `${f} toca disco/processo: precisa de spawn-if-applies`);
    }
  });

  it("2: appliesTo do checkout tira a continuação de linha antes do regex (git che\\<newline>ckout -b x)", async () => {
    const { appliesTo } = await import(pathToFileURL(join(HOOKS, "block-branch-checkout-main.mjs")).href);
    assert.equal(appliesTo(bash("git che\\\nckout -b x")), true);
    assert.equal(appliesTo(bash("git che\\\r\nckout -b x")), true);
    assert.equal(appliesTo(bash("git sw'it'ch -c x")), true);
    assert.equal(appliesTo(bash("git status --short")), false);
  });

  it("filtros novos: aplicam no que o guard olharia, não no Bash comum", async () => {
    const load = async (f: string) => (await import(pathToFileURL(join(HOOKS, f)).href)).appliesTo as (p: unknown, e?: unknown) => boolean;
    const secrets = await load("block-gh-comment-secrets.mjs");
    assert.equal(secrets(bash("gh issue comment 1 --body-file body.md")), true);
    assert.equal(secrets(bash("gh pr create --title t --body b")), true);
    assert.equal(secrets(bash("git status")), false);
    const npm = await load("block-npm-install-node-modules-symlink.mjs");
    assert.equal(npm(bash("npm ci", { cwd: ROOT })), true);
    assert.equal(npm(bash("git status", { cwd: ROOT })), false);
    const bare = await load("block-worktree-bare-push.mjs");
    assert.equal(bare(bash("git push")), true);
    assert.equal(bare(bash("git status")), false);
    const continuo = await load("block-continuo-master-commit.mjs");
    assert.equal(continuo(bash("git commit -m x", { cwd: ROOT }), { DIARIA_SESSION_KIND: "continuo" }), true);
    assert.equal(continuo(bash("git commit -m x", { cwd: ROOT }), {}), false);
    const prot = await load("block-bash-protected-path-write.mjs");
    assert.equal(prot(bash("echo x > .claude/settings.json")), true);
    assert.equal(prot(bash("python /tmp/fix-14045.py")), true, "script que o guard leria: aplica");
    assert.equal(prot(bash("ls -la")), false);
  });

  it("3: killProcessTree mata a árvore (taskkill /T /F no win32, grupo no POSIX)", () => {
    const child = { pid: 4242, exitCode: null, signalCode: null, kill: () => true };
    const calls: unknown[][] = [];
    killProcessTree(child, { platform: "win32", spawnFn: (cmd, args) => (calls.push([cmd, ...args]), {}) });
    assert.deepEqual(calls, [["taskkill", "/T", "/F", "/PID", "4242"]]);
    const kills: unknown[][] = [];
    killProcessTree(child, { platform: "linux", killFn: (pid, sig) => kills.push([pid, sig]) });
    assert.deepEqual(kills, [[-4242, "SIGKILL"]]);
    const done: unknown[][] = [];
    killProcessTree({ ...child, exitCode: 0 }, { platform: "linux", killFn: (pid, sig) => done.push([pid, sig]) });
    assert.deepEqual(done, [], "processo que já saiu não é morto de novo");
  });

  it("3: no teto, o neto do guard (tsc/teste) morre junto, sem órfão", async () => {
    const marker = join(tmp("dispatch-tree"), "neto-vivo.txt");
    const grandchild = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 1500)`;
    const script = [
      `import { spawn } from "node:child_process";`,
      `import { pathToFileURL } from "node:url";`,
      `export function appliesTo() { return true; }`,
      `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {`,
      `  spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore", windowsHide: true });`,
      `  setTimeout(() => {}, 30000);`,
      `}`,
    ].join("\n");
    const dir = fixtureDir({ "pai.mjs": script });
    await runGuards("{}", { guards: [{ file: "pai.mjs", mode: "spawn-if-applies", timeoutMs: 600 }], hooksDir: dir });
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(existsSync(marker), false, "o neto sobreviveu ao teto do guard");
  });

  it("4: falha do inject-session-id vai também no additionalContext", async () => {
    const dir = fixtureDir({ "inject.mjs": `export function runHook() { for (;;) {} }\n` });
    const out = JSON.parse(
      await dispatch("{}", { guards: [{ file: "inject.mjs", mode: "worker", timeoutMs: 300, failureAsContext: true }], hooksDir: dir }),
    );
    assert.match(out.systemMessage, /inject\.mjs passou de 300 ms/);
    assert.match(out.hookSpecificOutput.additionalContext, /inject\.mjs passou de 300 ms/);
    assert.equal(GUARDS.find((g) => g.file === "inject-session-id.mjs")?.failureAsContext, true);
  });
});
