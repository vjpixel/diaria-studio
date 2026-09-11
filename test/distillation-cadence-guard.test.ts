/**
 * test/distillation-cadence-guard.test.ts (#7981)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateDistillationCadence, MAX_DISTILLATION_TRIGGERS_PER_WEEK } from "../scripts/lib/distillation-cadence-guard.ts";

describe("evaluateDistillationCadence (#7981)", () => {
  it("permite disparo quando nenhum disparo anterior existe", () => {
    const decision = evaluateDistillationCadence({ triggeredAt: [] }, "2026-09-11T12:00:00.000Z");
    assert.equal(decision.canTrigger, true);
    assert.equal(decision.triggersThisWeek, 0);
    assert.equal(decision.reason, null);
  });

  it(`bloqueia depois de ${MAX_DISTILLATION_TRIGGERS_PER_WEEK} disparo(s) na última semana`, () => {
    const decision = evaluateDistillationCadence({ triggeredAt: ["2026-09-10T12:00:00.000Z"] }, "2026-09-11T12:00:00.000Z");
    assert.equal(decision.canTrigger, false);
    assert.equal(decision.triggersThisWeek, 1);
    assert.match(decision.reason!, /teto semanal/);
  });

  it("disparo há mais de 7 dias não conta pro teto", () => {
    const decision = evaluateDistillationCadence({ triggeredAt: ["2026-09-01T12:00:00.000Z"] }, "2026-09-11T12:00:00.000Z");
    assert.equal(decision.canTrigger, true);
    assert.equal(decision.triggersThisWeek, 0);
  });

  it("lança se nowIso não parsear (fail-hard, nunca permissivo)", () => {
    assert.throws(() => evaluateDistillationCadence({ triggeredAt: [] }, "data-invalida"), /não é uma data ISO válida/);
  });

  it("timestamp futuro no histórico não conta (proteção contra clock skew)", () => {
    const decision = evaluateDistillationCadence({ triggeredAt: ["2026-09-15T12:00:00.000Z"] }, "2026-09-11T12:00:00.000Z");
    assert.equal(decision.canTrigger, true);
  });
});
