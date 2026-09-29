/**
 * test/onboarding-kit-sent-at-provenance-9014-9015.test.ts
 *
 * Regressão de dois achados irmãos do corte Brevo→Kit do onboarding, ambos
 * latentes atrás de `onboarding.kit_transport.enabled` (false em produção)
 * mas garantidos no dia do flip:
 *
 *   #9014 — o executor Kit nunca gravava `email{1,2}_sent_at`. `buildRunPlan`
 *   decide "e-mail 1 pendente" por `email1_sent_at == null` e a dedup de lote
 *   é só por `kind+dateIso` → a mesma pessoa recebia o e-mail 1 num lote NOVO
 *   todo dia, e a régua nunca ancorava (e-mail 2/3 nunca saíam).
 *
 *   #9015 — `ownerTransportFor` inferia o dono do e-mail 2 por
 *   `email1_brevo_id != null`. Seeds (`seeded_by`, `email1_brevo_id: null`
 *   por construção) e envios Brevo com id nulo viravam "do Kit" → Brevo
 *   pulava (`kit_transport_ativo`) e o Kit excluía (`cohort_excluida_manual`)
 *   → ninguém enviava o e-mail 2.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  buildRunPlan,
  filterBrevoPlanForKitCutover,
  filterKitPlanForBrevoInFlight,
  ownerTransportFor,
  type RunPlanResult,
} from "../scripts/lib/onboarding-state.ts";
import { applyKitLotToEntries, type OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";
import { readStore, type OnboardingEntry } from "../scripts/lib/onboarding-store.ts";
import { persistLotUpdate } from "../scripts/onboarding-kit-transport-run.ts";
import { applySendResult } from "../scripts/onboarding-welcome-run.ts";

const DAY = 86_400;
const T0 = 1_790_000_000; // D1 do cenário

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
    statsById: {},
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

describe("#9014 — applyKitLotToEntries grava o envio Kit na entry", () => {
  it("lote confirmado de e-mail 1 grava email1_sent_at (= send_at), lot_id e email1_transport=kit", () => {
    const entries = { "sub-1": entry() };
    assert.equal(applyKitLotToEntries(entries, lot(), iso(T0 + 5)), 1);
    assert.equal(entries["sub-1"].email1_sent_at, iso(T0 + 60));
    assert.equal(entries["sub-1"].email1_kit_lot_id, "email1-2026-09-21-01");
    assert.equal(entries["sub-1"].email1_transport, "kit");
  });

  it("idempotente: nunca sobrescreve um envio já registrado (reconcile repetido)", () => {
    const entries = { "sub-1": entry({ email1_sent_at: iso(T0 - DAY), email1_transport: "brevo" }) };
    assert.equal(applyKitLotToEntries(entries, lot(), iso(T0)), 0);
    assert.equal(entries["sub-1"].email1_sent_at, iso(T0 - DAY));
    assert.equal(entries["sub-1"].email1_transport, "brevo");
  });

  it("lote pending (sem broadcast confirmado) não marca nada", () => {
    const entries = { "sub-1": entry() };
    assert.equal(applyKitLotToEntries(entries, lot({ status: "pending", broadcast_id: null }), iso(T0)), 0);
    assert.equal(entries["sub-1"].email1_sent_at, null);
  });

  it("lote de e-mail 2 grava email2_sent_at sem mexer no transporte do e-mail 1", () => {
    const entries = { "sub-1": entry({ email1_sent_at: iso(T0), email1_transport: "kit" }) };
    applyKitLotToEntries(entries, lot({ kind: "email2", lot_id: "email2-x-01", send_at: null }), iso(T0 + 3 * DAY));
    assert.equal(entries["sub-1"].email2_sent_at, iso(T0 + 3 * DAY), "sem send_at, cai no nowIso");
    assert.equal(entries["sub-1"].email2_kit_lot_id, "email2-x-01");
    assert.equal(entries["sub-1"].email1_transport, "kit");
  });

  it("lote cancelado desfaz só a marcação feita por ELE (entrada volta a ser devida)", () => {
    const entries = {
      "sub-1": entry({ email1_sent_at: iso(T0 + 60), email1_kit_lot_id: "email1-2026-09-21-01", email1_transport: "kit" }),
      "sub-2": entry({ subscription_id: "sub-2", email1_sent_at: iso(T0 - DAY), email1_transport: "brevo" }),
    };
    const cancelled = lot({ status: "cancelled", recipient_subscription_ids: ["sub-1", "sub-2"] });
    assert.equal(applyKitLotToEntries(entries, cancelled, iso(T0)), 1);
    assert.equal(entries["sub-1"].email1_sent_at, null);
    assert.equal(entries["sub-1"].email1_kit_lot_id, undefined);
    assert.equal(entries["sub-1"].email1_transport, undefined);
    assert.equal(entries["sub-2"].email1_sent_at, iso(T0 - DAY), "envio de outro transporte fica intocado");
  });
});

describe("#9014 — cenário real: 2 execuções em DIAS diferentes", () => {
  it("D1 envia o e-mail 1 pelo Kit; D2 NÃO replaneja o e-mail 1; D+3 planeja o e-mail 2 pelo Kit", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "diaria-9014-"));
    const storePath = resolve(dir, "store.json");
    try {
      writeFileSync(
        storePath,
        JSON.stringify({
          version: 1,
          last_detection_cursor: 1,
          last_detection_backend: "kit",
          d10_brevo_list_id: null,
          entries: { "sub-1": entry() },
          kit_transport: { lots: {} },
        }),
      );

      // D1: executor Kit planeja e-mail 1 (switch ligado).
      const d1 = readStore(storePath).store;
      const d1Plan = filterKitPlanForBrevoInFlight(plan(Object.values(d1.entries), T0), true, Object.values(d1.kit_transport!.lots));
      assert.deepEqual(kinds(d1Plan), ["email1"]);

      // Broadcast confirmado → o executor persiste o lote pelo caminho real (lock + releitura).
      persistLotUpdate(storePath, lot(), (T0 + 1) * 1000);

      // D2: nova execução relê o store do disco.
      const d2 = readStore(storePath).store;
      assert.equal(d2.entries["sub-1"].email1_sent_at, iso(T0 + 60), "email1_sent_at gravado no disco junto com o lote");
      const d2Kit = filterKitPlanForBrevoInFlight(plan(Object.values(d2.entries), T0 + DAY), true, Object.values(d2.kit_transport!.lots));
      assert.deepEqual(kinds(d2Kit), [], "pré-fix: e-mail 1 reenviado num lote novo todo dia");
      const d2Brevo = filterBrevoPlanForKitCutover(plan(Object.values(d2.entries), T0 + DAY), false, Object.values(d2.kit_transport!.lots));
      assert.deepEqual(kinds(d2Brevo), [], "rollback (switch off) também não reenvia");

      // D+3 da âncora: a régua ancorou, o e-mail 2 sai — pelo Kit, dono da escada.
      const d4 = T0 + 60 + 3 * DAY + 1;
      const d4Kit = filterKitPlanForBrevoInFlight(plan(Object.values(d2.entries), d4), true, Object.values(d2.kit_transport!.lots));
      assert.deepEqual(kinds(d4Kit), ["email2"]);
      const d4Brevo = filterBrevoPlanForKitCutover(plan(Object.values(d2.entries), d4), true, Object.values(d2.kit_transport!.lots));
      assert.deepEqual(kinds(d4Brevo), [], "Brevo não serve o e-mail 2 de escada Kit");
    } finally {
      rmSync(dirname(storePath), { recursive: true, force: true });
    }
  });

  it("defesa em profundidade: entrada num lote confirmado de dia anterior não entra em lote novo mesmo sem email1_sent_at", () => {
    const e = entry(); // marcação perdida (ex.: crash entre createBroadcast e a escrita)
    const kitPlan = filterKitPlanForBrevoInFlight(plan([e], T0 + DAY), true, [lot()]);
    assert.deepEqual(kinds(kitPlan), []);
    assert.equal(kitPlan.skips.find((s) => s.etapa === "email1")?.motivo, "kit_lot_existente");
  });

  it("lote pending sem broadcast_id (falha de criação) NÃO prende a entrada — retry segue possível", () => {
    const e = entry();
    const kitPlan = filterKitPlanForBrevoInFlight(plan([e], T0 + DAY), true, [lot({ status: "pending", broadcast_id: null })]);
    assert.deepEqual(kinds(kitPlan), ["email1"]);
  });

  it("lote cancelado não bloqueia", () => {
    const kitPlan = filterKitPlanForBrevoInFlight(plan([entry()], T0 + DAY), true, [lot({ status: "cancelled" })]);
    assert.deepEqual(kinds(kitPlan), ["email1"]);
  });
});

describe("#9015 — dono do e-mail 2 por proveniência explícita, não por email1_brevo_id", () => {
  it("seed legado (seeded_by, email1_brevo_id null, sem email1_transport) com switch ligado: Brevo envia o e-mail 2, Kit não", () => {
    const seed = entry({ email1_sent_at: iso(T0), seeded_by: "#7660" });
    assert.equal(ownerTransportFor(seed, "email2", true), "brevo");
    const p = plan([seed], T0 + 3 * DAY + 1);
    assert.deepEqual(kinds(filterBrevoPlanForKitCutover(p, true)), ["email2"], "pré-fix: skip kit_transport_ativo — ninguém enviava");
    assert.deepEqual(kinds(filterKitPlanForBrevoInFlight(p, true)), []);
  });

  it("seed estilo #7665 (email1_sent_at null) com switch ligado: e-mail 1 fica com a Brevo", () => {
    const seed = entry({ seeded_by: "#7665" });
    assert.equal(ownerTransportFor(seed, "email1", true), "brevo");
    assert.deepEqual(kinds(filterBrevoPlanForKitCutover(plan([seed], T0), true)), ["email1"]);
  });

  it("envio Brevo com id nulo (resposta sem messageId) grava email1_transport=brevo → e-mail 2 continua na Brevo", () => {
    const e = entry();
    applySendResult(e, "email1", null, iso(T0));
    assert.equal(e.email1_transport, "brevo");
    e.email1_brevo_id = null; // idem após --cancel-pending zerar o id
    assert.equal(ownerTransportFor(e, "email2", true), "brevo");
  });

  it("entrada legada sem proveniência gravada (e-mail 1 já enviado, sem id) resolve para Brevo", () => {
    assert.equal(ownerTransportFor(entry({ email1_sent_at: iso(T0) }), "email2", true), "brevo");
  });

  it("email1_transport=kit é respeitado nos dois lados", () => {
    const e = entry({ email1_sent_at: iso(T0), email1_transport: "kit" });
    assert.equal(ownerTransportFor(e, "email2", true), "kit");
    assert.equal(ownerTransportFor(e, "email2", false), "brevo", "switch desligado: Brevo é dona de tudo");
  });

  it("entrada nova sem histórico continua sendo do Kit no e-mail 1", () => {
    assert.equal(ownerTransportFor(entry(), "email1", true), "kit");
  });
});
