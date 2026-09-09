/**
 * test/onboarding-continuity-alarm.test.ts (#7665, follow-up de detecção)
 *
 * Cobre `scripts/lib/onboarding-continuity-alarm.ts` — o tri-state honesto
 * exigido pelo #7776 (regra inegociável: NUNCA "ok" quando não conseguiu
 * verificar). Cenários exigidos pelo dispatch: sequence/detecção "morta"
 * (aqui: streak >= limiar), streak abaixo do limiar apesar de cadastro
 * (caminho saudável), e store indisponível (ausente/corrompido) →
 * "cannot-verify", nunca "ok".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateOnboardingContinuity,
  shouldSendOnboardingContinuityAlarm,
  markOnboardingContinuityAlarmed,
  emptyOnboardingContinuityAlarmState,
  buildOnboardingContinuityAlarmEmail,
  ZERO_DETECTION_ALARM_THRESHOLD_RUNS,
} from "../scripts/lib/onboarding-continuity-alarm.ts";

const NOW = new Date("2026-09-09T12:00:00Z");

describe("#7665 — evaluateOnboardingContinuity", () => {
  it("store ausente (junction data/ não montada) → cannot-verify, nunca ok/stale", () => {
    const r = evaluateOnboardingContinuity(false, false, 0);
    assert.equal(r.verdict, "cannot-verify");
    assert.equal(r.streak, null);
    assert.equal(r.cannotVerifyReason, "store_missing");
  });

  it("store corrompido (JSON ilegível) → cannot-verify, nunca ok/stale", () => {
    const r = evaluateOnboardingContinuity(true, true, 0);
    assert.equal(r.verdict, "cannot-verify");
    assert.equal(r.streak, null);
    assert.equal(r.cannotVerifyReason, "store_corrupted");
  });

  it("store corrompido some SOBRE store ausente na precedência (missing checado primeiro, mas resultado é o mesmo veredito)", () => {
    // Se por algum motivo o caller passar storeExists=false E corrupted=true
    // (não deveria acontecer na prática — readStore nunca marca corrupted
    // quando o arquivo não existe), o resultado ainda é cannot-verify, nunca
    // ok/stale — a distinção de razão é só diagnóstico, não afeta o veredito.
    const r = evaluateOnboardingContinuity(false, true, 0);
    assert.equal(r.verdict, "cannot-verify");
  });

  it("streak abaixo do limiar → ok (caminho saudável, detecção funcionando)", () => {
    const r = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS - 1);
    assert.equal(r.verdict, "ok");
    assert.equal(r.streak, ZERO_DETECTION_ALARM_THRESHOLD_RUNS - 1);
    assert.equal(r.cannotVerifyReason, null);
  });

  it("streak zero (rodada detectou gente nova) → ok", () => {
    const r = evaluateOnboardingContinuity(true, false, 0);
    assert.equal(r.verdict, "ok");
    assert.equal(r.streak, 0);
  });

  it("streak exatamente no limiar → stale (>= limiar, mesma fronteira de zeroDetectionAlarm)", () => {
    const r = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS);
    assert.equal(r.verdict, "stale");
    assert.equal(r.streak, ZERO_DETECTION_ALARM_THRESHOLD_RUNS);
  });

  it("streak acima do limiar → stale", () => {
    const r = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS + 5);
    assert.equal(r.verdict, "stale");
  });

  it("aceita threshold customizado (override explícito, não só o default)", () => {
    const r = evaluateOnboardingContinuity(true, false, 2, 5);
    assert.equal(r.verdict, "ok");
    assert.equal(r.threshold, 5);
  });

  it("usa ZERO_DETECTION_ALARM_THRESHOLD_RUNS quando threshold é omitido — reusa a decisão do #7599, não reinventa limiar", () => {
    const belowDefault = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS - 1);
    assert.equal(belowDefault.threshold, ZERO_DETECTION_ALARM_THRESHOLD_RUNS);
    assert.equal(belowDefault.verdict, "ok");
  });
});

describe("#7665 — idempotência do e-mail (1×/dia)", () => {
  it("verdict stale + nunca alarmado → envia", () => {
    const evaluation = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS);
    assert.equal(shouldSendOnboardingContinuityAlarm(evaluation, emptyOnboardingContinuityAlarmState(), NOW), true);
  });

  it("verdict stale + já alarmado HOJE → não reenvia", () => {
    const evaluation = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS);
    const state = markOnboardingContinuityAlarmed(NOW);
    assert.equal(shouldSendOnboardingContinuityAlarm(evaluation, state, NOW), false);
  });

  it("verdict stale + alarmado ONTEM → reenvia hoje", () => {
    const evaluation = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS);
    const state = markOnboardingContinuityAlarmed(new Date("2026-09-08T12:00:00Z"));
    assert.equal(shouldSendOnboardingContinuityAlarm(evaluation, state, NOW), true);
  });

  it("verdict ok → nunca envia, independente do estado", () => {
    const evaluation = evaluateOnboardingContinuity(true, false, 0);
    assert.equal(shouldSendOnboardingContinuityAlarm(evaluation, emptyOnboardingContinuityAlarmState(), NOW), false);
  });

  it("verdict cannot-verify → nunca envia (nunca alarma a partir de leitura que não aconteceu)", () => {
    const evaluation = evaluateOnboardingContinuity(false, false, 0);
    assert.equal(shouldSendOnboardingContinuityAlarm(evaluation, emptyOnboardingContinuityAlarmState(), NOW), false);
  });
});

describe("#7665 — buildOnboardingContinuityAlarmEmail", () => {
  it("cita o streak e o limiar no corpo", () => {
    const evaluation = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS + 1);
    const { subject, body } = buildOnboardingContinuityAlarmEmail(evaluation, "");
    assert.match(subject, /Onboarding-Continuity-Alarm/);
    assert.match(body, new RegExp(String(ZERO_DETECTION_ALARM_THRESHOLD_RUNS + 1)));
    assert.match(body, new RegExp(String(ZERO_DETECTION_ALARM_THRESHOLD_RUNS)));
    assert.match(body, /growth_stats/);
  });

  it("anexa as linhas de issue quando fornecidas", () => {
    const evaluation = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS);
    const { body } = buildOnboardingContinuityAlarmEmail(evaluation, "\n\nIssues:\n  - #1234 (https://x)");
    assert.match(body, /#1234/);
  });
});
