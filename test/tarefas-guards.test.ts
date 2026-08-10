/**
 * test/tarefas-guards.test.ts (#4799)
 *
 * Cobertura de `scripts/studio-ui/public/tarefas-guards.js`: predicado do
 * filtro de status + formatação de duração — mesmo padrão de
 * `test/triagem-filters.test.ts`/`test/revisao-guards.test.ts` (#633):
 * fixtures puras, sem harness de DOM.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchesStatusFilter, formatDuration } from "../scripts/studio-ui/public/tarefas-guards.js";

function fakeTask(overrides = {}) {
  return {
    name: "Diaria-Fake",
    overdue: false,
    armed: { scheduler: "windows-task-scheduler", state: "armed", note: null },
    lastRun: { startedAt: null, finishedAt: null, durationMs: null, outcome: null, steps: [], excerpt: null },
    ...overrides,
  };
}

describe("matchesStatusFilter (#4799)", () => {
  it("filtro vazio ('Todos') sempre casa", () => {
    assert.equal(matchesStatusFilter(fakeTask(), ""), true);
    assert.equal(matchesStatusFilter(fakeTask({ overdue: true }), ""), true);
  });

  it("'overdue' casa só task.overdue === true", () => {
    assert.equal(matchesStatusFilter(fakeTask({ overdue: true }), "overdue"), true);
    assert.equal(matchesStatusFilter(fakeTask({ overdue: false }), "overdue"), false);
  });

  it("'not_armed' casa armed.state === 'not_armed'", () => {
    const t = fakeTask({ armed: { scheduler: "windows-task-scheduler", state: "not_armed", note: null } });
    assert.equal(matchesStatusFilter(t, "not_armed"), true);
    assert.equal(matchesStatusFilter(fakeTask(), "not_armed"), false);
  });

  it("'disabled' casa armed.state === 'disabled'", () => {
    const t = fakeTask({ armed: { scheduler: "systemd", state: "disabled", note: null } });
    assert.equal(matchesStatusFilter(t, "disabled"), true);
  });

  it("'failed' casa lastRun.outcome === 'failed'", () => {
    const t = fakeTask({ lastRun: { startedAt: "x", finishedAt: "y", durationMs: 1, outcome: "failed", steps: [], excerpt: null } });
    assert.equal(matchesStatusFilter(t, "failed"), true);
    assert.equal(matchesStatusFilter(fakeTask(), "failed"), false);
  });
});

describe("formatDuration (#4799)", () => {
  it("null/undefined -> '—'", () => {
    assert.equal(formatDuration(null), "—");
    assert.equal(formatDuration(undefined), "—");
  });

  it("negativo/NaN -> '—' (nunca mostra duração impossível)", () => {
    assert.equal(formatDuration(-5), "—");
    assert.equal(formatDuration(NaN), "—");
  });

  it("< 60s -> 'Ns'", () => {
    assert.equal(formatDuration(7000), "7s");
    assert.equal(formatDuration(0), "0s");
  });

  it("minutos -> 'Nmin Ms' (ou sem segundos quando exato)", () => {
    assert.equal(formatDuration(125_000), "2min 5s");
    assert.equal(formatDuration(120_000), "2min");
  });

  it("horas -> 'Nh Mmin' (ou sem minutos quando exato)", () => {
    assert.equal(formatDuration(3_723_000), "1h 2min");
    assert.equal(formatDuration(3_600_000), "1h");
  });
});
