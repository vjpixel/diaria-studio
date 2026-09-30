/**
 * #9222 (num_turns/terminal_reason/usage_capture_error persistidos em
 * stage-status.json) + #9223 (polling negado rotulado no failureTail e
 * proibido na diretiva headless).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEditionStages,
  countDeniedPolling,
  NO_BACKGROUND_DIRECTIVE,
  STAGE_PLAN,
} from "../scripts/lib/edition-stage-runner.ts";
import { parseCliRunMeta } from "../scripts/lib/cli-usage-json.ts";

const AAMMDD = "261001";

function setup() {
  const tmpRepo = mkdtempSync(join(tmpdir(), "9222-"));
  const editionDir = join(tmpRepo, "editions", AAMMDD);
  mkdirSync(editionDir, { recursive: true });
  return { tmpRepo, editionDir };
}

function readRow(editionDir: string, stage: number) {
  const doc = JSON.parse(readFileSync(join(editionDir, "_internal", "stage-status.json"), "utf8"));
  return doc.rows.find((r: { stage: number }) => r.stage === stage);
}

/** Sentinela ausente antes do spawn e presente depois (stage conclui). */
function completesAfterSpawn() {
  let n = 0;
  return ((_d: string, _s: number) =>
    n++ === 0 ? { ok: false, reason: "sentinel_missing" } : { ok: true }) as never;
}
const neverCompletes = ((_d: string, _s: number) => ({ ok: false, reason: "sentinel_missing" })) as never;

const MAX_TURNS_ENVELOPE = JSON.stringify({
  type: "result",
  subtype: "error_max_turns",
  num_turns: 121,
  total_cost_usd: 7.75,
  usage: { input_tokens: 10, output_tokens: 5 },
  permission_denials: [
    ...Array.from({ length: 4 }, () => ({ tool_name: "Bash", tool_input: { command: "sleep 20" } })),
    { tool_name: "Bash", tool_input: { command: "while [ ! -f x ]; do sleep 20; done" } },
    { tool_name: "Bash", tool_input: { command: "tasklist | findstr node" } },
    { tool_name: "Write", tool_input: { file_path: "/x" } },
  ],
  result: "subagents still running",
});

function run(editionDir: string, tmpRepo: string, execFn: unknown, assertSentinelFn: never) {
  return runEditionStages({
    aammdd: AAMMDD,
    editionDir,
    repoRootAbs: tmpRepo,
    resolveClaudeBin: () => "echo",
    env: {},
    plan: STAGE_PLAN.slice(1, 2), // Stage 2
    execFn: execFn as never,
    assertSentinelFn,
  });
}

describe("#9222 parseCliRunMeta", () => {
  it("extrai num_turns e subtype != success", () => {
    assert.deepEqual(parseCliRunMeta(MAX_TURNS_ENVELOPE), { numTurns: 121, terminalReason: "error_max_turns" });
  });
  it("success não gera terminalReason; terminal_reason tem precedência sobre subtype", () => {
    assert.deepEqual(parseCliRunMeta(JSON.stringify({ subtype: "success", num_turns: 40 })), { numTurns: 40 });
    assert.equal(
      parseCliRunMeta(JSON.stringify({ subtype: "error_x", terminal_reason: "max_turns" }))?.terminalReason,
      "max_turns",
    );
  });
  it("não-JSON → null", () => {
    assert.equal(parseCliRunMeta("texto"), null);
  });
});

describe("#9222 persistência em stage-status.json", () => {
  it("sucesso grava num_turns junto com custo, sem terminal_reason nem usage_capture_error", () => {
    const { tmpRepo, editionDir } = setup();
    const r = run(
      editionDir,
      tmpRepo,
      () =>
        JSON.stringify({
          subtype: "success",
          num_turns: 57,
          total_cost_usd: 1.5,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      completesAfterSpawn(),
    );
    assert.equal(r.exitCode, 0);
    const row = readRow(editionDir, 2);
    assert.equal(row.num_turns, 57);
    assert.equal(row.cost_usd, 1.5);
    assert.equal(row.terminal_reason, undefined);
    assert.equal(row.usage_capture_error, undefined);
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("cenário 261001: exit 0 sem sentinela + error_max_turns → num_turns/terminal_reason/custo persistidos e polling rotulado", () => {
    const { tmpRepo, editionDir } = setup();
    const r = run(editionDir, tmpRepo, () => MAX_TURNS_ENVELOPE, neverCompletes);
    assert.equal(r.exitCode, 1);
    const row = readRow(editionDir, 2);
    assert.equal(row.num_turns, 121);
    assert.equal(row.terminal_reason, "error_max_turns");
    assert.equal(row.cost_usd, 7.75);
    assert.match(r.outcomes[0].failureTail ?? "", /polling negado ×6 \(#9223/);
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("exit != 0 com envelope em err.stdout também persiste", () => {
    const { tmpRepo, editionDir } = setup();
    run(
      editionDir,
      tmpRepo,
      () => {
        throw Object.assign(new Error("exit 1"), { status: 1, stdout: MAX_TURNS_ENVELOPE, stderr: "" });
      },
      neverCompletes,
    );
    const row = readRow(editionDir, 2);
    assert.equal(row.num_turns, 121);
    assert.equal(row.terminal_reason, "error_max_turns");
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("falha de captura fica persistida em usage_capture_error (não só onProgress)", () => {
    const { tmpRepo, editionDir } = setup();
    run(editionDir, tmpRepo, () => "texto puro", completesAfterSpawn());
    const row = readRow(editionDir, 2);
    assert.match(row.usage_capture_error ?? "", /não parseou/);
    rmSync(tmpRepo, { recursive: true, force: true });
  });
});

describe("#9223 polling negado", () => {
  it("countDeniedPolling conta só Bash de espera", () => {
    assert.equal(countDeniedPolling(MAX_TURNS_ENVELOPE), 6);
    assert.equal(countDeniedPolling("não json"), 0);
    assert.equal(
      countDeniedPolling(
        JSON.stringify({ permission_denials: [{ tool_name: "Bash", tool_input: { command: "npx tsx x.ts" } }] }),
      ),
      0,
    );
  });
  it("abaixo do limiar o failureTail não rotula polling", () => {
    const { tmpRepo, editionDir } = setup();
    const env = JSON.stringify({
      subtype: "success",
      num_turns: 3,
      permission_denials: [{ tool_name: "Bash", tool_input: { command: "sleep 5" } }],
      result: "x",
    });
    const r = run(editionDir, tmpRepo, () => env, neverCompletes);
    assert.doesNotMatch(r.outcomes[0].failureTail ?? "", /polling negado/);
    rmSync(tmpRepo, { recursive: true, force: true });
  });
  it("diretiva headless proíbe polling e diz que Agent é síncrono", () => {
    assert.match(NO_BACKGROUND_DIRECTIVE, /SÍNCRONAS/);
    assert.match(NO_BACKGROUND_DIRECTIVE, /polling/);
  });
});
