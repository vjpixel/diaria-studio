/**
 * test/edition-stage-runner-run-log-9597.test.ts (#9597 item 2)
 *
 * `num_turns` é soma e `terminal_reason` guarda só a última execução — não dava
 * pra distinguir 1 execução de 120 turnos de 2 que somam >120. `cli_run_log`
 * persiste turnos/terminal_reason/custo por execução.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accumulateCliRun } from "../scripts/lib/edition-stage-runner.ts";
import type { StageRow } from "../scripts/update-stage-status.ts";

const usage = (costUsd: number) =>
  ({ costUsd, tokensIn: 10, tokensOut: 5, models: ["m"] }) as never;
const meta = (numTurns: number, terminalReason?: string) => ({ numTurns, terminalReason }) as never;

describe("#9597 cli_run_log por execução", () => {
  it("execução única grava 1 entrada", () => {
    const out = accumulateCliRun({ stage: 2 } as StageRow, usage(1.5), meta(57, "success"));
    assert.deepEqual(out.cli_run_log, [{ num_turns: 57, terminal_reason: "success", cost_usd: 1.5 }]);
  });

  it("2 execuções somando >120 ficam distinguíveis de 1 de 120", () => {
    const first = accumulateCliRun({ stage: 2 } as StageRow, usage(7.75), meta(100, "error_max_turns"));
    const row = { stage: 2, session_filter: "cli_json", num_turns: 100, cli_runs: 1, ...first } as StageRow;
    const second = accumulateCliRun(row, usage(1.5), meta(57, "success"));
    assert.equal(second.num_turns, 157);
    assert.deepEqual(second.cli_run_log?.map((e) => e.num_turns), [100, 57]);
    assert.equal(second.cli_run_log?.[0].terminal_reason, "error_max_turns");
  });

  it("linha pré-#9597 (sem cli_run_log) continua somando sem quebrar", () => {
    const row = { stage: 2, session_filter: "cli_json", num_turns: 50, cli_runs: 1 } as StageRow;
    const out = accumulateCliRun(row, usage(1), meta(10, "success"));
    assert.equal(out.num_turns, 60);
    assert.deepEqual(out.cli_run_log, [{ num_turns: 10, terminal_reason: "success", cost_usd: 1 }]);
  });
});
