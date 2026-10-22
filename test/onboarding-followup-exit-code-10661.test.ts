/**
 * test/onboarding-followup-exit-code-10661.test.ts (#10661)
 *
 * O exit 1 por `cap_window_overflow` deixava `Diaria-Onboarding-Welcome-Run`
 * vermelha por dias e escondia falha real dos passos `run`/`kit`. Agora o
 * excedente sozinho sai com código próprio (3), declarado em
 * `successExitCodes` da task; falha de entrega continua 1 e vence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FOLLOWUP_CAP_WINDOW_OVERFLOW_EXIT_CODE,
  isFailedFollowupRun,
  resolveFollowupExitCode,
  type FollowupRunRecord,
} from "../scripts/lib/onboarding-followup.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import { classifyTaskRunResult } from "../scripts/lib/scheduled-task-status.ts";

function run(over: Partial<FollowupRunRecord> = {}): FollowupRunRecord {
  return { at: "2026-10-22T12:05:00Z", apoio_blocked: null, form_blocked: null, lots_created: 0, lots_failed: 0, over_cap: 0, lookups_failed: 0, counts: {}, ...over };
}

describe("#10661 exit code do followup", () => {
  it("rodada limpa sai 0", () => {
    assert.equal(resolveFollowupExitCode(run()), 0);
  });

  it("só o excedente do teto sai com o código próprio, e continua contando no alarme de continuidade", () => {
    const r = run({ cap_window_overflow: 1 });
    assert.equal(FOLLOWUP_CAP_WINDOW_OVERFLOW_EXIT_CODE, 3);
    assert.equal(resolveFollowupExitCode(r), FOLLOWUP_CAP_WINDOW_OVERFLOW_EXIT_CODE);
    assert.equal(isFailedFollowupRun(r), true, "o excedente segue no alarme");
  });

  it("falha de entrega sai 1 e vence o excedente", () => {
    assert.equal(resolveFollowupExitCode(run({ lots_failed: 1, cap_window_overflow: 2 })), 1);
    assert.equal(resolveFollowupExitCode(run({ over_cap: 1 })), 1);
    assert.equal(resolveFollowupExitCode(run({ lots_unresolved: 1, cap_window_overflow: 1 })), 1);
  });

  it("a task declara o código como sucesso, e /tarefas não pinta a rodada de vermelho por ele", () => {
    const def = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Onboarding-Welcome-Run");
    assert.ok(def);
    assert.ok(def.successExitCodes?.includes(FOLLOWUP_CAP_WINDOW_OVERFLOW_EXIT_CODE));
    assert.ok(!(def.successExitCodes ?? []).includes(1), "exit 1 nunca vira sucesso");
    assert.equal(def.steps.at(-1)?.key, "followup", "o followup é o último passo");

    const base = { startedAt: "2026-10-22T12:05:00Z", description: "x", guardAborted: false, raw: "" };
    const overflowOnly = { ...base, steps: [{ key: "run", code: 0 }, { key: "kit", code: 0 }, { key: "followup", code: 3 }] };
    assert.notEqual(classifyTaskRunResult(overflowOnly as never, def), "failed");
    const realFailure = { ...base, steps: [{ key: "run", code: 1 }, { key: "kit", code: 0 }, { key: "followup", code: 3 }] };
    assert.equal(classifyTaskRunResult(realFailure as never, def), "failed", "falha real de run segue visível");
  });
});
