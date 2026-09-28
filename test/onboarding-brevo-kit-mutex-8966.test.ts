/**
 * test/onboarding-brevo-kit-mutex-8966.test.ts (#8966)
 *
 * Guard de mútua-exclusão Brevo x Kit para candidatos NOVOS do onboarding
 * (#7922 §2.4, docs/onboarding-kit-cutover.md). Sem o guard, ligar
 * `onboarding.kit_transport.enabled=true` sem desligar o envio Brevo para
 * candidatos NOVOS faz um assinante que confirma na janela de transição
 * receber o e-mail 1/2 pelos DOIS transportes.
 *
 * Casos cobertos (issue #8966):
 *   1. Kill switch Kit DESLIGADO → plano Brevo intocado (email1 e email2).
 *   2. Kill switch Kit LIGADO + candidato NOVO (sem email1_brevo_id) →
 *      Brevo recusa/skippa email1.
 *   3. Kill switch Kit LIGADO + candidato com email1 já enviado PELA BREVO
 *      (email1_brevo_id preenchido), devido pro email2 → Brevo continua
 *      processando normalmente (entrada iniciada na Brevo termina na Brevo).
 *   4. Kill switch Kit LIGADO + candidato devido pro email2 mas cujo email1
 *      foi servido pelo KIT (email1_sent_at preenchido, email1_brevo_id
 *      null) → Brevo recusa email2 (a escada termina no Kit).
 *   5. email3_campaign nunca é tocado pelo guard (fora de escopo — #8966 só
 *      cobre e-mail 1/2).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRunPlan, filterBrevoPlanForKitCutover, type RunPlanResult } from "../scripts/lib/onboarding-state.ts";
import type { OnboardingEntry } from "../scripts/lib/onboarding-store.ts";

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

function actionsSummary(plan: RunPlanResult) {
  return plan.actions.map((a) => (a.kind === "email3_campaign" ? { kind: a.kind, n: a.entries.length } : { kind: a.kind, email: a.entry.email }));
}

describe("filterBrevoPlanForKitCutover (#8966)", () => {
  it("kill switch DESLIGADO — plano Brevo passa intocado (mesma referência de objeto)", () => {
    const novo = entry();
    const plan = buildRunPlan({
      entries: [novo],
      statsById: {},
      nowSec: T0,
      email2Days: 3,
      email3Days: 10,
      email3GraceDays: 10,
      snippets: { 1: sendable(1), 2: sendable(2), 3: sendable(3) },
    });
    const filtered = filterBrevoPlanForKitCutover(plan, false);
    assert.equal(filtered, plan, "passagem livre deve devolver o MESMO objeto, não uma cópia");
    assert.deepEqual(actionsSummary(filtered), [{ kind: "email1", email: "novo@example.com" }]);
  });

  it("kill switch LIGADO + candidato NOVO — email1 vira skip kit_transport_ativo, nunca ação", () => {
    const novo = entry();
    const plan = buildRunPlan({
      entries: [novo],
      statsById: {},
      nowSec: T0,
      email2Days: 3,
      email3Days: 10,
      email3GraceDays: 10,
      snippets: { 1: sendable(1), 2: sendable(2), 3: sendable(3) },
    });
    const filtered = filterBrevoPlanForKitCutover(plan, true);
    assert.deepEqual(filtered.actions, [], "nenhuma ação email1 deve sobrar pro executor Brevo");
    const skip = filtered.skips.find((s) => s.motivo === "kit_transport_ativo");
    assert.ok(skip, "skip kit_transport_ativo esperado");
    assert.equal(skip!.etapa, "email1");
    assert.equal(skip!.entry.email, "novo@example.com");
  });

  it("kill switch LIGADO + email2 devido, email1 foi da PRÓPRIA Brevo (email1_brevo_id preenchido) — Brevo continua", () => {
    const iniciadoNaBrevo = entry({
      email1_sent_at: iso(T0),
      email1_brevo_id: "brevo-msg-123",
    });
    const plan = buildRunPlan({
      entries: [iniciadoNaBrevo],
      statsById: {},
      nowSec: T0 + 3 * DAY,
      email2Days: 3,
      email3Days: 10,
      email3GraceDays: 10,
      snippets: { 1: sendable(1), 2: sendable(2), 3: sendable(3) },
    });
    const filtered = filterBrevoPlanForKitCutover(plan, true);
    assert.deepEqual(actionsSummary(filtered), [{ kind: "email2", email: "novo@example.com" }]);
    assert.equal(
      filtered.skips.some((s) => s.motivo === "kit_transport_ativo"),
      false,
      "entrada iniciada na Brevo não deve ser skippada pelo guard",
    );
  });

  it("kill switch LIGADO + email2 devido, email1 foi servido pelo KIT (sem email1_brevo_id) — Brevo recusa", () => {
    const iniciadoNoKit = entry({
      email1_sent_at: iso(T0), // âncora presente (confirmado), mas via Kit
      email1_brevo_id: null,
    });
    const plan = buildRunPlan({
      entries: [iniciadoNoKit],
      statsById: {},
      nowSec: T0 + 3 * DAY,
      email2Days: 3,
      email3Days: 10,
      email3GraceDays: 10,
      snippets: { 1: sendable(1), 2: sendable(2), 3: sendable(3) },
    });
    const filtered = filterBrevoPlanForKitCutover(plan, true);
    assert.deepEqual(filtered.actions, [], "Brevo não deve enviar email2 de uma escada que começou no Kit");
    const skip = filtered.skips.find((s) => s.motivo === "kit_transport_ativo");
    assert.ok(skip);
    assert.equal(skip!.etapa, "email2");
  });

  it("email3_campaign nunca é tocado pelo guard (fora de escopo #8966)", () => {
    const elegivel = entry({
      email1_sent_at: iso(T0),
      email1_brevo_id: "brevo-msg-1",
      email2_sent_at: iso(T0 + 3 * DAY),
      email2_brevo_id: "brevo-msg-2",
    });
    const plan = buildRunPlan({
      entries: [elegivel],
      statsById: { "sub-1": { total_unique_opened: 1, total_clicked: 0 } },
      nowSec: T0 + 10 * DAY,
      email2Days: 3,
      email3Days: 10,
      email3GraceDays: 10,
      snippets: { 1: sendable(1), 2: sendable(2), 3: sendable(3) },
    });
    assert.deepEqual(actionsSummary(plan), [{ kind: "email3_campaign", n: 1 }]);
    const filtered = filterBrevoPlanForKitCutover(plan, true);
    assert.deepEqual(actionsSummary(filtered), [{ kind: "email3_campaign", n: 1 }], "kill switch ligado não deve afetar email3_campaign");
  });
});
