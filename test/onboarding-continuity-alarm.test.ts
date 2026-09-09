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
  RUN_FRESHNESS_MAX_HORAS,
} from "../scripts/lib/onboarding-continuity-alarm.ts";

const NOW = new Date("2026-09-09T12:00:00Z");
/** #7665: carimbo de rodada recente. Os testes abaixo exercitam a lógica da
 *  STREAK, não a de frescor — então passam um timestamp fresco pra não caírem
 *  no `cannot-verify` que o guard de frescor (P1 do review da PR #7805)
 *  introduziu. O frescor tem bloco próprio no fim do arquivo. */
const RODADA_FRESCA = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();

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
    const r = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS - 1, undefined, RODADA_FRESCA, NOW);
    assert.equal(r.verdict, "ok");
    assert.equal(r.streak, ZERO_DETECTION_ALARM_THRESHOLD_RUNS - 1);
    assert.equal(r.cannotVerifyReason, null);
  });

  it("streak zero (rodada detectou gente nova) → ok", () => {
    const r = evaluateOnboardingContinuity(true, false, 0, undefined, RODADA_FRESCA, NOW);
    assert.equal(r.verdict, "ok");
    assert.equal(r.streak, 0);
  });

  it("streak exatamente no limiar → stale (>= limiar, mesma fronteira de zeroDetectionAlarm)", () => {
    const r = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS, undefined, RODADA_FRESCA, NOW);
    assert.equal(r.verdict, "stale");
    assert.equal(r.streak, ZERO_DETECTION_ALARM_THRESHOLD_RUNS);
  });

  it("streak acima do limiar → stale", () => {
    const r = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS + 5, undefined, RODADA_FRESCA, NOW);
    assert.equal(r.verdict, "stale");
  });

  it("aceita threshold customizado (override explícito, não só o default)", () => {
    const r = evaluateOnboardingContinuity(true, false, 2, 5, RODADA_FRESCA, NOW);
    assert.equal(r.verdict, "ok");
    assert.equal(r.threshold, 5);
  });

  it("usa ZERO_DETECTION_ALARM_THRESHOLD_RUNS quando threshold é omitido — reusa a decisão do #7599, não reinventa limiar", () => {
    const belowDefault = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS - 1, undefined, RODADA_FRESCA, NOW);
    assert.equal(belowDefault.threshold, ZERO_DETECTION_ALARM_THRESHOLD_RUNS);
    assert.equal(belowDefault.verdict, "ok");
  });
});

describe("#7665 — idempotência do e-mail (1×/dia)", () => {
  it("verdict stale + nunca alarmado → envia", () => {
    const evaluation = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS, undefined, RODADA_FRESCA, NOW);
    assert.equal(shouldSendOnboardingContinuityAlarm(evaluation, emptyOnboardingContinuityAlarmState(), NOW), true);
  });

  it("verdict stale + já alarmado HOJE → não reenvia", () => {
    const evaluation = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS, undefined, RODADA_FRESCA, NOW);
    const state = markOnboardingContinuityAlarmed(NOW);
    assert.equal(shouldSendOnboardingContinuityAlarm(evaluation, state, NOW), false);
  });

  it("verdict stale + alarmado ONTEM → reenvia hoje", () => {
    const evaluation = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS, undefined, RODADA_FRESCA, NOW);
    const state = markOnboardingContinuityAlarmed(new Date("2026-09-08T12:00:00Z"));
    assert.equal(shouldSendOnboardingContinuityAlarm(evaluation, state, NOW), true);
  });

  it("verdict ok → nunca envia, independente do estado", () => {
    const evaluation = evaluateOnboardingContinuity(true, false, 0, undefined, RODADA_FRESCA, NOW);
    assert.equal(shouldSendOnboardingContinuityAlarm(evaluation, emptyOnboardingContinuityAlarmState(), NOW), false);
  });

  it("verdict cannot-verify → nunca envia (nunca alarma a partir de leitura que não aconteceu)", () => {
    const evaluation = evaluateOnboardingContinuity(false, false, 0);
    assert.equal(shouldSendOnboardingContinuityAlarm(evaluation, emptyOnboardingContinuityAlarmState(), NOW), false);
  });
});

describe("#7665 — buildOnboardingContinuityAlarmEmail", () => {
  it("cita o streak e o limiar no corpo", () => {
    const evaluation = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS + 1, undefined, RODADA_FRESCA, NOW);
    const { subject, body } = buildOnboardingContinuityAlarmEmail(evaluation, "");
    assert.match(subject, /Onboarding-Continuity-Alarm/);
    assert.match(body, new RegExp(String(ZERO_DETECTION_ALARM_THRESHOLD_RUNS + 1)));
    assert.match(body, new RegExp(String(ZERO_DETECTION_ALARM_THRESHOLD_RUNS)));
    assert.match(body, /growth_stats/);
  });

  it("anexa as linhas de issue quando fornecidas", () => {
    const evaluation = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS, undefined, RODADA_FRESCA, NOW);
    const { body } = buildOnboardingContinuityAlarmEmail(evaluation, "\n\nIssues:\n  - #1234 (https://x)");
    assert.match(body, /#1234/);
  });
});

/**
 * #7665 — achado P1/alta do review da PR #7805.
 *
 * A 1ª versão do alarme lia SÓ `consecutive_zero_detections`. Se a rodada
 * diária para de executar (timer desarmado, crash, guard abortando por
 * `data/` ausente), a streak CONGELA no valor em que estava — e congelada
 * abaixo do limiar, o veredito seria `ok` indefinidamente: o alarme ficaria
 * mudo exatamente quando a situação é pior. É a mesma classe do #7776
 * ("fail-soft sem detecção"), um nível acima — o detector precisa saber se
 * ele próprio ainda está sendo alimentado.
 */
describe("#7665 P1 — frescor da rodada: streak congelada não vira `ok`", () => {
  const FRESCO = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();

  it("streak ABAIXO do limiar mas rodada parada há mais que o teto → cannot-verify, NUNCA ok", () => {
    const parado = new Date(NOW.getTime() - (RUN_FRESHNESS_MAX_HORAS + 1) * 3_600_000).toISOString();
    const r = evaluateOnboardingContinuity(true, false, 0, undefined, parado, NOW);
    assert.equal(r.verdict, "cannot-verify", "streak congelada em 0 não pode render `ok`");
    assert.equal(r.cannotVerifyReason, "run_parado");
    assert.equal(r.streak, null);
  });

  it("store sem o campo (anterior a este fix) → cannot-verify, não `ok` otimista", () => {
    const r = evaluateOnboardingContinuity(true, false, 0, undefined, null, NOW);
    assert.equal(r.verdict, "cannot-verify");
    assert.equal(r.cannotVerifyReason, "run_timestamp_ausente");
  });

  it("timestamp ilegível → cannot-verify (nunca tratado como fresco)", () => {
    const r = evaluateOnboardingContinuity(true, false, 0, undefined, "nao-e-data", NOW);
    assert.equal(r.verdict, "cannot-verify");
    assert.equal(r.cannotVerifyReason, "run_timestamp_ausente");
  });

  it("rodada fresca + streak abaixo do limiar → ok (caminho saudável preservado)", () => {
    const r = evaluateOnboardingContinuity(true, false, 0, undefined, FRESCO, NOW);
    assert.equal(r.verdict, "ok");
    assert.equal(r.streak, 0);
  });

  it("rodada fresca + streak no limiar → stale (o alarme original continua valendo)", () => {
    const r = evaluateOnboardingContinuity(
      true,
      false,
      ZERO_DETECTION_ALARM_THRESHOLD_RUNS,
      undefined,
      FRESCO,
      NOW,
    );
    assert.equal(r.verdict, "stale");
  });

  it("dia pulado por guard (dentro do teto de 48h) NÃO vira ruído", () => {
    const ontem = new Date(NOW.getTime() - 26 * 3_600_000).toISOString();
    const r = evaluateOnboardingContinuity(true, false, 0, undefined, ontem, NOW);
    assert.equal(r.verdict, "ok");
  });
});
