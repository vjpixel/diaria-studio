/**
 * test/edition-stage-runner-accumulate-9312.test.ts (#9312)
 *
 * Regressão: `recordStageRun` gravava via `applyUpdate`, que SUBSTITUI
 * `cost_usd`/`tokens_*`/`num_turns`. No retry do background-wait (#6045) o
 * custo/turnos da tentativa 1 sumiam (no caminho de sentinela ausente ela nem
 * era gravada, o `continue` vinha antes), e um re-run manual depois de um
 * `error_max_turns` apagava o custo da rodada que estourou o teto — justamente
 * o que o #9222 queria tornar visível. Agora as execuções CLI são somadas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEditionStages, accumulateCliRun, STAGE_PLAN } from "../scripts/lib/edition-stage-runner.ts";
import type { StageRow } from "../scripts/update-stage-status.ts";

const AAMMDD = "261001";

function setup() {
  const tmpRepo = mkdtempSync(join(tmpdir(), "9312-"));
  const editionDir = join(tmpRepo, "editions", AAMMDD);
  mkdirSync(editionDir, { recursive: true });
  return { tmpRepo, editionDir };
}

function readRow(editionDir: string, stage: number) {
  const doc = JSON.parse(readFileSync(join(editionDir, "_internal", "stage-status.json"), "utf8"));
  return doc.rows.find((r: { stage: number }) => r.stage === stage);
}

/** Sentinela ok a partir da n-ésima consulta (1-based). */
function okFromCall(n: number) {
  let calls = 0;
  return ((_d: string, _s: number) =>
    ++calls >= n ? { ok: true } : { ok: false, reason: "sentinel_missing" }) as never;
}
const neverCompletes = ((_d: string, _s: number) => ({ ok: false, reason: "sentinel_missing" })) as never;

const envelope = (o: Record<string, unknown>) =>
  JSON.stringify({ type: "result", usage: { input_tokens: 10, output_tokens: 5 }, ...o });

const BG_WAIT = envelope({
  subtype: "success",
  num_turns: 30,
  total_cost_usd: 2,
  result: "Dispatched a background task, waiting for the background task to finish.",
});
const SUCCESS = envelope({ subtype: "success", num_turns: 57, total_cost_usd: 1.5, result: "ok" });
const MAX_TURNS = envelope({ subtype: "error_max_turns", num_turns: 121, total_cost_usd: 7.75, result: "x" });

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

describe("#9312 recordStageRun acumula entre execuções", () => {
  it("retry do background-wait (sentinela ausente): tentativa 1 é gravada e somada à 2", () => {
    const { tmpRepo, editionDir } = setup();
    try {
      const outs = [BG_WAIT, SUCCESS];
      // consultas: before (1), após tentativa 1 (2), após tentativa 2 (3) → ok
      const r = run(editionDir, tmpRepo, () => outs.shift(), okFromCall(3));
      assert.equal(r.exitCode, 0);
      const row = readRow(editionDir, 2);
      assert.equal(row.cost_usd, 3.5);
      assert.equal(row.num_turns, 87);
      assert.equal(row.tokens_in, 20);
      assert.equal(row.tokens_out, 10);
      assert.equal(row.cli_runs, 2);
      assert.equal(row.session_filter, "cli_json");
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("retry do background-wait no caminho de exceção: as duas tentativas somadas", () => {
    const { tmpRepo, editionDir } = setup();
    try {
      let n = 0;
      const r = run(
        editionDir,
        tmpRepo,
        () => {
          if (n++ === 0) throw Object.assign(new Error("exit 1"), { status: 1, stdout: BG_WAIT, stderr: "" });
          return SUCCESS;
        },
        okFromCall(2), // before (1), após tentativa 2 (2)
      );
      assert.equal(r.exitCode, 0);
      const row = readRow(editionDir, 2);
      assert.equal(row.cost_usd, 3.5);
      assert.equal(row.num_turns, 87);
      assert.equal(row.cli_runs, 2);
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("re-run manual depois de error_max_turns soma o custo da rodada que falhou; terminal_reason reflete a última", () => {
    const { tmpRepo, editionDir } = setup();
    try {
      const r1 = run(editionDir, tmpRepo, () => MAX_TURNS, neverCompletes);
      assert.equal(r1.exitCode, 1);
      assert.equal(readRow(editionDir, 2).cost_usd, 7.75);
      assert.equal(readRow(editionDir, 2).cli_runs, 1);

      const r2 = run(editionDir, tmpRepo, () => SUCCESS, okFromCall(2));
      assert.equal(r2.exitCode, 0);
      const row = readRow(editionDir, 2);
      assert.equal(row.cost_usd, 9.25);
      assert.equal(row.num_turns, 178);
      assert.equal(row.cli_runs, 2);
      assert.equal(row.terminal_reason, undefined, "sucesso posterior limpa o motivo da falha");
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});

describe("#9312 accumulateCliRun (pure)", () => {
  const usage = { costUsd: 1, tokensIn: 100, tokensOut: 10, models: ["claude-opus-5-5"] };

  it("linha sem execução CLI anterior → valores da execução, cli_runs 1", () => {
    const row: StageRow = { stage: 2, status: "running" };
    assert.deepEqual(accumulateCliRun(row, usage, { numTurns: 5 }), {
      cost_usd: 1,
      tokens_in: 100,
      tokens_out: 10,
      models: ["claude-opus-5-5"],
      session_filter: "cli_json",
      num_turns: 5,
      cli_runs: 1,
    });
  });

  it("número vindo de transcript (≠ cli_json) é substituído, não somado", () => {
    const row: StageRow = { stage: 2, status: "done", cost_usd: 9, tokens_in: 9, session_filter: "current_session" };
    const out = accumulateCliRun(row, usage, null);
    assert.equal(out.cost_usd, 1);
    assert.equal(out.tokens_in, 100);
    assert.equal(out.cli_runs, 1);
  });

  it("linha cli_json anterior → soma e une modelos sem duplicar", () => {
    const row: StageRow = {
      stage: 2,
      status: "failed",
      cost_usd: 0.1,
      tokens_in: 1,
      tokens_out: 1,
      models: ["claude-opus-5-5", "claude-haiku-4-5-20251001"],
      session_filter: "cli_json",
      num_turns: 3,
      cli_runs: 2,
    };
    const out = accumulateCliRun(row, { ...usage, costUsd: 0.2 }, { numTurns: 4 });
    assert.equal(out.cost_usd, 0.3, "sem erro de ponto flutuante");
    assert.equal(out.tokens_in, 101);
    assert.deepEqual(out.models, ["claude-opus-5-5", "claude-haiku-4-5-20251001"]);
    assert.equal(out.num_turns, 7);
    assert.equal(out.cli_runs, 3);
  });

  it("envelope sem usage nem num_turns → nada a gravar", () => {
    assert.deepEqual(accumulateCliRun({ stage: 2, status: "running" }, null, {}), {});
  });
});
