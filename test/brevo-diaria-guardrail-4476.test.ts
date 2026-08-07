/**
 * test/brevo-diaria-guardrail-4476.test.ts (#4476 item 9 — "Circuit breakers
 * de campanha")
 *
 * Cobre `scripts/lib/brevo-diaria-guardrail.ts`: agregação de N campanhas,
 * reuso dos MESMOS limiares do ramp Clarice (abertura <15%, bounce duro ≥2%,
 * bounce total ≥5%, spam ≥0,1% via CTA_SPAM_BREACH_YELLOW_PCT, unsub ≥3%),
 * a regra "abertura nunca pausa sozinha" (issue: cohort fria, esperado), e o
 * latch de estado (pausa até `--unpause` explícito, nunca despausa sozinho).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateBrevoDiariaCampaignStats,
  evaluateBrevoDiariaRolloutGuardrail,
  shouldPauseRollout,
  applyGuardrailCheck,
  unpauseRollout,
  emptyRolloutGuardrailState,
  readRolloutGuardrailState,
  writeRolloutGuardrailState,
  describeBreaches,
  type CampaignGuardrailInput,
  type RolloutGuardrailState,
} from "../scripts/lib/brevo-diaria-guardrail.ts";

function mkCampaign(overrides: Partial<CampaignGuardrailInput> = {}): CampaignGuardrailInput {
  return {
    id: 1,
    name: "brevo_diaria envio 1",
    sentDate: "2026-08-01T09:00:00.000Z",
    sent: 100,
    delivered: 100,
    uniqueViews: 20, // 20% — verde
    unsubscriptions: 1, // 1% — verde
    complaints: 0,
    hardBounces: 1, // 1% — verde
    softBounces: 0,
    ...overrides,
  };
}

// ─── aggregateBrevoDiariaCampaignStats ─────────────────────────────────────

test("aggregateBrevoDiariaCampaignStats — soma os contadores brutos de N campanhas", () => {
  const agg = aggregateBrevoDiariaCampaignStats([
    mkCampaign({ id: 1, sent: 100, delivered: 100, uniqueViews: 20, hardBounces: 1 }),
    mkCampaign({ id: 2, sent: 50, delivered: 48, uniqueViews: 10, hardBounces: 0 }),
  ]);
  assert.equal(agg.campaignCount, 2);
  assert.equal(agg.sent, 150);
  assert.equal(agg.delivered, 148);
  assert.equal(agg.uniqueViews, 30);
  assert.equal(agg.hardBounces, 1);
});

test("aggregateBrevoDiariaCampaignStats — lista vazia → tudo zerado, campaignCount 0", () => {
  const agg = aggregateBrevoDiariaCampaignStats([]);
  assert.equal(agg.campaignCount, 0);
  assert.equal(agg.sent, 0);
  assert.equal(agg.delivered, 0);
});

// ─── evaluateBrevoDiariaRolloutGuardrail ───────────────────────────────────

test("evaluateBrevoDiariaRolloutGuardrail — sem campanhas → null (sem dado suficiente pra decidir)", () => {
  assert.equal(evaluateBrevoDiariaRolloutGuardrail([]), null);
});

test("evaluateBrevoDiariaRolloutGuardrail — envio saudável agregado → anyBreach=false", () => {
  const evaluation = evaluateBrevoDiariaRolloutGuardrail([mkCampaign()]);
  assert.ok(evaluation);
  assert.equal(evaluation!.campaignCount, 1);
  assert.equal(evaluation!.result.anyBreach, false);
});

test("evaluateBrevoDiariaRolloutGuardrail — mesmos limiares do ramp Clarice (abertura <15%, bounce duro ≥2%, bounce total ≥5%, unsub ≥3%, spam ≥0,1%)", () => {
  const openBreach = evaluateBrevoDiariaRolloutGuardrail([
    mkCampaign({ delivered: 1000, uniqueViews: 100 }), // 10% < 15%
  ]);
  assert.equal(openBreach!.result.openBreach, true);

  const hardBounceBreach = evaluateBrevoDiariaRolloutGuardrail([
    mkCampaign({ sent: 1000, hardBounces: 20, softBounces: 0 }), // 2% >= 2%
  ]);
  assert.equal(hardBounceBreach!.result.bounceBreach, true);

  const totalBounceBreach = evaluateBrevoDiariaRolloutGuardrail([
    mkCampaign({ sent: 1000, hardBounces: 10, softBounces: 40 }), // 5% total >= 5%, hard 1% < 2%
  ]);
  assert.equal(totalBounceBreach!.result.bounceBreach, true);
  assert.equal(totalBounceBreach!.result.hardBounceRatePct < 2, true);

  const unsubBreach = evaluateBrevoDiariaRolloutGuardrail([
    mkCampaign({ sent: 1000, unsubscriptions: 30 }), // 3% >= 3%
  ]);
  assert.equal(unsubBreach!.result.unsubBreach, true);

  // #4154: spam usa CTA_SPAM_BREACH_YELLOW_PCT (0,1%), NÃO
  // DEFAULT_HEALTH_THRESHOLDS.spamRate.yellow (0,3%) — 0,15% cruza o
  // primeiro mas fica abaixo do 2º, a faixa exata que expunha aquele bug.
  const spamBreach = evaluateBrevoDiariaRolloutGuardrail([
    mkCampaign({ sent: 10000, complaints: 15 }), // 0.15%
  ]);
  assert.equal(spamBreach!.result.spamBreach, true);
});

test("evaluateBrevoDiariaRolloutGuardrail — treatZeroAsBreach: 0% de abertura agregada é sinal real (não 'ainda propagando')", () => {
  const evaluation = evaluateBrevoDiariaRolloutGuardrail([mkCampaign({ delivered: 100, uniqueViews: 0 })]);
  assert.equal(evaluation!.result.openBreach, true);
});

// ─── shouldPauseRollout — regra central da issue: abertura NUNCA pausa sozinha ─

test("shouldPauseRollout — só abertura furada (cohort fria) → false, NÃO pausa (issue: 'não é fracasso, é informação')", () => {
  const evaluation = evaluateBrevoDiariaRolloutGuardrail([mkCampaign({ delivered: 1000, uniqueViews: 50 })]); // 5% abertura
  assert.equal(evaluation!.result.openBreach, true);
  assert.equal(evaluation!.result.bounceBreach, false);
  assert.equal(shouldPauseRollout(evaluation!.result), false);
});

test("shouldPauseRollout — bounce furado → true, pausa", () => {
  const evaluation = evaluateBrevoDiariaRolloutGuardrail([mkCampaign({ sent: 1000, hardBounces: 25 })]);
  assert.equal(shouldPauseRollout(evaluation!.result), true);
});

test("shouldPauseRollout — spam furado → true, pausa", () => {
  const evaluation = evaluateBrevoDiariaRolloutGuardrail([mkCampaign({ sent: 10000, complaints: 20 })]);
  assert.equal(shouldPauseRollout(evaluation!.result), true);
});

test("shouldPauseRollout — unsub furado → true, pausa", () => {
  const evaluation = evaluateBrevoDiariaRolloutGuardrail([mkCampaign({ sent: 1000, unsubscriptions: 40 })]);
  assert.equal(shouldPauseRollout(evaluation!.result), true);
});

test("shouldPauseRollout — saudável → false", () => {
  const evaluation = evaluateBrevoDiariaRolloutGuardrail([mkCampaign()]);
  assert.equal(shouldPauseRollout(evaluation!.result), false);
});

// ─── applyGuardrailCheck — latch (pausa até --unpause explícito) ──────────

const NOW = new Date("2026-08-06T12:00:00.000Z");

test("applyGuardrailCheck — sem dado (null) → só atualiza last_checked_at, nunca pausa/despausa", () => {
  const state = emptyRolloutGuardrailState();
  const next = applyGuardrailCheck(state, null, NOW);
  assert.equal(next.rollout_paused, false);
  assert.equal(next.last_checked_at, NOW.toISOString());
  assert.equal(next.last_campaign_count, 0);
});

test("applyGuardrailCheck — resultado saudável, estado despausado → permanece despausado", () => {
  const state = emptyRolloutGuardrailState();
  const evaluation = evaluateBrevoDiariaRolloutGuardrail([mkCampaign()]);
  const next = applyGuardrailCheck(state, evaluation, NOW);
  assert.equal(next.rollout_paused, false);
  assert.equal(next.last_campaign_count, 1);
});

test("applyGuardrailCheck — bounce furado, estado despausado → PAUSA, grava paused_at/paused_reason", () => {
  const state = emptyRolloutGuardrailState();
  const evaluation = evaluateBrevoDiariaRolloutGuardrail([mkCampaign({ sent: 1000, hardBounces: 25 })]);
  const next = applyGuardrailCheck(state, evaluation, NOW);
  assert.equal(next.rollout_paused, true);
  assert.equal(next.paused_at, NOW.toISOString());
  assert.ok(next.paused_reason && next.paused_reason.length > 0);
  assert.match(next.paused_reason![0], /Bounce/);
});

test("applyGuardrailCheck — só abertura furada, estado despausado → NÃO pausa (regra central da issue)", () => {
  const state = emptyRolloutGuardrailState();
  const evaluation = evaluateBrevoDiariaRolloutGuardrail([mkCampaign({ delivered: 1000, uniqueViews: 50 })]);
  const next = applyGuardrailCheck(state, evaluation, NOW);
  assert.equal(next.rollout_paused, false);
});

test("applyGuardrailCheck — LATCH: já pausado + resultado SAUDÁVEL na checagem seguinte → permanece pausado (issue: 'até o editor decidir')", () => {
  const pausedState: RolloutGuardrailState = {
    rollout_paused: true,
    paused_at: "2026-08-05T09:00:00.000Z",
    paused_reason: ["Bounce — hard 2.5% (limite: <2%)"],
    last_checked_at: "2026-08-05T09:00:00.000Z",
    last_campaign_count: 1,
    unpaused_at: null,
  };
  const healthyEvaluation = evaluateBrevoDiariaRolloutGuardrail([mkCampaign()]); // tudo verde agora
  const next = applyGuardrailCheck(pausedState, healthyEvaluation, NOW);
  assert.equal(next.rollout_paused, true, "não deveria despausar sozinho");
  assert.equal(next.paused_at, "2026-08-05T09:00:00.000Z", "paused_at original preservado");
  assert.deepEqual(next.paused_reason, ["Bounce — hard 2.5% (limite: <2%)"], "motivo original preservado");
  assert.equal(next.last_checked_at, NOW.toISOString(), "last_checked_at atualiza mesmo pausado");
});

test("unpauseRollout — limpa o latch explicitamente (única forma de despausar)", () => {
  const pausedState: RolloutGuardrailState = {
    rollout_paused: true,
    paused_at: "2026-08-05T09:00:00.000Z",
    paused_reason: ["Bounce — hard 2.5% (limite: <2%)"],
    last_checked_at: "2026-08-05T09:00:00.000Z",
    last_campaign_count: 1,
    unpaused_at: null,
  };
  const next = unpauseRollout(pausedState, NOW);
  assert.equal(next.rollout_paused, false);
  assert.equal(next.paused_at, null);
  assert.equal(next.paused_reason, null);
  assert.equal(next.last_checked_at, NOW.toISOString());
});

test("unpauseRollout — grava unpaused_at (achado de self-review: sem isso o próximo recheck re-pausa sozinho sobre dado antigo)", () => {
  const pausedState: RolloutGuardrailState = {
    rollout_paused: true,
    paused_at: "2026-08-05T09:00:00.000Z",
    paused_reason: ["Bounce — hard 2.5% (limite: <2%)"],
    last_checked_at: "2026-08-05T09:00:00.000Z",
    last_campaign_count: 1,
    unpaused_at: null,
  };
  const next = unpauseRollout(pausedState, NOW);
  assert.equal(next.unpaused_at, NOW.toISOString());
});

// ─── evaluateBrevoDiariaRolloutGuardrail — sentAfter (janela pós-unpause) ──

test("evaluateBrevoDiariaRolloutGuardrail — sentAfter exclui campanhas enviadas ANTES do corte", () => {
  const evaluation = evaluateBrevoDiariaRolloutGuardrail(
    [mkCampaign({ sentDate: "2026-08-05T08:00:00.000Z" })], // antes do corte
    undefined,
    "2026-08-05T09:00:00.000Z",
  );
  assert.equal(evaluation, null, "única campanha é anterior ao corte — sem dado suficiente");
});

test("evaluateBrevoDiariaRolloutGuardrail — sentAfter mantém campanhas enviadas DEPOIS do corte", () => {
  const evaluation = evaluateBrevoDiariaRolloutGuardrail(
    [mkCampaign({ sentDate: "2026-08-05T10:00:00.000Z" })], // depois do corte
    undefined,
    "2026-08-05T09:00:00.000Z",
  );
  assert.ok(evaluation, "campanha posterior ao corte deve contar");
  assert.equal(evaluation!.campaignCount, 1);
});

test("evaluateBrevoDiariaRolloutGuardrail — sentAfter ausente/null agrega tudo sem corte (comportamento anterior preservado)", () => {
  const campaigns = [mkCampaign({ sentDate: "2020-01-01T00:00:00.000Z" })];
  assert.equal(evaluateBrevoDiariaRolloutGuardrail(campaigns, undefined, undefined)!.campaignCount, 1);
  assert.equal(evaluateBrevoDiariaRolloutGuardrail(campaigns, undefined, null)!.campaignCount, 1);
});

test("REGRESSÃO (achado de self-review pós-#4476): unpause seguido de recheck com dado inalterado NÃO re-pausa", () => {
  // 1. Campanha ruim furou bounce → pausa.
  const badCampaign = mkCampaign({ id: 1, sentDate: "2026-08-05T09:00:00.000Z", sent: 1000, hardBounces: 25, softBounces: 0 });
  const evaluation1 = evaluateBrevoDiariaRolloutGuardrail([badCampaign]);
  assert.ok(evaluation1 && shouldPauseRollout(evaluation1.result));
  const pausedState = applyGuardrailCheck(emptyRolloutGuardrailState(), evaluation1, NOW);
  assert.equal(pausedState.rollout_paused, true);

  // 2. Editor investiga e roda --unpause.
  const unpausedAt = new Date(NOW.getTime() + 60 * 60 * 1000); // 1h depois
  const unpausedState = unpauseRollout(pausedState, unpausedAt);
  assert.equal(unpausedState.rollout_paused, false);

  // 3. Recheck 4h depois — NENHUMA campanha nova foi enviada (cadência ~diária),
  //    fetchSentCampaigns() ainda devolve a MESMA badCampaign (sentDate ANTES do unpause).
  const recheckAt = new Date(unpausedAt.getTime() + 4 * 60 * 60 * 1000);
  const evaluation2 = evaluateBrevoDiariaRolloutGuardrail([badCampaign], undefined, unpausedState.unpaused_at);
  assert.equal(evaluation2, null, "campanha antiga (pré-unpause) não deve contar — sem dado novo pra decidir");
  const stateAfterRecheck = applyGuardrailCheck(unpausedState, evaluation2, recheckAt);
  assert.equal(stateAfterRecheck.rollout_paused, false, "NÃO deveria re-pausar sozinho sobre o mesmo dado que já causou a pausa original");

  // 4. Uma campanha NOVA e ainda ruim, enviada DEPOIS do unpause, deve
  //    continuar sendo detectada normalmente (a janela não esconde dano real).
  const newBadCampaign = mkCampaign({
    id: 2,
    sentDate: new Date(unpausedAt.getTime() + 30 * 60 * 1000).toISOString(), // 30min pós-unpause
    sent: 1000,
    hardBounces: 25,
    softBounces: 0,
  });
  const evaluation3 = evaluateBrevoDiariaRolloutGuardrail([badCampaign, newBadCampaign], undefined, unpausedState.unpaused_at);
  assert.ok(evaluation3, "campanha nova pós-unpause deve produzir avaliação");
  assert.equal(evaluation3!.campaignCount, 1, "só a campanha NOVA entra no agregado — a antiga continua fora da janela");
  assert.equal(shouldPauseRollout(evaluation3!.result), true, "campanha nova ruim ainda pausa normalmente");
});

// ─── describeBreaches — reuso, sem duplicar formatação ────────────────────

test("describeBreaches — reusa a mesma função/limiar do alarme do ramp Clarice, sem reimplementar aqui", () => {
  const evaluation = evaluateBrevoDiariaRolloutGuardrail([mkCampaign({ sent: 1000, hardBounces: 25 })]);
  const breaches = describeBreaches(evaluation!.result);
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /Bounce/);
});

// ─── I/O: readRolloutGuardrailState / writeRolloutGuardrailState ──────────

test("readRolloutGuardrailState/writeRolloutGuardrailState — round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "brevo-diaria-guardrail-state-"));
  const path = join(dir, "guardrail-state.json");
  try {
    const state: RolloutGuardrailState = {
      rollout_paused: true,
      paused_at: "2026-08-05T09:00:00.000Z",
      paused_reason: ["Bounce — hard 2.5% (limite: <2%)"],
      last_checked_at: "2026-08-06T09:00:00.000Z",
      last_campaign_count: 3,
      unpaused_at: "2026-08-04T09:00:00.000Z",
    };
    writeRolloutGuardrailState(state, path);
    const read = readRolloutGuardrailState(path);
    assert.deepEqual(read, state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRolloutGuardrailState — arquivo ausente → estado vazio (nunca pausado), nunca lança", () => {
  const dir = mkdtempSync(join(tmpdir(), "brevo-diaria-guardrail-state-missing-"));
  try {
    const state = readRolloutGuardrailState(join(dir, "does-not-exist.json"));
    assert.deepEqual(state, emptyRolloutGuardrailState());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRolloutGuardrailState — arquivo malformado (JSON inválido) → estado vazio (fail-soft, nunca lança) — nunca mascara/trava um estado real por acidente", () => {
  const dir = mkdtempSync(join(tmpdir(), "brevo-diaria-guardrail-state-malformed-"));
  try {
    const path = join(dir, "guardrail-state.json");
    writeFileSync(path, "{ isso não é JSON válido");
    const state = readRolloutGuardrailState(path);
    assert.deepEqual(state, emptyRolloutGuardrailState());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRolloutGuardrailState — rollout_paused ausente/não-booleano → estado vazio (fail-soft)", () => {
  const dir = mkdtempSync(join(tmpdir(), "brevo-diaria-guardrail-state-shape-"));
  try {
    const path = join(dir, "guardrail-state.json");
    writeFileSync(path, JSON.stringify({ rollout_paused: "sim" }));
    const state = readRolloutGuardrailState(path);
    assert.deepEqual(state, emptyRolloutGuardrailState());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRolloutGuardrailState — cria o diretório pai se ainda não existir (1ª execução)", () => {
  const dir = mkdtempSync(join(tmpdir(), "brevo-diaria-guardrail-state-newdir-"));
  try {
    const path = join(dir, "nested", "guardrail-state.json");
    writeRolloutGuardrailState(emptyRolloutGuardrailState(), path);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(raw.rollout_paused, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
