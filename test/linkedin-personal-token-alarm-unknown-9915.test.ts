/**
 * test/linkedin-personal-token-alarm-unknown-9915.test.ts
 *
 * #9915: com `CLOSE_AFTER_RUNS = 1`, uma checagem remota INDETERMINADA
 * (`remote.state === "unknown"`: timeout, 5xx, rede) fazia `evaluateTokenExpiry`
 * cair na faixa de expiração (`null` com `EXPIRES_AT` > 14 dias) e o alarme
 * fechava a issue P1 "token revogado" como resolvida — o token seguia
 * revogado e a issue reabria na execução seguinte. Agora, `unknown` + issue
 * aberta de revogado = reconciliação congelada daquele fingerprint.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LINKEDIN_PERSONAL_ENV,
  REVOKED_REASON,
  TOKEN_ALARM_CHECK,
  TOKEN_ALARM_FINGERPRINT,
  evaluateTokenExpiry,
  tokenAlarmFreezeOnUnknownRemote,
  type TokenRemoteState,
} from "../scripts/lib/linkedin-personal.ts";
import { alarmIssueStateKey, planAlarmReconciliation, type AlarmIssuesState } from "../scripts/lib/alarm-issues.ts";
import { CLOSE_AFTER_RUNS } from "../scripts/linkedin-personal-token-alarm.ts";

const ENV = {
  [LINKEDIN_PERSONAL_ENV.accessToken]: "tok-secreto",
  [LINKEDIN_PERSONAL_ENV.personUrn]: "urn:li:person:AbC123_x",
  [LINKEDIN_PERSONAL_ENV.expiresAt]: "2099-01-01T00:00:00.000Z",
};
const NOW = new Date("2030-10-01T12:00:00Z");
const KEY = alarmIssueStateKey(TOKEN_ALARM_CHECK, TOKEN_ALARM_FINGERPRINT);
const UNKNOWN: TokenRemoteState = { state: "unknown", reason: "timeout" };
const REVOKED: TokenRemoteState = { state: "revoked", reason: REVOKED_REASON };

function stateWith(contentSignature: string, closedAt: string | null = null): AlarmIssuesState {
  return {
    [KEY]: { issueNumber: 4242, url: "https://github.com/x/y/issues/4242", missingStreak: 0, closedAt, family: "estado", contentSignature },
  };
}

/** O que o alarme faz numa execução — mesma composição de `main()`. */
function plan(remote: TokenRemoteState, state: AlarmIssuesState) {
  const f = evaluateTokenExpiry(ENV, NOW, remote);
  return planAlarmReconciliation(f ? [f] : [], state, CLOSE_AFTER_RUNS, tokenAlarmFreezeOnUnknownRemote(remote, state));
}

describe("#9915 — checagem indeterminada não fecha issue de token revogado", () => {
  it("premissa: o alarme fecha após 1 execução limpa e `unknown` cai na faixa de expiração (null)", () => {
    assert.equal(CLOSE_AFTER_RUNS, 1);
    assert.equal(evaluateTokenExpiry(ENV, NOW, UNKNOWN), null);
  });

  it("regressão: `revoked` seguido de `unknown` não fecha nem comenta resolvido", () => {
    const actions = plan(UNKNOWN, stateWith("revoked"));
    assert.deepEqual(actions, [], "nenhuma ação sobre a issue de revogado");
  });

  it("dia N → N+1 (timeout) → N+2 (401): a issue nunca fecha no meio", () => {
    const n = plan(REVOKED, {});
    assert.deepEqual(n.map((a) => a.kind), ["ensure"]);
    const n1 = plan(UNKNOWN, stateWith("revoked"));
    assert.ok(!n1.some((a) => a.kind === "close" || a.kind === "comment_resolved"));
    const n2 = plan(REVOKED, stateWith("revoked"));
    assert.deepEqual(n2.map((a) => a.kind), ["ensure"]);
  });

  it("`unknown` não rebaixa a issue de revogado pra uma faixa de expiração", () => {
    const envPerto = { ...ENV, [LINKEDIN_PERSONAL_ENV.expiresAt]: new Date(NOW.getTime() + 5 * 86_400_000).toISOString() };
    const f = evaluateTokenExpiry(envPerto, NOW, UNKNOWN)!;
    assert.equal(f.contentSignature, "warn");
    const state = stateWith("revoked");
    const actions = planAlarmReconciliation([f], state, CLOSE_AFTER_RUNS, tokenAlarmFreezeOnUnknownRemote(UNKNOWN, state));
    assert.deepEqual(actions, []);
  });

  it("controle: remoto `valid` com token renovado continua fechando a issue de revogado", () => {
    const actions = plan({ state: "valid" }, stateWith("revoked"));
    assert.deepEqual(actions.map((a) => a.kind), ["close"]);
  });

  it("`unknown` não congela issue de EXPIRAÇÃO — essa se decide só com EXPIRES_AT", () => {
    assert.deepEqual(tokenAlarmFreezeOnUnknownRemote(UNKNOWN, stateWith("warn")), []);
    assert.deepEqual(plan(UNKNOWN, stateWith("warn")).map((a) => a.kind), ["close"]);
  });

  it("sem issue aberta (ausente ou já fechada) não há o que congelar", () => {
    assert.deepEqual(tokenAlarmFreezeOnUnknownRemote(UNKNOWN, {}), []);
    assert.deepEqual(tokenAlarmFreezeOnUnknownRemote(UNKNOWN, stateWith("revoked", "2030-09-30T00:00:00Z")), []);
    assert.deepEqual(tokenAlarmFreezeOnUnknownRemote(null, stateWith("revoked")), []);
  });
});
