/**
 * test/linkedin-weekly-staleness-alarm.test.ts (#5111)
 *
 * Lógica pura de `scripts/lib/linkedin-weekly-staleness-alarm.ts`. Cobre o
 * cenário real da issue: o ciclo `26w32` da semanal do LinkedIn não rodou e
 * nada alarmou — o editor só percebeu 2 dias depois, por memória própria.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mostRecentContentMonday,
  mostRecentCompletedCycle,
  evaluateLinkedinWeeklyStalenessAlarm,
  shouldSendLinkedinWeeklyStalenessAlarm,
  markLinkedinWeeklyStalenessAlarmed,
  emptyLinkedinWeeklyStalenessAlarmState,
  buildLinkedinWeeklyStalenessAlarmEmail,
} from "../scripts/lib/linkedin-weekly-staleness-alarm.ts";

function ymd(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d);
}

describe("mostRecentContentMonday", () => {
  it("rodando num domingo, a semana que 'acabou' é a que INCLUI essa mesma semana (sexta foi 2 dias atrás)", () => {
    // 09/08/2026 é domingo (26w32 termina sexta 07/08).
    const monday = mostRecentContentMonday(ymd(2026, 8, 9));
    assert.deepEqual([monday.getFullYear(), monday.getMonth() + 1, monday.getDate()], [2026, 8, 3]);
  });

  it("rodando numa segunda-feira, a semana que 'acabou' é a ANTERIOR (a sexta desta semana ainda não chegou)", () => {
    // 10/08/2026 é segunda.
    const monday = mostRecentContentMonday(ymd(2026, 8, 10));
    assert.deepEqual([monday.getFullYear(), monday.getMonth() + 1, monday.getDate()], [2026, 8, 3]);
  });

  it("rodando numa quarta-feira (task atrasada/máquina fora), ainda aponta pra ÚLTIMA semana COMPLETA, nunca a em curso", () => {
    // 12/08/2026 é quarta.
    const monday = mostRecentContentMonday(ymd(2026, 8, 12));
    assert.deepEqual([monday.getFullYear(), monday.getMonth() + 1, monday.getDate()], [2026, 8, 3]);
  });

  it("rodando numa sexta-feira, a semana já 'acabou' hoje mesmo (sexta é o último dia de conteúdo)", () => {
    const monday = mostRecentContentMonday(ymd(2026, 8, 7)); // sexta
    assert.deepEqual([monday.getFullYear(), monday.getMonth() + 1, monday.getDate()], [2026, 8, 3]);
  });

  it("rodando num sábado, mesma semana que acabou de terminar", () => {
    const monday = mostRecentContentMonday(ymd(2026, 8, 8)); // sábado
    assert.deepEqual([monday.getFullYear(), monday.getMonth() + 1, monday.getDate()], [2026, 8, 3]);
  });
});

describe("mostRecentCompletedCycle", () => {
  it("domingo 09/08/2026 → ciclo 26w32 (semana de 03-07/08)", () => {
    assert.equal(mostRecentCompletedCycle(ymd(2026, 8, 9)), "26w32");
  });

  it("segunda 10/08/2026 (dia de publicação do ciclo 26w32) → ainda 26w32, não a semana em curso", () => {
    assert.equal(mostRecentCompletedCycle(ymd(2026, 8, 10)), "26w32");
  });
});

describe("evaluateLinkedinWeeklyStalenessAlarm", () => {
  it("artefato existe → ok", () => {
    assert.equal(evaluateLinkedinWeeklyStalenessAlarm("26w32", true).verdict, "ok");
  });

  it("artefato ausente (o cenário REAL da issue #5111) → alarm-missing", () => {
    assert.equal(evaluateLinkedinWeeklyStalenessAlarm("26w32", false).verdict, "alarm-missing");
  });
});

describe("shouldSendLinkedinWeeklyStalenessAlarm — idempotência (1 alarme por ciclo)", () => {
  it("verdict ok nunca alarma", () => {
    const evaluation = evaluateLinkedinWeeklyStalenessAlarm("26w32", true);
    assert.equal(shouldSendLinkedinWeeklyStalenessAlarm(evaluation, emptyLinkedinWeeklyStalenessAlarmState()), false);
  });

  it("verdict alarm-missing + ciclo nunca alarmado antes → alarma", () => {
    const evaluation = evaluateLinkedinWeeklyStalenessAlarm("26w32", false);
    assert.equal(shouldSendLinkedinWeeklyStalenessAlarm(evaluation, emptyLinkedinWeeklyStalenessAlarmState()), true);
  });

  it("mesmo ciclo já alarmado antes → não reenvia", () => {
    const evaluation = evaluateLinkedinWeeklyStalenessAlarm("26w32", false);
    const state = markLinkedinWeeklyStalenessAlarmed("26w32");
    assert.equal(shouldSendLinkedinWeeklyStalenessAlarm(evaluation, state), false);
  });

  it("ciclo NOVO com falha nova sempre alarma, independente do ciclo anterior já alarmado", () => {
    const evaluation = evaluateLinkedinWeeklyStalenessAlarm("26w33", false);
    const state = markLinkedinWeeklyStalenessAlarmed("26w32");
    assert.equal(shouldSendLinkedinWeeklyStalenessAlarm(evaluation, state), true);
  });
});

describe("buildLinkedinWeeklyStalenessAlarmEmail", () => {
  it("cita o ciclo e o path do artefato ausente", () => {
    const { subject, body } = buildLinkedinWeeklyStalenessAlarmEmail("26w32");
    assert.match(subject, /26w32/);
    assert.match(body, /ln-26w32\.json/);
    assert.match(body, /diaria-linkedin-semanal/);
  });
});
