/**
 * test/clarice-novos-abort-alarm.test.ts (#5405 item 1)
 *
 * Lógica pura do alarme de abort recorrente do grupo `novos` (semáforo
 * vermelho, D4): streak de aborts CONSECUTIVOS pelo mesmo motivo, neutralidade
 * de `other-error`, idempotência (não reenvia o mesmo alarme a cada
 * checagem), reset após rodada real sem abort — mesmo molde de
 * `test/clarice-opens-catchup-alarm.test.ts` (#4740).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  emptyNovosAbortAlarmState,
  advanceNovosAbortState,
  shouldAlarmNovosAbort,
  markNovosAbortAlarmed,
  buildNovosAbortAlarmEmail,
  NOVOS_ABORT_STREAK_THRESHOLD,
  type NovosAbortAlarmState,
} from "../scripts/lib/clarice-novos-abort-alarm.ts";

const T0 = new Date("2026-08-14T11:05:00.000Z");
const T1 = new Date("2026-08-15T11:05:00.000Z");
const T2 = new Date("2026-08-16T11:05:00.000Z");

describe("advanceNovosAbortState (#5405)", () => {
  it("semaphore-red incrementa o streak", () => {
    const s0 = emptyNovosAbortAlarmState();
    const s1 = advanceNovosAbortState(s0, "semaphore-red", T0);
    assert.equal(s1.consecutiveSemaphoreAborts, 1);
    assert.equal(s1.lastCheckedAt, T0.toISOString());
  });

  it("streak de N rodadas consecutivas em semaphore-red atinge o threshold", () => {
    let s: NovosAbortAlarmState = emptyNovosAbortAlarmState();
    for (let i = 0; i < NOVOS_ABORT_STREAK_THRESHOLD; i++) {
      s = advanceNovosAbortState(s, "semaphore-red", T0);
    }
    assert.equal(s.consecutiveSemaphoreAborts, NOVOS_ABORT_STREAK_THRESHOLD);
    assert.equal(shouldAlarmNovosAbort(s), true);
  });

  it("other-error é NEUTRO — não soma nem zera o streak", () => {
    const s0: NovosAbortAlarmState = { consecutiveSemaphoreAborts: 2, lastAlarmedAt: null, lastCheckedAt: T0.toISOString() };
    const s1 = advanceNovosAbortState(s0, "other-error", T1);
    assert.equal(s1.consecutiveSemaphoreAborts, 2, "streak preservado");
    assert.equal(s1.lastCheckedAt, T1.toISOString(), "checked_at ainda atualiza");
  });

  it("rodada bem-sucedida no meio (sent) zera o streak", () => {
    const s0: NovosAbortAlarmState = { consecutiveSemaphoreAborts: 5, lastAlarmedAt: T0.toISOString(), lastCheckedAt: T0.toISOString() };
    const s1 = advanceNovosAbortState(s0, "sent", T1);
    assert.equal(s1.consecutiveSemaphoreAborts, 0);
    assert.equal(s1.lastAlarmedAt, null, "re-arma pra próxima ocorrência");
  });

  it("empty (0 candidatos, sem abort) também zera o streak — é uma rodada real sem falha", () => {
    const s0: NovosAbortAlarmState = { consecutiveSemaphoreAborts: 3, lastAlarmedAt: null, lastCheckedAt: T0.toISOString() };
    const s1 = advanceNovosAbortState(s0, "empty", T1);
    assert.equal(s1.consecutiveSemaphoreAborts, 0);
  });

  it("uncertain (disparo não confirmado, mas não é abort) zera o streak", () => {
    const s0: NovosAbortAlarmState = { consecutiveSemaphoreAborts: 4, lastAlarmedAt: null, lastCheckedAt: T0.toISOString() };
    const s1 = advanceNovosAbortState(s0, "uncertain", T1);
    assert.equal(s1.consecutiveSemaphoreAborts, 0);
  });
});

describe("shouldAlarmNovosAbort (#5405)", () => {
  it("false abaixo do threshold", () => {
    const state: NovosAbortAlarmState = {
      consecutiveSemaphoreAborts: NOVOS_ABORT_STREAK_THRESHOLD - 1,
      lastAlarmedAt: null,
      lastCheckedAt: null,
    };
    assert.equal(shouldAlarmNovosAbort(state), false);
  });

  it("true ao atingir o threshold, ainda não alarmado", () => {
    const state: NovosAbortAlarmState = {
      consecutiveSemaphoreAborts: NOVOS_ABORT_STREAK_THRESHOLD,
      lastAlarmedAt: null,
      lastCheckedAt: null,
    };
    assert.equal(shouldAlarmNovosAbort(state), true);
  });

  it("false quando já alarmado pra este streak (idempotência — não reenvia)", () => {
    const state: NovosAbortAlarmState = {
      consecutiveSemaphoreAborts: NOVOS_ABORT_STREAK_THRESHOLD + 2,
      lastAlarmedAt: T0.toISOString(),
      lastCheckedAt: T1.toISOString(),
    };
    assert.equal(shouldAlarmNovosAbort(state), false);
  });
});

describe("markNovosAbortAlarmed (#5405)", () => {
  it("grava lastAlarmedAt", () => {
    const s = markNovosAbortAlarmed(emptyNovosAbortAlarmState(), T2);
    assert.equal(s.lastAlarmedAt, T2.toISOString());
  });
});

describe("buildNovosAbortAlarmEmail (#5405)", () => {
  it("assunto/corpo citam o streak; nunca pede reverter D4", () => {
    const state: NovosAbortAlarmState = { consecutiveSemaphoreAborts: 3, lastAlarmedAt: null, lastCheckedAt: T0.toISOString() };
    const { subject, body } = buildNovosAbortAlarmEmail(state, undefined, null);
    assert.match(subject, /3 execuções seguidas/);
    assert.match(body, /D4 continua sendo o comportamento CORRETO/);
  });

  it("inclui a fila represada quando fornecida (#5405 item 3)", () => {
    const state: NovosAbortAlarmState = { consecutiveSemaphoreAborts: 3, lastAlarmedAt: null, lastCheckedAt: T0.toISOString() };
    const { body } = buildNovosAbortAlarmEmail(state, undefined, { count: 28, earliestCreatedIso: "2026-08-15" });
    assert.match(body, /28 cadastro\(s\) desde 2026-08-15/);
  });

  it("omite a fila quando pending é null (fail-soft — não bloqueia o alarme)", () => {
    const state: NovosAbortAlarmState = { consecutiveSemaphoreAborts: 3, lastAlarmedAt: null, lastCheckedAt: T0.toISOString() };
    const { body } = buildNovosAbortAlarmEmail(state, undefined, null);
    assert.doesNotMatch(body, /Fila represada/);
  });
});
