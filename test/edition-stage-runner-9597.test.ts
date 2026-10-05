/**
 * #9597 (edição 261005): (1) Stage 1 saiu 0 após 21 min com a última linha
 * "Waiting for this to complete." — sem "background", o retry único do #6045
 * não disparava; (2) Stage 2 bateu error_max_turns e o failureTail não dizia
 * isso (o motivo só ia pro stage-status.json).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEditionStages,
  looksLikeBackgroundWaitExit,
  formatRunMetaLabel,
  MAX_TURNS,
  STAGE_PLAN,
} from "../scripts/lib/edition-stage-runner.ts";

const AAMMDD = "261005";

function setup() {
  const tmpRepo = mkdtempSync(join(tmpdir(), "9597-"));
  const editionDir = join(tmpRepo, "editions", AAMMDD);
  mkdirSync(editionDir, { recursive: true });
  return { tmpRepo, editionDir };
}

const neverCompletes = ((_d: string, _s: number) => ({ ok: false, reason: "sentinel_missing" })) as never;

function run(editionDir: string, tmpRepo: string, execFn: unknown, stageIdx: number) {
  return runEditionStages({
    aammdd: AAMMDD,
    editionDir,
    repoRootAbs: tmpRepo,
    resolveClaudeBin: () => "echo",
    env: {},
    plan: STAGE_PLAN.slice(stageIdx, stageIdx + 1),
    execFn: execFn as never,
    assertSentinelFn: neverCompletes,
  });
}

describe("#9597 looksLikeBackgroundWaitExit — 'waiting for this to complete'", () => {
  it("reconhece a última linha real do Stage 1 de 261005", () => {
    assert.equal(looksLikeBackgroundWaitExit("Dispatched the research.\nWaiting for this to complete."), true);
  });
  it("variações: it/them/the subagents, finish", () => {
    assert.equal(looksLikeBackgroundWaitExit("I'll wait for them to finish."), true);
    assert.equal(looksLikeBackgroundWaitExit("Waiting for the scorer chunks to complete"), true);
  });
  it("texto de conclusão normal não casa", () => {
    assert.equal(looksLikeBackgroundWaitExit("Stage 1 concluído. Sentinel gravado."), false);
    assert.equal(looksLikeBackgroundWaitExit("Waited for nothing; all tasks completed."), false);
  });

  it("cenário 261005 Stage 1: exit 0 sem sentinela com essa frase → 1 retry antes de falhar", () => {
    const { tmpRepo, editionDir } = setup();
    let calls = 0;
    const r = run(
      editionDir,
      tmpRepo,
      () => {
        calls++;
        return JSON.stringify({ subtype: "success", num_turns: 30, result: "Waiting for this to complete." });
      },
      0,
    );
    assert.equal(calls, 2, "o retry único do #6045 tem que disparar");
    assert.equal(r.exitCode, 1);
    rmSync(tmpRepo, { recursive: true, force: true });
  });
});

describe("#9597 failureTail nomeia terminal_reason/num_turns", () => {
  const envelope = JSON.stringify({
    type: "result",
    subtype: "error_max_turns",
    num_turns: 121,
    total_cost_usd: 9.69,
    usage: { input_tokens: 1, output_tokens: 1 },
    result: "02-reviewed.md e 03-social.md gravados",
  });

  it("formatRunMetaLabel: max_turns ganha o teto explícito", () => {
    assert.equal(
      formatRunMetaLabel(envelope),
      `terminal_reason=error_max_turns, num_turns=121 (estourou o teto --max-turns ${MAX_TURNS})`,
    );
    assert.equal(formatRunMetaLabel(JSON.stringify({ subtype: "success", num_turns: 4 })), "num_turns=4");
    assert.equal(formatRunMetaLabel("não json"), null);
    assert.equal(formatRunMetaLabel(JSON.stringify({ subtype: "success" })), null);
  });

  it("cenário 261005 Stage 2 (exit 0 sem sentinela): failureTail cita error_max_turns", () => {
    const { tmpRepo, editionDir } = setup();
    const r = run(editionDir, tmpRepo, () => envelope, 1);
    assert.equal(r.exitCode, 1);
    assert.match(r.outcomes[0].failureTail ?? "", /terminal_reason=error_max_turns, num_turns=121/);
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("exit != 0 com o envelope em err.stdout: failureTail também cita error_max_turns", () => {
    const { tmpRepo, editionDir } = setup();
    const r = run(
      editionDir,
      tmpRepo,
      () => {
        throw Object.assign(new Error("exit 1"), { status: 1, stdout: envelope, stderr: "" });
      },
      1,
    );
    assert.equal(r.exitCode, 1);
    assert.match(r.outcomes[0].failureTail ?? "", /^terminal_reason=error_max_turns, num_turns=121 \(estourou/);
    rmSync(tmpRepo, { recursive: true, force: true });
  });
});
