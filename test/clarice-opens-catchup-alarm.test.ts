/**
 * test/clarice-opens-catchup-alarm.test.ts (#4740)
 *
 * Lógica pura do alarme de falha sustentada do catch-up de opens: streak de
 * falhas consecutivas, neutralidade de `not_run`, idempotência (não reenvia
 * o mesmo alarme a cada checagem), re-armamento após recuperação.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  emptyOpensCatchupAlarmState,
  advanceState,
  shouldAlarm,
  markAlarmed,
  buildOpensCatchupAlarmEmail,
  CONSECUTIVE_FAILURE_THRESHOLD,
  type OpensCatchupAlarmState,
} from "../scripts/lib/clarice-opens-catchup-alarm.ts";
import type { OpensCatchupStatus } from "../scripts/lib/extract-opens-catchup-status.ts";
import { loadState, saveState } from "../scripts/clarice-opens-catchup-alarm.ts";

const T0 = new Date("2026-08-07T08:30:00.000Z");
const T1 = new Date("2026-08-08T08:30:00.000Z");
const T2 = new Date("2026-08-09T08:30:00.000Z");

function errorStatus(msg: string): OpensCatchupStatus {
  return { status: "error", error: msg, checked_at: "" };
}
function okStatus(): OpensCatchupStatus {
  return { status: "ok", checked_at: "" };
}
function notRunStatus(): OpensCatchupStatus {
  return { status: "not_run", checked_at: "" };
}

describe("advanceState (#4740)", () => {
  it("erro incrementa o streak", () => {
    const s0 = emptyOpensCatchupAlarmState();
    const s1 = advanceState(s0, errorStatus("timeout"), T0);
    assert.equal(s1.consecutiveFailures, 1);
    assert.equal(s1.lastCheckedAt, T0.toISOString());
  });

  it("not_run é neutro — não soma nem zera o streak", () => {
    const s0: OpensCatchupAlarmState = { consecutiveFailures: 2, lastAlarmedAt: null, lastCheckedAt: T0.toISOString() };
    const s1 = advanceState(s0, notRunStatus(), T1);
    assert.equal(s1.consecutiveFailures, 2, "streak preservado");
    assert.equal(s1.lastCheckedAt, T1.toISOString(), "checked_at ainda atualiza");
  });

  it("ok zera o streak e re-arma (lastAlarmedAt volta a null)", () => {
    const s0: OpensCatchupAlarmState = { consecutiveFailures: 5, lastAlarmedAt: T0.toISOString(), lastCheckedAt: T0.toISOString() };
    const s1 = advanceState(s0, okStatus(), T1);
    assert.equal(s1.consecutiveFailures, 0);
    assert.equal(s1.lastAlarmedAt, null);
  });
});

describe("shouldAlarm (#4740)", () => {
  it("false abaixo do threshold", () => {
    const state: OpensCatchupAlarmState = {
      consecutiveFailures: CONSECUTIVE_FAILURE_THRESHOLD - 1,
      lastAlarmedAt: null,
      lastCheckedAt: null,
    };
    assert.equal(shouldAlarm(state), false);
  });

  it("true ao atingir o threshold, ainda não alarmado", () => {
    const state: OpensCatchupAlarmState = {
      consecutiveFailures: CONSECUTIVE_FAILURE_THRESHOLD,
      lastAlarmedAt: null,
      lastCheckedAt: null,
    };
    assert.equal(shouldAlarm(state), true);
  });

  it("false quando já alarmado pra este streak, mesmo acima do threshold (não reenvia)", () => {
    const state: OpensCatchupAlarmState = {
      consecutiveFailures: CONSECUTIVE_FAILURE_THRESHOLD + 5,
      lastAlarmedAt: T0.toISOString(),
      lastCheckedAt: null,
    };
    assert.equal(shouldAlarm(state), false);
  });

  it("integração: N-1 falhas não alarma, a N-ésima falha alarma", () => {
    let state = emptyOpensCatchupAlarmState();
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD - 1; i++) {
      state = advanceState(state, errorStatus(`falha ${i}`), T0);
      assert.equal(shouldAlarm(state), false, `não deve alarmar na falha ${i + 1}`);
    }
    state = advanceState(state, errorStatus("falha final"), T1);
    assert.equal(shouldAlarm(state), true, `deve alarmar na falha ${CONSECUTIVE_FAILURE_THRESHOLD}`);
  });

  it("re-arma depois de resolver e falhar de novo até o threshold", () => {
    let state = emptyOpensCatchupAlarmState();
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD; i++) {
      state = advanceState(state, errorStatus("falha"), T0);
    }
    assert.equal(shouldAlarm(state), true);
    state = markAlarmed(state, T0);
    assert.equal(shouldAlarm(state), false, "já alarmado, não reenvia");

    // Recupera.
    state = advanceState(state, okStatus(), T1);
    assert.equal(shouldAlarm(state), false, "streak zerado, sem alarme");

    // Falha de novo até o threshold — deve re-alarmar.
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD; i++) {
      state = advanceState(state, errorStatus("nova falha"), T2);
    }
    assert.equal(shouldAlarm(state), true, "novo streak deve re-alarmar");
  });
});

describe("buildOpensCatchupAlarmEmail (#4740)", () => {
  it("assunto e corpo mencionam a contagem do streak e o último erro", () => {
    const state: OpensCatchupAlarmState = {
      consecutiveFailures: CONSECUTIVE_FAILURE_THRESHOLD,
      lastAlarmedAt: null,
      lastCheckedAt: T0.toISOString(),
    };
    const { subject, body } = buildOpensCatchupAlarmEmail(state, "listSentCampaigns rejeitou: 429");
    assert.match(subject, new RegExp(String(CONSECUTIVE_FAILURE_THRESHOLD)));
    assert.match(body, /listSentCampaigns rejeitou: 429/);
    assert.match(body, /fail-soft/);
  });

  it("funciona sem latestError (undefined)", () => {
    const state: OpensCatchupAlarmState = { consecutiveFailures: 3, lastAlarmedAt: null, lastCheckedAt: null };
    const { subject, body } = buildOpensCatchupAlarmEmail(state, undefined);
    assert.ok(subject.length > 0);
    assert.ok(body.length > 0);
  });
});

describe("buildOpensCatchupAlarmEmail com issueRef (#5339) — prova de fumaça do wiring alarm-issues", () => {
  const state: OpensCatchupAlarmState = {
    consecutiveFailures: CONSECUTIVE_FAILURE_THRESHOLD,
    lastAlarmedAt: null,
    lastCheckedAt: T0.toISOString(),
  };

  it("cita o número da issue quando issueRef foi criado/reusado", () => {
    const { body } = buildOpensCatchupAlarmEmail(state, "listSentCampaigns rejeitou: 429", {
      issueNumber: 5344,
      url: "https://github.com/vjpixel/diaria-studio/issues/5344",
      action: "created",
    });
    assert.match(body, /Issue: #5344/);
    assert.match(body, /issues\/5344/);
  });

  it("action 'failed' cita o motivo em vez de um número — e-mail nunca perde o achado por falha de gh", () => {
    const { body } = buildOpensCatchupAlarmEmail(state, undefined, {
      issueNumber: null,
      url: null,
      action: "failed",
      error: "gh não autenticado",
    });
    assert.match(body, /falha ao criar\/reusar \(gh não autenticado\)/);
  });

  it("sem issueRef (undefined) — corpo sai igual ao comportamento pré-#5339, sem quebrar", () => {
    const { body } = buildOpensCatchupAlarmEmail(state, "listSentCampaigns rejeitou: 429");
    assert.doesNotMatch(body, /Issue:/);
  });
});

describe("loadState / saveState (scripts/clarice-opens-catchup-alarm.ts, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "opens-catchup-alarm-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptyOpensCatchupAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state: OpensCatchupAlarmState = {
      consecutiveFailures: CONSECUTIVE_FAILURE_THRESHOLD,
      lastAlarmedAt: T0.toISOString(),
      lastCheckedAt: T1.toISOString(),
    };
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptyOpensCatchupAlarmState());
  });

  it("lastAlarmedAt null é preservado no roundtrip (streak zerado/re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state: OpensCatchupAlarmState = { consecutiveFailures: 0, lastAlarmedAt: null, lastCheckedAt: T0.toISOString() };
    saveState(state, path);
    assert.deepEqual(loadState(path).lastAlarmedAt, null);
  });
});
