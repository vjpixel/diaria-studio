/**
 * test/studio-liveness-alarm.test.ts (#5759)
 *
 * Lógica pura de `scripts/lib/studio-liveness-alarm.ts` + `toAlarmFinding`
 * de `scripts/studio-liveness-alarm.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recordStudioHttpCheck,
  isAlarmingVerdict,
  shouldSendStudioLivenessAlarm,
  markStudioLivenessAlarmed,
  emptyStudioLivenessAlarmState,
  buildStudioLivenessAlarmEmail,
  CONSECUTIVE_FAILURE_THRESHOLD,
  type StudioLivenessAlarmState,
  type StudioHttpCheckResult,
} from "../scripts/lib/studio-liveness-alarm.ts";
import { toAlarmFinding } from "../scripts/studio-liveness-alarm.ts";

/** Replay de uma sequência de resultados de check através do estado —
 * devolve o state + evaluation FINAIS depois de aplicar toda a sequência em
 * ordem. Simula execuções sucessivas da task (cada uma lê o state
 * persistido, faz 1 check, grava o state de volta). */
function replay(results: StudioHttpCheckResult[]) {
  let state: StudioLivenessAlarmState = emptyStudioLivenessAlarmState();
  let evaluation;
  for (const result of results) {
    const outcome = recordStudioHttpCheck(state, result);
    state = outcome.nextState;
    evaluation = outcome.evaluation;
  }
  return { state, evaluation: evaluation! };
}

describe("recordStudioHttpCheck — limiar de consecutivas (#5759)", () => {
  it("CONSECUTIVE_FAILURE_THRESHOLD é 2 (restart normal de ~7s não deve alarmar)", () => {
    assert.equal(CONSECUTIVE_FAILURE_THRESHOLD, 2);
  });

  it("1 falha isolada → não alarma (degraded, não alarm-unreachable)", () => {
    const { evaluation } = replay(["failure"]);
    assert.equal(evaluation.verdict, "degraded");
    assert.equal(isAlarmingVerdict(evaluation.verdict), false);
    assert.equal(evaluation.consecutiveFailures, 1);
  });

  it("2 falhas consecutivas → alarma", () => {
    const { evaluation } = replay(["failure", "failure"]);
    assert.equal(evaluation.verdict, "alarm-unreachable");
    assert.equal(isAlarmingVerdict(evaluation.verdict), true);
    assert.equal(evaluation.consecutiveFailures, 2);
  });

  it("timeout conta como falha igual a failure — 2 timeouts consecutivos também alarma", () => {
    const { evaluation } = replay(["timeout", "timeout"]);
    assert.equal(evaluation.verdict, "alarm-unreachable");
  });

  it("mistura failure+timeout consecutivos também alarma (o tipo não importa, só a sequência)", () => {
    const { evaluation } = replay(["failure", "timeout"]);
    assert.equal(evaluation.verdict, "alarm-unreachable");
  });

  it("falha-sucesso-falha (não consecutivas) → não alarma — 'ok' reseta a contagem", () => {
    const { evaluation } = replay(["failure", "ok", "failure"]);
    assert.equal(evaluation.verdict, "degraded");
    assert.equal(evaluation.consecutiveFailures, 1);
    assert.equal(isAlarmingVerdict(evaluation.verdict), false);
  });

  it("restart normal simulado (falha curta seguida de sucesso rápido) → não alarma", () => {
    // 1 check falho enquanto o processo reinicia (~7s), próximo check já
    // ok — nunca chega a 2 falhas seguidas.
    const { evaluation } = replay(["failure", "ok"]);
    assert.equal(evaluation.verdict, "ok");
    assert.equal(evaluation.consecutiveFailures, 0);
    assert.equal(isAlarmingVerdict(evaluation.verdict), false);
  });

  it("3+ falhas consecutivas seguem alarmando (verdict estável acima do limiar)", () => {
    const { evaluation } = replay(["failure", "failure", "failure", "failure"]);
    assert.equal(evaluation.verdict, "alarm-unreachable");
    assert.equal(evaluation.consecutiveFailures, 4);
  });

  it("recuperação total: falha, falha, ok → volta a 0 mesmo depois de cruzar o limiar", () => {
    const { evaluation } = replay(["failure", "failure", "ok"]);
    assert.equal(evaluation.verdict, "ok");
    assert.equal(evaluation.consecutiveFailures, 0);
  });
});

describe("isAlarmingVerdict", () => {
  it("ok e degraded → false; alarm-unreachable → true", () => {
    assert.equal(isAlarmingVerdict("ok"), false);
    assert.equal(isAlarmingVerdict("degraded"), false);
    assert.equal(isAlarmingVerdict("alarm-unreachable"), true);
  });
});

describe("shouldSendStudioLivenessAlarm — 1 e-mail por streak, não por check", () => {
  it("1ª vez que cruza o limiar → deve enviar", () => {
    const state = emptyStudioLivenessAlarmState();
    const { evaluation } = recordStudioHttpCheck({ consecutiveFailures: 1, alarmedThisStreak: false }, "failure");
    assert.equal(shouldSendStudioLivenessAlarm(evaluation, state), true);
  });

  it("verdict degraded (abaixo do limiar) nunca dispara envio", () => {
    const state = emptyStudioLivenessAlarmState();
    const { evaluation } = recordStudioHttpCheck(state, "failure");
    assert.equal(shouldSendStudioLivenessAlarm(evaluation, state), false);
  });

  it("streak já alarmado → não reenvia enquanto o streak continuar", () => {
    const alreadyAlarmed: StudioLivenessAlarmState = { consecutiveFailures: 2, alarmedThisStreak: true };
    const { evaluation } = recordStudioHttpCheck(alreadyAlarmed, "failure");
    assert.equal(evaluation.verdict, "alarm-unreachable");
    assert.equal(shouldSendStudioLivenessAlarm(evaluation, alreadyAlarmed), false);
  });

  it("markStudioLivenessAlarmed marca o streak como alarmado sem alterar consecutiveFailures", () => {
    const state: StudioLivenessAlarmState = { consecutiveFailures: 2, alarmedThisStreak: false };
    const marked = markStudioLivenessAlarmed(state);
    assert.deepEqual(marked, { consecutiveFailures: 2, alarmedThisStreak: true });
  });

  it("recuperação ('ok') reseta alarmedThisStreak — próxima queda dispara e-mail de novo", () => {
    const alreadyAlarmed: StudioLivenessAlarmState = { consecutiveFailures: 3, alarmedThisStreak: true };
    const { nextState, evaluation } = recordStudioHttpCheck(alreadyAlarmed, "ok");
    assert.equal(nextState.alarmedThisStreak, false);
    assert.equal(evaluation.verdict, "ok");
    // Nova queda depois da recuperação: streak reseta, 1ª falha ainda não alarma...
    const afterOneFailure = recordStudioHttpCheck(nextState, "failure");
    assert.equal(shouldSendStudioLivenessAlarm(afterOneFailure.evaluation, nextState), false);
    // ...mas a 2ª falha consecutiva do NOVO streak dispara de novo.
    const afterTwoFailures = recordStudioHttpCheck(afterOneFailure.nextState, "failure");
    assert.equal(
      shouldSendStudioLivenessAlarm(afterTwoFailures.evaluation, afterOneFailure.nextState),
      true,
    );
  });
});

describe("buildStudioLivenessAlarmEmail", () => {
  it("subject reporta o número de falhas consecutivas; body cita a issue nº 5759 e o guard de não-mutação", () => {
    const { evaluation } = replay(["failure", "failure"]);
    const { subject, body } = buildStudioLivenessAlarmEmail(evaluation, "");
    assert.match(subject, /2 falhas consecutivas/);
    assert.match(body, /#5759/);
    assert.match(body, /nunca muta o serviço/);
    assert.match(body, /127\.0\.0\.1:4174/);
  });

  it("anexa issueLine quando fornecido", () => {
    const { evaluation } = replay(["failure", "failure"]);
    const { body } = buildStudioLivenessAlarmEmail(evaluation, "\n\nIssues:\n  - #123 (https://...)");
    assert.match(body, /#123/);
  });
});

describe("toAlarmFinding — family/priority/fingerprint", () => {
  it("family é sempre 'estado' (condição re-checável a cada sweep — some quando o operador conserta)", () => {
    const { evaluation } = replay(["failure", "failure"]);
    assert.equal(toAlarmFinding(evaluation).family, "estado");
  });

  it("fingerprint é estável (não inclui a contagem de falhas) — mesmo achado durante todo o streak", () => {
    const twoFailures = replay(["failure", "failure"]).evaluation;
    const fourFailures = replay(["failure", "failure", "failure", "failure"]).evaluation;
    assert.equal(toAlarmFinding(twoFailures).fingerprint, toAlarmFinding(fourFailures).fingerprint);
  });

  it("check é 'studio-liveness', priority P1", () => {
    const { evaluation } = replay(["failure", "failure"]);
    const finding = toAlarmFinding(evaluation);
    assert.equal(finding.check, "studio-liveness");
    assert.equal(finding.priority, "P1");
  });
});
