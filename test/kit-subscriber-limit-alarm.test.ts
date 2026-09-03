/**
 * test/kit-subscriber-limit-alarm.test.ts (#7362)
 *
 * Cobre o miolo puro (`scripts/lib/kit-subscriber-limit-alarm.ts`) — nenhuma
 * chamada de rede. Foco no limiar de 900 (decisão do editor, 03/09/2026) e
 * no latch de idempotência (arma na transição, re-arma quando volta a cair
 * abaixo do threshold).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD,
  evaluateKitSubscriberLimitAlarm,
  emptyKitSubscriberLimitAlarmState,
  shouldAlarmKitSubscriberLimit,
  advanceKitSubscriberLimitAlarmState,
  buildKitSubscriberLimitAlarmEmail,
  KIT_SUBSCRIBER_LIMIT_FINDING_KEY,
} from "../scripts/lib/kit-subscriber-limit-alarm.ts";
import { toAlarmFindings } from "../scripts/kit-subscriber-limit-alarm.ts";

const NOW = new Date("2026-09-03T12:00:00.000Z");

describe("DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD (#7362)", () => {
  it("é 900 — decisão explícita do editor, 03/09/2026", () => {
    assert.equal(DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD, 900);
  });
});

describe("evaluateKitSubscriberLimitAlarm — limiar de 900", () => {
  it("899 ativos → NÃO triggered", () => {
    const ev = evaluateKitSubscriberLimitAlarm(899, 1000);
    assert.equal(ev.triggered, false);
  });

  it("exatamente 900 → triggered (inclusivo)", () => {
    const ev = evaluateKitSubscriberLimitAlarm(900, 1000);
    assert.equal(ev.triggered, true);
  });

  it("901 → triggered", () => {
    const ev = evaluateKitSubscriberLimitAlarm(901, 1000);
    assert.equal(ev.triggered, true);
  });

  it("estado real medido em 03/09/2026 (629 ativos, teto 1000) → NÃO triggered", () => {
    const ev = evaluateKitSubscriberLimitAlarm(629, 1000);
    assert.equal(ev.triggered, false);
    assert.equal(ev.remainingToLimit, 371);
  });

  it("remainingToLimit pode ficar negativo se o teto já foi ultrapassado (sem clamp)", () => {
    const ev = evaluateKitSubscriberLimitAlarm(1010, 1000);
    assert.equal(ev.triggered, true);
    assert.equal(ev.remainingToLimit, -10);
  });

  it("threshold é override-ável (não fixo em 900, plano pode mudar de degrau)", () => {
    const ev = evaluateKitSubscriberLimitAlarm(1800, 2000, 1900);
    assert.equal(ev.triggered, false);
    const ev2 = evaluateKitSubscriberLimitAlarm(1900, 2000, 1900);
    assert.equal(ev2.triggered, true);
  });
});

describe("shouldAlarmKitSubscriberLimit / advanceKitSubscriberLimitAlarmState — latch", () => {
  it("estado vazio, abaixo do threshold → não alarma", () => {
    const ev = evaluateKitSubscriberLimitAlarm(500, 1000);
    assert.equal(shouldAlarmKitSubscriberLimit(emptyKitSubscriberLimitAlarmState(), ev), false);
  });

  it("estado vazio, cruzou o threshold → alarma (1ª vez)", () => {
    const ev = evaluateKitSubscriberLimitAlarm(950, 1000);
    assert.equal(shouldAlarmKitSubscriberLimit(emptyKitSubscriberLimitAlarmState(), ev), true);
  });

  it("já alarmado, permanece acima do threshold → NÃO alarma de novo (idempotência, latch)", () => {
    const ev1 = evaluateKitSubscriberLimitAlarm(950, 1000);
    const state = advanceKitSubscriberLimitAlarmState(emptyKitSubscriberLimitAlarmState(), ev1, NOW);
    assert.equal(state.alarmed, true);

    const ev2 = evaluateKitSubscriberLimitAlarm(970, 1000); // subiu mais, ainda acima
    assert.equal(shouldAlarmKitSubscriberLimit(state, ev2), false);
  });

  it("já alarmado, caiu de volta abaixo do threshold → re-arma (não alarma nesta leitura)", () => {
    const ev1 = evaluateKitSubscriberLimitAlarm(950, 1000);
    const alarmedState = advanceKitSubscriberLimitAlarmState(emptyKitSubscriberLimitAlarmState(), ev1, NOW);

    const ev2 = evaluateKitSubscriberLimitAlarm(880, 1000); // caiu abaixo
    assert.equal(shouldAlarmKitSubscriberLimit(alarmedState, ev2), false);
    const rearmedState = advanceKitSubscriberLimitAlarmState(alarmedState, ev2, NOW);
    assert.equal(rearmedState.alarmed, false);
  });

  it("re-armado, cruza o threshold de novo → alarma de novo", () => {
    const ev1 = evaluateKitSubscriberLimitAlarm(950, 1000);
    const alarmedState = advanceKitSubscriberLimitAlarmState(emptyKitSubscriberLimitAlarmState(), ev1, NOW);
    const ev2 = evaluateKitSubscriberLimitAlarm(880, 1000);
    const rearmedState = advanceKitSubscriberLimitAlarmState(alarmedState, ev2, NOW);

    const ev3 = evaluateKitSubscriberLimitAlarm(905, 1000);
    assert.equal(shouldAlarmKitSubscriberLimit(rearmedState, ev3), true);
  });
});

describe("buildKitSubscriberLimitAlarmEmail", () => {
  it("assunto/corpo citam contagem, threshold e teto", () => {
    const ev = evaluateKitSubscriberLimitAlarm(905, 1000);
    const { subject, body } = buildKitSubscriberLimitAlarmEmail(ev, NOW);
    assert.match(subject, /905/);
    assert.match(subject, /900/);
    assert.match(subject, /1000/);
    assert.match(body, /#7362/);
    assert.match(body, /900/);
  });

  it("issueRef presente → corpo cita o número da issue", () => {
    const ev = evaluateKitSubscriberLimitAlarm(905, 1000);
    const { body } = buildKitSubscriberLimitAlarmEmail(ev, NOW, {
      issueNumber: 7400,
      url: "https://github.com/x/y/issues/7400",
      action: "created",
    });
    assert.match(body, /#7400/);
  });

  it("issueRef com action failed → corpo cita a falha, não um número inventado", () => {
    const ev = evaluateKitSubscriberLimitAlarm(905, 1000);
    const { body } = buildKitSubscriberLimitAlarmEmail(ev, NOW, {
      issueNumber: null,
      url: null,
      action: "failed",
      error: "gh não autenticado",
    });
    assert.match(body, /falha ao criar\/reusar/);
    assert.match(body, /gh não autenticado/);
  });
});

describe("toAlarmFindings (scripts/kit-subscriber-limit-alarm.ts)", () => {
  it("abaixo do threshold → nenhum finding", () => {
    const ev = evaluateKitSubscriberLimitAlarm(500, 1000);
    assert.deepEqual(toAlarmFindings(ev), []);
  });

  it("acima do threshold → 1 finding, check == fingerprint == chave constante", () => {
    const ev = evaluateKitSubscriberLimitAlarm(905, 1000);
    const findings = toAlarmFindings(ev);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, KIT_SUBSCRIBER_LIMIT_FINDING_KEY);
    assert.equal(findings[0].fingerprint, KIT_SUBSCRIBER_LIMIT_FINDING_KEY);
    assert.equal(findings[0].family, "estado");
    assert.equal(findings[0].priority, "P1");
  });

  it("fingerprint constante independente da contagem exata (não abre 2ª issue por variação de contagem)", () => {
    const findingsA = toAlarmFindings(evaluateKitSubscriberLimitAlarm(905, 1000));
    const findingsB = toAlarmFindings(evaluateKitSubscriberLimitAlarm(950, 1000));
    assert.equal(findingsA[0].fingerprint, findingsB[0].fingerprint);
  });
});
