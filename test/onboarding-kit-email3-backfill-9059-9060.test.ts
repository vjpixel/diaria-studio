/**
 * test/onboarding-kit-email3-backfill-9059-9060.test.ts
 *
 * Regressão de dois achados do self-review da PR #9058 (#9014/#9015), ambos
 * latentes atrás de `onboarding.kit_transport.enabled` (false em produção):
 *
 *   #9059 — `applyKitLotToEntries` devolvia 0 para `kind === "email3"`: nada
 *   gravava `email3_state` e `buildRunPlan` (que decide o e-mail 3 por
 *   `email3_state === "pending"`) punha a mesma pessoa num rascunho Kit novo
 *   TODO DIA.
 *
 *   #9060 — (1) `--reconcile` pula lotes `completed`, então lote concluído
 *   antes do #9058 nunca marcava as entries; (2) `send_at` não-ISO era gravado
 *   cru em `email{N}_sent_at` e quebrava a âncora da régua; (3) lote `created`
 *   (rascunho no Kit, não vai sair) contava como enviado e ancorava a régua.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildRunPlan, filterKitPlanForBrevoInFlight, type RunPlanResult } from "../scripts/lib/onboarding-state.ts";
import { applyKitLotToEntries, isIsoTimestamp, type OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";
import { readStore, type OnboardingEntry } from "../scripts/lib/onboarding-store.ts";
import { backfillTerminalLotEntries, persistLotUpdate } from "../scripts/onboarding-kit-transport-run.ts";

const DAY = 86_400;
const T0 = 1_790_000_000;

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function entry(over: Partial<OnboardingEntry> = {}): OnboardingEntry {
  return {
    subscription_id: "sub-1",
    email: "novo@example.com",
    status_detectado: "active",
    created_at: T0,
    detected_at: iso(T0),
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

function lot(over: Partial<OnboardingKitLot> = {}): OnboardingKitLot {
  return {
    lot_id: "email1-2026-09-21-01",
    kind: "email1",
    tag_name: "onboarding-email1-2026-09-21-01",
    tag_id: 11,
    broadcast_id: 555,
    recipient_subscription_ids: ["sub-1"],
    recipient_emails: ["novo@example.com"],
    status: "scheduled",
    created_at: iso(T0),
    send_at: iso(T0 + 60),
    last_reconciled_at: null,
    last_error: null,
    ...over,
  };
}

function email3Lot(over: Partial<OnboardingKitLot> = {}): OnboardingKitLot {
  return lot({
    lot_id: "email3-2026-10-01-01",
    kind: "email3",
    tag_name: "onboarding-email3-2026-10-01-01",
    status: "created",
    send_at: null,
    ...over,
  });
}

const sendable = (numero: 1 | 2 | 3) => ({
  numero,
  assunto: `Assunto ${numero}`,
  previewText: "preview",
  body: "<p>corpo</p>",
  hasPendingMarker: false,
});

function plan(entries: OnboardingEntry[], nowSec: number): RunPlanResult {
  return buildRunPlan({
    entries,
    statsById: Object.fromEntries(entries.map((e) => [e.subscription_id, { total_unique_opened: 3, total_clicked: 1 }])),
    nowSec,
    email2Days: 3,
    email3Days: 10,
    email3GraceDays: 10,
    snippets: { 1: sendable(1), 2: sendable(2), 3: sendable(3) },
  });
}

function kinds(p: RunPlanResult): string[] {
  return p.actions.map((a) => a.kind);
}

function withStore<T>(store: unknown, fn: (storePath: string) => T): T {
  const dir = mkdtempSync(resolve(tmpdir(), "diaria-9059-"));
  const storePath = resolve(dir, "store.json");
  try {
    writeFileSync(storePath, JSON.stringify(store));
    return fn(storePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Entrada com e-mail 1/2 já enviados (escada Kit) e D+10 vencido.
const ANCHOR = T0 + 60;
const D10 = ANCHOR + 10 * DAY + 1;
function d10Entry(over: Partial<OnboardingEntry> = {}): OnboardingEntry {
  return entry({
    email1_sent_at: iso(ANCHOR),
    email1_transport: "kit",
    email2_sent_at: iso(ANCHOR + 3 * DAY),
    ...over,
  });
}

describe("#9059 — lote Kit de e-mail 3 grava email3_state", () => {
  it("lote created (rascunho) com broadcast grava campaign_created + decided_at + email3_kit_lot_id, sem tocar email3_campaign_id", () => {
    const entries = { "sub-1": d10Entry() };
    assert.equal(applyKitLotToEntries(entries, email3Lot(), iso(D10)), 1);
    assert.equal(entries["sub-1"].email3_state, "campaign_created");
    assert.equal(entries["sub-1"].email3_decided_at, iso(D10));
    assert.equal(entries["sub-1"].email3_kit_lot_id, "email3-2026-10-01-01");
    assert.equal(entries["sub-1"].email3_campaign_id, null, "id de campanha Brevo não recebe id Kit");
  });

  it("nunca sobrescreve decisão terminal nem campanha Brevo", () => {
    const entries = {
      "sub-1": d10Entry({ email3_state: "skipped_no_open", email3_decided_at: iso(D10 - DAY) }),
      "sub-2": d10Entry({ subscription_id: "sub-2", email3_state: "campaign_created", email3_campaign_id: 77 }),
    };
    assert.equal(applyKitLotToEntries(entries, email3Lot({ recipient_subscription_ids: ["sub-1", "sub-2"] }), iso(D10)), 0);
    assert.equal(entries["sub-1"].email3_state, "skipped_no_open");
    assert.equal(entries["sub-2"].email3_campaign_id, 77);
    assert.equal(entries["sub-2"].email3_kit_lot_id, undefined);
  });

  it("lote pending sem broadcast não marca nada", () => {
    const entries = { "sub-1": d10Entry() };
    assert.equal(applyKitLotToEntries(entries, email3Lot({ status: "pending", broadcast_id: null }), iso(D10)), 0);
    assert.equal(entries["sub-1"].email3_state, "pending");
  });

  it("lote cancelado devolve a pending SÓ quem ele marcou", () => {
    const entries = {
      "sub-1": d10Entry({ email3_state: "campaign_created", email3_decided_at: iso(D10), email3_kit_lot_id: "email3-2026-10-01-01" }),
      "sub-2": d10Entry({ subscription_id: "sub-2", email3_state: "campaign_created", email3_campaign_id: 77, email3_decided_at: iso(D10) }),
    };
    const cancelled = email3Lot({ status: "cancelled", recipient_subscription_ids: ["sub-1", "sub-2"] });
    assert.equal(applyKitLotToEntries(entries, cancelled, iso(D10 + DAY)), 1);
    assert.equal(entries["sub-1"].email3_state, "pending");
    assert.equal(entries["sub-1"].email3_decided_at, null);
    assert.equal(entries["sub-1"].email3_kit_lot_id, undefined);
    assert.equal(entries["sub-2"].email3_state, "campaign_created", "campanha Brevo fica intocada");
  });

  it("cenário real: D+10 cria o rascunho Kit; D+11 NÃO põe a mesma pessoa num rascunho novo", () => {
    withStore(
      {
        version: 1,
        last_detection_cursor: 1,
        last_detection_backend: "kit",
        d10_brevo_list_id: null,
        entries: { "sub-1": d10Entry() },
        kit_transport: { lots: {} },
      },
      (storePath) => {
        const d1 = readStore(storePath).store;
        const d1Plan = filterKitPlanForBrevoInFlight(plan(Object.values(d1.entries), D10), true, Object.values(d1.kit_transport!.lots));
        assert.deepEqual(kinds(d1Plan), ["email3_campaign"]);

        persistLotUpdate(storePath, email3Lot(), D10 * 1000);

        const d2 = readStore(storePath).store;
        assert.equal(d2.entries["sub-1"].email3_state, "campaign_created", "email3_state gravado no disco junto com o lote");
        // Sem lotes passados ao filtro: prova que é o estado da ENTRY (não a defesa em profundidade) que barra.
        const d2Plan = plan(Object.values(d2.entries), D10 + DAY);
        assert.deepEqual(kinds(d2Plan), [], "pré-fix: rascunho novo pras mesmas pessoas todo dia");
      },
    );
  });

  it("defesa em profundidade: marcação perdida + lote de e-mail 3 confirmado → entrada sai do cohort", () => {
    const p = filterKitPlanForBrevoInFlight(plan([d10Entry()], D10 + DAY), true, [email3Lot()]);
    assert.deepEqual(kinds(p), []);
    assert.equal(p.skips.find((s) => s.etapa === "email3")?.motivo, "kit_lot_existente");
  });

  it("defesa em profundidade não prende quem só tem lote pending/cancelado", () => {
    const pending = filterKitPlanForBrevoInFlight(plan([d10Entry()], D10), true, [email3Lot({ status: "pending", broadcast_id: null })]);
    assert.deepEqual(kinds(pending), ["email3_campaign"]);
    const cancelled = filterKitPlanForBrevoInFlight(plan([d10Entry()], D10), true, [email3Lot({ status: "cancelled" })]);
    assert.deepEqual(kinds(cancelled), ["email3_campaign"]);
  });
});

describe("#9060 item 2 — send_at só é gravado se for ISO válido", () => {
  it("isIsoTimestamp aceita ISO completo e recusa o resto", () => {
    assert.equal(isIsoTimestamp("2026-09-21T10:00:00Z"), true);
    assert.equal(isIsoTimestamp("2026-09-21T10:00:00.000Z"), true);
    assert.equal(isIsoTimestamp("2026-09-21T10:00:00-03:00"), true);
    for (const bad of ["", "amanhã", "Sep 21 2026 10:00", "2026-09-21", "2026-13-45T99:00:00Z", null, undefined, 123]) {
      assert.equal(isIsoTimestamp(bad), false, `recusa ${JSON.stringify(bad)}`);
    }
  });

  it("send_at não-ISO cai para nowIso (âncora da régua continua legível)", () => {
    for (const bad of ["Sep 21 2026 10:00", "lixo", ""]) {
      const entries = { "sub-1": entry() };
      applyKitLotToEntries(entries, lot({ send_at: bad }), iso(T0 + 5));
      assert.equal(entries["sub-1"].email1_sent_at, iso(T0 + 5), `send_at=${JSON.stringify(bad)}`);
    }
  });
});

describe("#9060 item 3 — broadcast em rascunho (created) não conta como enviado", () => {
  it("lote created de e-mail 1 não grava sent_at; ao virar scheduled, grava", () => {
    const entries = { "sub-1": entry() };
    assert.equal(applyKitLotToEntries(entries, lot({ status: "created", send_at: null }), iso(T0)), 0);
    assert.equal(entries["sub-1"].email1_sent_at, null, "pré-fix: régua ancorava num rascunho");
    assert.equal(entries["sub-1"].email1_transport, undefined);

    assert.equal(applyKitLotToEntries(entries, lot({ status: "scheduled" }), iso(T0 + 10)), 1);
    assert.equal(entries["sub-1"].email1_sent_at, iso(T0 + 60));
  });

  it("mesmo sem sent_at, a entrada num lote created NÃO entra num lote novo (sem envio duplicado)", () => {
    const p = filterKitPlanForBrevoInFlight(plan([entry()], T0 + DAY), true, [lot({ status: "created", send_at: null })]);
    assert.deepEqual(kinds(p), []);
    assert.equal(p.skips.find((s) => s.etapa === "email1")?.motivo, "kit_lot_existente");
  });
});

describe("#9060 item 1 — backfill de lotes terminais anteriores ao #9058", () => {
  const baseStore = (lots: Record<string, OnboardingKitLot>, entries: Record<string, OnboardingEntry>) => ({
    version: 1,
    last_detection_cursor: 1,
    last_detection_backend: "kit",
    d10_brevo_list_id: null,
    entries,
    kit_transport: { lots },
  });

  it("lote completed sem marcação nas entries é aplicado; 2ª passada é no-op e não reescreve o store", () => {
    const completed = lot({ status: "completed" });
    const completed3 = email3Lot({ status: "completed", recipient_subscription_ids: ["sub-2"] });
    withStore(
      baseStore(
        { [completed.lot_id]: completed, [completed3.lot_id]: completed3 },
        { "sub-1": entry(), "sub-2": d10Entry({ subscription_id: "sub-2" }) },
      ),
      (storePath) => {
        assert.equal(backfillTerminalLotEntries(storePath, completed.lot_id, T0 * 1000), 1);
        assert.equal(backfillTerminalLotEntries(storePath, completed3.lot_id, T0 * 1000), 1);
        const s = readStore(storePath).store;
        assert.equal(s.entries["sub-1"].email1_sent_at, iso(T0 + 60));
        assert.equal(s.entries["sub-1"].email1_transport, "kit");
        assert.equal(s.entries["sub-2"].email3_state, "campaign_created");
        assert.deepEqual(s.kit_transport!.lots[completed.lot_id], completed, "registro do lote preservado");

        const before = readFileSync(storePath, "utf8");
        assert.equal(backfillTerminalLotEntries(storePath, completed.lot_id, (T0 + DAY) * 1000), 0);
        assert.equal(readFileSync(storePath, "utf8"), before, "idempotente: nada reescrito");
      },
    );
  });

  it("não toca lote não-terminal nem lote inexistente", () => {
    const scheduled = lot({ status: "scheduled" });
    withStore(baseStore({ [scheduled.lot_id]: scheduled }, { "sub-1": entry() }), (storePath) => {
      assert.equal(backfillTerminalLotEntries(storePath, scheduled.lot_id), 0);
      assert.equal(backfillTerminalLotEntries(storePath, "nao-existe"), 0);
      assert.equal(readStore(storePath).store.entries["sub-1"].email1_sent_at, null);
    });
  });
});
