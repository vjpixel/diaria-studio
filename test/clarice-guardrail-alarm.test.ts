/**
 * #4064: alarme de guardrail furado do ramp Clarice (parte 1 — só alarme,
 * sem trava). Cobre a lógica PURA de `scripts/lib/clarice-guardrail-alarm.ts`:
 * adapter pra reuso de `evaluateArmGuardrails` (thresholds.ts, sem
 * reimplementar limiar), janela de 6h, idempotência, e o texto do e-mail
 * (precisa nomear o próximo envio agendado + prazo de suspensão).
 *
 * Caso real reproduzido (#4061): envio 8 do braço B fechou com 11,1% de
 * abertura (limiar 15%) — o teste de `evaluateSendGuardrails` abaixo usa
 * esses números exatos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  armMetricsFromCampaign,
  evaluateSendGuardrails,
  isReadyForEvaluation,
  GUARDRAIL_EVAL_WINDOW_MS,
  pickCampaignsPendingEvaluation,
  markEvaluated,
  emptyGuardrailAlarmState,
  resolveNextScheduledSend,
  describeBreaches,
  buildGuardrailAlarmEmail,
  type CampaignGuardrailInput,
  type GuardrailAlarmState,
} from "../scripts/lib/clarice-guardrail-alarm.ts";

const NOW = new Date("2026-07-24T06:00:00.000Z"); // envio 9B saiu 06:00 BRT (09:00 UTC) do dia seguinte no incidente real

function mkCampaign(overrides: Partial<CampaignGuardrailInput> = {}): CampaignGuardrailInput {
  return {
    id: 1,
    name: "Clarice News 2607 envio 8B",
    sentDate: "2026-07-23T09:00:00.000Z", // 06:00 BRT
    sent: 6687,
    delivered: 6600,
    uniqueViews: 1500,
    unsubscriptions: 20,
    complaints: 0,
    hardBounces: 10,
    softBounces: 5,
    ...overrides,
  };
}

test("armMetricsFromCampaign — adapta 1 campanha pro shape ArmMetrics (decisionClicks/uniqueClicks zerados, irrelevantes pra guardrail)", () => {
  const m = armMetricsFromCampaign(mkCampaign());
  assert.equal(m.armId, "1");
  assert.equal(m.label, "Clarice News 2607 envio 8B");
  assert.equal(m.campaignCount, 1);
  assert.equal(m.sent, 6687);
  assert.equal(m.delivered, 6600);
  assert.equal(m.uniqueViews, 1500);
  assert.equal(m.uniqueClicks, 0);
  assert.equal(m.decisionClicks, 0);
});

test("evaluateSendGuardrails — reproduz o caso real #4061: 11,1% de abertura (limiar 15%) → openBreach=true, anyBreach=true", () => {
  // 6600 delivered, abertura 11,1% → uniqueViews ≈ 733.
  const input = mkCampaign({ delivered: 6600, uniqueViews: Math.round(6600 * 0.111) });
  const result = evaluateSendGuardrails(input);
  assert.equal(result.openBreach, true);
  assert.equal(result.anyBreach, true);
  assert.ok(Math.abs(result.openRatePct - 11.1) < 0.1);
});

test("evaluateSendGuardrails — envio saudável (tudo dentro dos limites) → anyBreach=false", () => {
  const input = mkCampaign({
    delivered: 1000,
    uniqueViews: 200, // 20% abertura — verde
    sent: 1000,
    hardBounces: 2, // 0.2% — verde
    softBounces: 1,
    unsubscriptions: 2, // 0.2% — verde
    complaints: 0,
  });
  const result = evaluateSendGuardrails(input);
  assert.equal(result.anyBreach, false);
});

test("isReadyForEvaluation — fronteira exata de 6h (>=, não >)", () => {
  const sentDate = "2026-07-23T00:00:00.000Z";
  const exactly6h = new Date(Date.parse(sentDate) + GUARDRAIL_EVAL_WINDOW_MS);
  const before6h = new Date(Date.parse(sentDate) + GUARDRAIL_EVAL_WINDOW_MS - 1000);
  assert.equal(isReadyForEvaluation(sentDate, exactly6h), true);
  assert.equal(isReadyForEvaluation(sentDate, before6h), false);
});

test("isReadyForEvaluation — sentDate não-parseável → false (nunca lança)", () => {
  assert.equal(isReadyForEvaluation("não-é-data", NOW), false);
});

test("pickCampaignsPendingEvaluation — só retorna campanhas que cruzaram a janela E ainda não foram avaliadas (idempotência)", () => {
  const now = new Date("2026-07-24T00:00:00.000Z");
  const campaigns = [
    { id: 1, sentDate: "2026-07-23T00:00:00.000Z" }, // 24h atrás — pronta
    { id: 2, sentDate: "2026-07-23T23:00:00.000Z" }, // 1h atrás — ainda não
    { id: 3, sentDate: "2026-07-22T00:00:00.000Z" }, // pronta, mas já avaliada
  ];
  const state: GuardrailAlarmState = { evaluated: ["3"] };
  const pending = pickCampaignsPendingEvaluation(campaigns, state, now);
  assert.deepEqual(pending.map((c) => c.id), [1]);
});

test("markEvaluated — idempotente (não duplica ao marcar 2x)", () => {
  let state = emptyGuardrailAlarmState();
  state = markEvaluated(state, 1);
  state = markEvaluated(state, 1);
  assert.deepEqual(state.evaluated, ["1"]);
});

test("resolveNextScheduledSend — pega o próximo agendamento FUTURO mais próximo, ignora passados/inválidos", () => {
  const now = new Date("2026-07-24T06:00:00.000Z");
  const scheduled = [
    { name: "envio 10 (passado, não deveria contar)", scheduledAt: "2026-07-20T09:00:00.000Z" },
    { name: "envio 12 (mais distante)", scheduledAt: "2026-07-26T09:00:00.000Z" },
    { name: "envio 11 (o próximo de verdade)", scheduledAt: "2026-07-25T09:00:00.000Z" },
    { name: "sem data", scheduledAt: null },
  ];
  const next = resolveNextScheduledSend(scheduled, now);
  assert.deepEqual(next, { name: "envio 11 (o próximo de verdade)", scheduledAt: "2026-07-25T09:00:00.000Z" });
});

test("resolveNextScheduledSend — sem nenhum agendamento futuro → null", () => {
  const now = new Date("2026-07-24T06:00:00.000Z");
  assert.equal(resolveNextScheduledSend([{ name: "x", scheduledAt: "2020-01-01T00:00:00Z" }], now), null);
  assert.equal(resolveNextScheduledSend([], now), null);
});

test("describeBreaches — só lista as métricas que romperam, com o valor E o limiar do doc (sem reimplementar limiar)", () => {
  const guardrail = evaluateSendGuardrails(mkCampaign({ delivered: 6600, uniqueViews: Math.round(6600 * 0.111) }));
  const breaches = describeBreaches(guardrail);
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /Abertura 11\.1%/);
  assert.match(breaches[0], /limite: ≥15%/);
});

test("buildGuardrailAlarmEmail — SEMPRE nomeia o próximo envio agendado e o prazo de suspensão quando existe (requisito explícito da issue)", () => {
  const guardrail = evaluateSendGuardrails(mkCampaign({ delivered: 6600, uniqueViews: Math.round(6600 * 0.111) }));
  const nextScheduled = { name: "envio 9B", scheduledAt: "2026-07-24T09:00:00.000Z" };
  const { subject, body } = buildGuardrailAlarmEmail("envio 8B", guardrail, nextScheduled, NOW);
  assert.match(subject, /envio 8B/);
  assert.match(body, /Abertura 11\.1%/);
  assert.match(body, /envio 9B/);
  assert.match(body, /2026-07-24T09:00:00\.000Z/);
  assert.match(body, /imutável/i);
});

test("buildGuardrailAlarmEmail — sem próximo agendamento, avisa explicitamente (não afirma um prazo inexistente)", () => {
  const guardrail = evaluateSendGuardrails(mkCampaign({ delivered: 6600, uniqueViews: Math.round(6600 * 0.111) }));
  const { body } = buildGuardrailAlarmEmail("envio 8B", guardrail, null, NOW);
  assert.match(body, /Nenhum próximo envio agendado/);
});
