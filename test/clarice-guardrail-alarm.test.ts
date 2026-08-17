/**
 * #4064: alarme de guardrail furado do ramp Clarice (parte 1 — só alarme,
 * sem trava). Cobre a lógica PURA de `scripts/lib/clarice-guardrail-alarm.ts`:
 * adapter pra reuso de `evaluateArmGuardrails` (thresholds.ts, sem
 * reimplementar limiar), janela de 10h (#4475, eram 6h originalmente), idempotência, e o texto do e-mail
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
import { toAlarmFinding } from "../scripts/clarice-guardrail-alarm.ts";

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

test("evaluateSendGuardrails — #5166: abertura NUNCA gatilha, mesmo no caso real #4061 (11,1%, limiar 15%) — bounce/unsub/spam saudáveis ⇒ anyBreach=false", () => {
  // Regressão do #5166: campanha com abertura baixa + risco de ISP saudável
  // ⇒ anyBreach=false. Decisão do editor #4705/#5025 tirou abertura do freio
  // que decide VOLUME pelo mesmo motivo (fila de 1º envio estruturalmente
  // fria não deveria frear por abertura) — este alarme estava desalinhado.
  // 6600 delivered, abertura 11,1% → uniqueViews ≈ 733; resto do input
  // (mkCampaign default) tem bounce/unsub/spam dentro dos limites.
  const input = mkCampaign({ delivered: 6600, uniqueViews: Math.round(6600 * 0.111) });
  const result = evaluateSendGuardrails(input);
  assert.equal(result.openBreach, false);
  assert.equal(result.anyBreach, false);
  assert.ok(Math.abs(result.openRatePct - 11.1) < 0.1, "openRatePct continua calculado — só deixa de gatilhar");
});

test("evaluateSendGuardrails — #5166: 0% de abertura MADURA (10h) também não gatilha mais — retirado por completo, não só amenizado (#4131 finding 3 superado)", () => {
  const input = mkCampaign({ delivered: 6600, uniqueViews: 0 });
  const result = evaluateSendGuardrails(input);
  assert.equal(result.openRatePct, 0);
  assert.equal(result.openBreach, false);
  assert.equal(result.anyBreach, false);
});

test("evaluateSendGuardrails — #5166: bounce/unsub/spam continuam gatilhando normalmente mesmo com abertura saudável (só abertura foi retirada)", () => {
  const input = mkCampaign({
    delivered: 6600,
    uniqueViews: 1500, // ~22,7% — verde, não deveria influenciar
    unsubscriptions: 250, // 250/6687 ≈ 3,74% — cruza o limiar de 3%
  });
  const result = evaluateSendGuardrails(input);
  assert.equal(result.openBreach, false);
  assert.equal(result.unsubBreach, true);
  assert.equal(result.anyBreach, true);
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

test("isReadyForEvaluation — fronteira exata de 10h (>=, não >) (#4475, eram 6h originalmente)", () => {
  const sentDate = "2026-07-23T00:00:00.000Z";
  const exactly10h = new Date(Date.parse(sentDate) + GUARDRAIL_EVAL_WINDOW_MS);
  const before10h = new Date(Date.parse(sentDate) + GUARDRAIL_EVAL_WINDOW_MS - 1000);
  assert.equal(isReadyForEvaluation(sentDate, exactly10h), true);
  assert.equal(isReadyForEvaluation(sentDate, before10h), false);
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
  // #5166: `evaluateSendGuardrails` nunca mais produz openBreach=true (ver
  // teste dedicado acima), então este teste monta o resultado à mão pra
  // continuar cobrindo a formatação de `describeBreaches` em si — a função
  // segue genérica (útil se um filtro por audiência for adicionado no
  // futuro, opção não descartada pela issue).
  const guardrail = {
    armId: "1",
    openRatePct: 11.1,
    hardBounceRatePct: 0.15,
    bounceRatePct: 0.22,
    unsubRatePct: 0.3,
    spamRatePct: 0,
    openBreach: true,
    bounceBreach: false,
    unsubBreach: false,
    spamBreach: false,
    anyBreach: true,
  };
  const breaches = describeBreaches(guardrail);
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /Abertura 11\.1%/);
  assert.match(breaches[0], /limite: ≥15%/);
});

// #4154, achado do self-review do #4342 (3ª rodada, silent-failure-hunter):
// evaluateArmGuardrails desacoplou spamBreach de thresholds.spamRate.yellow
// (afrouxado de 0,1% pra 0,3%) — usa CTA_SPAM_BREACH_YELLOW_PCT (0,1%) fixo.
// describeBreaches continuava imprimindo thresholds.spamRate.yellow como "o
// limite": pra qualquer complaints entre 0,1% e 0,3%, o e-mail de alarme
// dizia "furou o guardrail" mostrando um limite (0,3%) que o número não
// cruzou — autocontraditório pro editor. Este teste trava o limite CORRETO
// (0,1%) no texto.
test("describeBreaches — spam usa CTA_SPAM_BREACH_YELLOW_PCT (0,1%) no texto, NUNCA thresholds.spamRate.yellow (0,3%) — #4154", () => {
  // 0.15% cruza CTA_SPAM_BREACH_YELLOW_PCT (0,1%) mas fica ABAIXO de
  // thresholds.spamRate.yellow (0,3%) — a faixa exata que expunha o bug.
  const guardrail = evaluateSendGuardrails(mkCampaign({ sent: 10000, complaints: 15, uniqueViews: 2000 }));
  assert.equal(guardrail.spamBreach, true);
  const breaches = describeBreaches(guardrail);
  const spamLine = breaches.find((b) => b.startsWith("Spam"));
  assert.ok(spamLine, "esperava uma linha de Spam entre os breaches");
  assert.match(spamLine!, /0\.150%/);
  assert.match(spamLine!, /limite: <0\.1%/);
  assert.doesNotMatch(spamLine!, /limite: <0\.3%/);
});

// #5166: os testes de buildGuardrailAlarmEmail abaixo usam um input que
// realmente breacha (unsub, não mais abertura) — abertura sozinha não passa
// mais de `evaluateSendGuardrails` com anyBreach=true, então usar o input
// antigo (só abertura baixa) tornaria estes testes um cenário que o CLI
// nunca dispara na prática (buildGuardrailAlarmEmail só é chamado quando
// anyBreach=true).
function mkUnsubBreachInput(): CampaignGuardrailInput {
  return mkCampaign({ delivered: 6600, uniqueViews: Math.round(6600 * 0.111), unsubscriptions: 250 });
}

test("buildGuardrailAlarmEmail — SEMPRE nomeia o próximo envio agendado e o prazo de cancelamento quando existe (requisito explícito da issue)", () => {
  const guardrail = evaluateSendGuardrails(mkUnsubBreachInput());
  const nextScheduled = { name: "envio 9B", scheduledAt: "2026-07-24T09:00:00.000Z" };
  const { subject, body } = buildGuardrailAlarmEmail("envio 8B", guardrail, nextScheduled, NOW);
  assert.match(subject, /envio 8B/);
  assert.match(body, /Unsub/);
  // #5166: abertura aparece como linha de CONTEXTO, nunca como breach.
  assert.match(body, /Abertura: 11\.1% \(contexto/);
  assert.match(body, /envio 9B/);
  assert.match(body, /2026-07-24T09:00:00\.000Z/);
  assert.match(body, /cancele antes de/i);
});

test("buildGuardrailAlarmEmail — sem próximo agendamento, avisa explicitamente (não afirma um prazo inexistente)", () => {
  const guardrail = evaluateSendGuardrails(mkUnsubBreachInput());
  const { body } = buildGuardrailAlarmEmail("envio 8B", guardrail, null, NOW);
  assert.match(body, /Nenhum próximo envio agendado/);
});

test("buildGuardrailAlarmEmail — REGRESSÃO #4935: não afirma que campanha agendada é imutável na Brevo, e orienta cancelamento via API/painel", () => {
  // Correção factual do editor (#4935): campanha agendada NÃO é estado
  // terminal — sempre dá pra cancelar (painel OU API, PUT
  // /emailCampaigns/{id}/status com status "cancel"/"suspended") e recriar.
  // O texto do e-mail é o que o editor lê de verdade sob pressão de tempo —
  // não pode instruir "suspenda MANUALMENTE" como se fosse o único caminho,
  // nem afirmar "IMUTÁVEL (não deleta/desagenda via API)".
  const guardrail = evaluateSendGuardrails(mkUnsubBreachInput());
  const nextScheduled = { name: "envio 9B", scheduledAt: "2026-07-24T09:00:00.000Z" };
  const { body } = buildGuardrailAlarmEmail("envio 8B", guardrail, nextScheduled, NOW);
  assert.match(body, /NÃO é imutável/i);
  assert.doesNotMatch(body, /suspenda MANUALMENTE/i);
  assert.match(body, /PUT \/emailCampaigns\/\{id\}\/status/);
  assert.match(body, /cancel/i);
});

test("buildGuardrailAlarmEmail — #5166: abertura baixa isolada (bounce/unsub/spam saudáveis) nunca aparece como breach no corpo, só como contexto", () => {
  const guardrail = evaluateSendGuardrails(mkCampaign({ delivered: 6600, uniqueViews: Math.round(6600 * 0.111) }));
  assert.equal(guardrail.anyBreach, false); // não dispararia na prática — chamado aqui só pra travar o texto
  const { body } = buildGuardrailAlarmEmail("envio 8B", guardrail, null, NOW);
  assert.doesNotMatch(body, /- Abertura/);
  assert.match(body, /Abertura: 11\.1% \(contexto — não gatilha mais este alarme, #5166\)/);
});

test("buildGuardrailAlarmEmail com issueRef (#5339) — cita o número da issue quando criado/reusado (prova de fumaça do wiring alarm-issues)", () => {
  const guardrail = evaluateSendGuardrails(mkUnsubBreachInput());
  const { body } = buildGuardrailAlarmEmail("envio 8B", guardrail, null, NOW, undefined, {
    issueNumber: 5343,
    url: "https://github.com/vjpixel/diaria-studio/issues/5343",
    action: "created",
  });
  assert.match(body, /Issue: #5343/);
  assert.match(body, /issues\/5343/);
});

test("buildGuardrailAlarmEmail com issueRef — action 'failed' cita o motivo em vez de um número (e-mail nunca perde o achado por falha de gh)", () => {
  const guardrail = evaluateSendGuardrails(mkUnsubBreachInput());
  const { body } = buildGuardrailAlarmEmail("envio 8B", guardrail, null, NOW, undefined, {
    issueNumber: null,
    url: null,
    action: "failed",
    error: "gh não autenticado",
  });
  assert.match(body, /falha ao criar\/reusar \(gh não autenticado\)/);
});

test("buildGuardrailAlarmEmail sem issueRef (undefined) — corpo sai igual ao comportamento pré-#5339, sem quebrar", () => {
  const guardrail = evaluateSendGuardrails(mkUnsubBreachInput());
  const { body } = buildGuardrailAlarmEmail("envio 8B", guardrail, null, NOW);
  assert.doesNotMatch(body, /Issue:/);
});

test("toAlarmFinding — family é sempre 'evento' — campanha só é avaliada 1x, não se auto-resolve (#5558, regressão direta do #5525)", () => {
  const guardrail = evaluateSendGuardrails(mkUnsubBreachInput());
  const finding = toAlarmFinding({ id: 146, name: "Clarice 2607 grupo:novos-260816" }, guardrail);
  assert.equal(finding.family, "evento");
});
