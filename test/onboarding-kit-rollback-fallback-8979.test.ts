/**
 * test/onboarding-kit-rollback-fallback-8979.test.ts (#8979)
 *
 * Regressão do achado do review consolidado 260928c (origem PR #8966):
 * `filterBrevoPlanForKitCutover` era passagem livre byte a byte quando
 * `onboarding.kit_transport.enabled=false` (rollback) — mesmo pra uma
 * entrada que já tinha recebido e-mail 1/2 por um LOTE KIT (gravado só em
 * `store.kit_transport.lots`, sem tocar `email{1,2}_sent_at`). O executor
 * Brevo reenviaria o mesmo e-mail. `docs/onboarding-kit-cutover.md` §6.3
 * proíbe esse fallback cego e aponta `findKitLotForEntry` como a consulta
 * certa — este teste cobre a mecanização dessa checagem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRunPlan, filterBrevoPlanForKitCutover, type RunPlanResult } from "../scripts/lib/onboarding-state.ts";
import type { OnboardingEntry } from "../scripts/lib/onboarding-store.ts";
import type { OnboardingKitLot, OnboardingKitLotStatus } from "../scripts/lib/onboarding-kit-transport.ts";

const DAY = 86_400;
const T0 = 1_755_000_000;

function entry(over: Partial<OnboardingEntry> = {}): OnboardingEntry {
  return {
    subscription_id: "sub-1",
    email: "novo@example.com",
    status_detectado: "active",
    created_at: T0,
    detected_at: new Date(T0 * 1000).toISOString(),
    email1_sent_at: null,
    email1_brevo_id: null,
    email2_sent_at: null,
    email2_brevo_id: null,
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
    ...over,
  };
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

const sendable = (numero: 1 | 2 | 3) => ({
  numero,
  assunto: `Assunto ${numero}`,
  previewText: "preview",
  body: "<p>corpo</p>",
  hasPendingMarker: false,
});

function kitLot(over: Partial<OnboardingKitLot> & { status: OnboardingKitLotStatus }): OnboardingKitLot {
  return {
    lot_id: "email2-2026-09-28-01",
    kind: "email2",
    tag_name: "onboarding-email2-2026-09-28",
    tag_id: 123,
    broadcast_id: 456,
    recipient_subscription_ids: ["sub-1"],
    recipient_emails: ["novo@example.com"],
    created_at: iso(T0),
    send_at: null,
    last_reconciled_at: null,
    last_error: null,
    ...over,
  };
}

function actionsSummary(plan: RunPlanResult) {
  return plan.actions.map((a) => (a.kind === "email3_campaign" ? { kind: a.kind, n: a.entries.length } : { kind: a.kind, email: a.entry.email }));
}

function planPara(e: OnboardingEntry) {
  return buildRunPlan({
    entries: [e],
    statsById: {},
    nowSec: T0 + 3 * DAY,
    email2Days: 3,
    email3Days: 10,
    email3GraceDays: 10,
    snippets: { 1: sendable(1), 2: sendable(2), 3: sendable(3) },
  });
}

describe("filterBrevoPlanForKitCutover — rollback do cutover Kit não reenvia por cima de lote Kit existente (#8979)", () => {
  it("switch DESLIGADO + entrada com lote Kit `completed` de email2 e email2_sent_at==null — Brevo NÃO envia email2", () => {
    const e = entry({
      email1_sent_at: iso(T0),
      email1_brevo_id: "brevo-msg-1", // começou na Brevo — sem o guard, seria elegível
      email2_sent_at: null,
    });
    const plan = planPara(e);
    // pré-condição: sem o lote Kit, a Brevo processaria email2 normalmente.
    assert.deepEqual(actionsSummary(plan), [{ kind: "email2", email: "novo@example.com" }]);

    const lots = [kitLot({ status: "completed" })];
    const filtered = filterBrevoPlanForKitCutover(plan, false, lots);

    assert.deepEqual(filtered.actions, [], "email2 não deve sobrar pro executor Brevo — já foi servido pelo Kit");
    const skip = filtered.skips.find((s) => s.motivo === "kit_lot_existente");
    assert.ok(skip, "skip kit_lot_existente esperado");
    assert.equal(skip!.etapa, "email2");
    assert.equal(skip!.entry.email, "novo@example.com");
  });

  it("switch DESLIGADO + entrada SEM lote Kit nenhum — Brevo processa normalmente (passagem livre continua valendo)", () => {
    const e = entry({
      email1_sent_at: iso(T0),
      email1_brevo_id: "brevo-msg-1",
      email2_sent_at: null,
    });
    const plan = planPara(e);
    const filtered = filterBrevoPlanForKitCutover(plan, false, []);
    assert.deepEqual(actionsSummary(filtered), [{ kind: "email2", email: "novo@example.com" }]);
    assert.equal(filtered.skips.some((s) => s.motivo === "kit_lot_existente"), false);
  });

  it("switch DESLIGADO + lote Kit CANCELADO para a mesma etapa — Brevo pode enviar (cancelamento não bloqueia)", () => {
    const e = entry({
      email1_sent_at: iso(T0),
      email1_brevo_id: "brevo-msg-1",
      email2_sent_at: null,
    });
    const plan = planPara(e);
    const lots = [kitLot({ status: "cancelled" })];
    const filtered = filterBrevoPlanForKitCutover(plan, false, lots);
    assert.deepEqual(actionsSummary(filtered), [{ kind: "email2", email: "novo@example.com" }], "lote cancelado nunca bloqueia a Brevo");
    assert.equal(filtered.skips.some((s) => s.motivo === "kit_lot_existente"), false);
  });

  it("switch LIGADO + lote Kit `scheduled` para a etapa — guard de lote Kit vale independente do #8966 (esta entrada começou na Brevo, o #8966 sozinho DEIXARIA passar)", () => {
    const e = entry({
      email1_sent_at: iso(T0),
      email1_brevo_id: "brevo-msg-1", // começou na Brevo — ownerTransportFor devolveria "brevo", o guard #8966 deixaria passar
      email2_sent_at: null,
    });
    const plan = planPara(e);
    const lots = [kitLot({ status: "scheduled" })];
    const filtered = filterBrevoPlanForKitCutover(plan, true, lots);
    assert.deepEqual(filtered.actions, [], "o guard de lote Kit (#8979) bloqueia mesmo quando #8966 sozinho deixaria a ação passar");
    assert.ok(filtered.skips.find((s) => s.motivo === "kit_lot_existente"));
  });
});
