/**
 * test/onboarding-brevo-store-lock-9151.test.ts (#9151)
 *
 * 1. O executor Brevo (`onboarding-welcome-run.ts`) regravava o snapshot do
 *    início da rodada sem lock — apagando `kit_transport.lots` +
 *    `email{1,2}_sent_at` que um `--send` Kit concorrente gravasse no meio,
 *    e a mesma pessoa recebia o e-mail 1/2 de novo no `--send` seguinte.
 *    Agora grava sob o MESMO lock do Kit, aplicando só o delta da rodada.
 * 2. `filterBrevoPlanForKitCutover` passa a tirar do cohort D+10 a entry já
 *    coberta por lote Kit de e-mail 3 (espelho do #9059, que só existia no
 *    lado Kit).
 * 3. Funil: lote Kit de e-mail 3 cancelado não esconde o estado Brevo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { claimLot, persistLotUpdate } from "../scripts/onboarding-kit-transport-run.ts";
import { persistBrevoStore } from "../scripts/onboarding-welcome-run.ts";
import {
  readStore,
  cloneStore,
  mergeStoreDelta,
  persistStoreDelta,
  readStoreUnderLock,
  emptyStore,
  type OnboardingEntry,
} from "../scripts/lib/onboarding-store.ts";
import { acquireLock, releaseLock } from "../scripts/lib/file-lock.ts";
import {
  buildRunPlan,
  filterBrevoPlanForKitCutover,
  dropActionsCoveredOnDisk,
  type RunPlanResult,
} from "../scripts/lib/onboarding-state.ts";
import { buildOnboardingFunnelEntry } from "../scripts/lib/onboarding-funnel-report.ts";
import type { OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";

const DAY = 86_400;
const T0 = 1_755_000_000;

function entry(over: Partial<OnboardingEntry> = {}): OnboardingEntry {
  return {
    subscription_id: "sub-kit",
    email: "kit@example.com",
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

function tmpStore(entries: Record<string, OnboardingEntry>): string {
  const dir = mkdtempSync(resolve(tmpdir(), "diaria-9151-"));
  const storePath = resolve(dir, "store.json");
  writeFileSync(
    storePath,
    JSON.stringify({ version: 1, last_detection_cursor: T0, last_detection_backend: "kit", d10_brevo_list_id: null, entries }),
  );
  return storePath;
}

function kitLot(over: Partial<OnboardingKitLot> = {}): OnboardingKitLot {
  return {
    lot_id: "email3-2026-09-20-01",
    kind: "email3",
    tag_name: "onboarding-email3-2026-09-20-01",
    tag_id: 1,
    broadcast_id: 42,
    recipient_subscription_ids: ["sub-kit"],
    recipient_emails: ["kit@example.com"],
    status: "created",
    created_at: new Date((T0 + 10 * DAY) * 1000).toISOString(),
    send_at: null,
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

describe("#9151 item 1 — rodada Brevo não apaga o que o Kit gravou no meio", () => {
  it("lote Kit + email1_sent_at gravados durante a rodada Brevo sobrevivem, e o e-mail 1 não é re-planejado", () => {
    const storePath = tmpStore({ "sub-kit": entry(), "sub-brevo": entry({ subscription_id: "sub-brevo", email: "b@example.com" }) });
    try {
      // Rodada Brevo lê o snapshot no início do main().
      const { store } = readStore(storePath);
      const baseline = cloneStore(store);

      // Kit --send concorrente: reivindica e confirma o lote de e-mail 1.
      const claim = claimLot(storePath, {
        lot_id: "email1-2026-09-15-01",
        kind: "email1",
        dateIso: "2026-09-15",
        tag_name: "onboarding-email1-2026-09-15-01",
        recipient_subscription_ids: ["sub-kit"],
        recipient_emails: ["kit@example.com"],
      });
      assert.ok(claim.lot);
      persistLotUpdate(storePath, { ...claim.lot!, broadcast_id: 7, status: "scheduled" });

      // Rodada Brevo termina: cursor, entrada nova, envio pra outra entry.
      store.last_detection_cursor = T0 + 100;
      store.entries["sub-novo"] = entry({ subscription_id: "sub-novo", email: "n@example.com" });
      store.entries["sub-brevo"].email1_sent_at = "2026-09-15T09:05:00.000Z";
      store.entries["sub-brevo"].email1_brevo_id = "msg-1";
      persistBrevoStore(storePath, baseline, store);

      const { store: disk } = readStore(storePath);
      assert.equal(disk.kit_transport?.lots["email1-2026-09-15-01"]?.status, "scheduled", "lote Kit não pode sumir");
      assert.ok(disk.entries["sub-kit"].email1_sent_at, "email1_sent_at gravado pelo Kit não pode sumir");
      assert.equal(disk.entries["sub-kit"].email1_kit_lot_id, "email1-2026-09-15-01");
      assert.equal(disk.entries["sub-brevo"].email1_brevo_id, "msg-1", "delta Brevo aplicado");
      assert.ok(disk.entries["sub-novo"], "entrada nova da rodada Brevo gravada");
      assert.equal(disk.last_detection_cursor, T0 + 100);

      // Próxima rodada: ninguém re-planeja o e-mail 1 da sub-kit.
      const plan = buildRunPlan({
        entries: Object.values(disk.entries),
        statsById: {},
        nowSec: T0 + DAY,
        email2Days: 3,
        email3Days: 10,
        email3GraceDays: 10,
        snippets: { 1: sendable(1), 2: sendable(2), 3: sendable(3) },
      });
      const again = plan.actions.find((a) => a.kind === "email1" && a.entry.subscription_id === "sub-kit");
      assert.equal(again, undefined, "e-mail 1 duplicado");
    } finally {
      rmSync(dirname(storePath), { recursive: true, force: true });
    }
  });

  it("persistStoreDelta espera o lock do executor Kit (não escreve com o lock tomado)", () => {
    const storePath = tmpStore({});
    const lockPath = `${storePath}.lock`;
    try {
      const { store } = readStore(storePath);
      const baseline = cloneStore(store);
      store.last_detection_cursor = T0 + 1;
      acquireLock(lockPath);
      try {
        assert.throws(() => persistStoreDelta(storePath, baseline, store, 200), /lock timeout/);
      } finally {
        releaseLock(lockPath);
      }
      assert.equal(readStore(storePath).store.last_detection_cursor, T0, "nada escrito sem o lock");
    } finally {
      rmSync(dirname(storePath), { recursive: true, force: true });
    }
  });

  it("store corrompido no disco → recusa escrever (não sobrescreve com vazio)", () => {
    const storePath = tmpStore({});
    try {
      const baseline = emptyStore();
      const updated = cloneStore(baseline);
      updated.last_detection_cursor = 1;
      writeFileSync(storePath, "{ quebrado");
      assert.throws(() => persistStoreDelta(storePath, baseline, updated), /CORROMPIDO/);
    } finally {
      rmSync(dirname(storePath), { recursive: true, force: true });
    }
  });

  it("mergeStoreDelta: campo não tocado pela rodada vem do disco; conflito é reportado", () => {
    const baseline = emptyStore();
    baseline.entries["a"] = entry({ subscription_id: "a" });
    const updated = cloneStore(baseline);
    updated.entries["a"].status_detectado = "inactive";
    updated.entries["a"].email2_sent_at = "brevo";
    const fresh = cloneStore(baseline);
    fresh.entries["a"].email1_sent_at = "kit";
    fresh.entries["a"].email2_sent_at = "kit-2";
    fresh.kit_transport = { lots: { x: kitLot({ lot_id: "x" }) } };
    const { store, conflicts } = mergeStoreDelta(fresh, baseline, updated);
    assert.equal(store.entries["a"].email1_sent_at, "kit");
    assert.equal(store.entries["a"].status_detectado, "inactive");
    assert.equal(store.entries["a"].email2_sent_at, "brevo");
    assert.ok(store.kit_transport?.lots["x"]);
    assert.deepEqual(conflicts, [{ subscription_id: "a", field: "email2_sent_at" }]);
  });
});

describe("#9151 item 2 — Brevo não põe no D+10 quem já está num lote Kit de e-mail 3", () => {
  const plan = (entries: OnboardingEntry[]): RunPlanResult => ({
    actions: [{ kind: "email3_campaign", entries }],
    skips: [],
  });

  it("lote Kit de e-mail 3 não-cancelado tira a entry do cohort (switch desligado também)", () => {
    const e1 = entry();
    const e2 = entry({ subscription_id: "sub-outra", email: "o@example.com" });
    for (const enabled of [true, false]) {
      const out = filterBrevoPlanForKitCutover(plan([e1, e2]), enabled, [kitLot()]);
      assert.equal(out.actions.length, 1);
      const a = out.actions[0];
      assert.ok(a.kind === "email3_campaign");
      assert.deepEqual(a.kind === "email3_campaign" ? a.entries.map((e) => e.subscription_id) : [], ["sub-outra"]);
      assert.ok(out.skips.some((s) => s.etapa === "email3" && s.motivo === "kit_lot_existente"));
    }
  });

  it("lote Kit cancelado não bloqueia; cohort todo coberto some do plano", () => {
    const e1 = entry();
    const cancelled = filterBrevoPlanForKitCutover(plan([e1]), true, [kitLot({ status: "cancelled" })]);
    assert.equal(cancelled.actions.length, 1);
    const empty = filterBrevoPlanForKitCutover(plan([e1]), true, [kitLot({ status: "pending", broadcast_id: null })]);
    assert.equal(empty.actions.length, 0);
  });
});

describe("#9151 item 3 — funil não esconde rascunho Brevo atrás de lote Kit cancelado", () => {
  const opts = (kitLots: OnboardingKitLot[]) => ({
    nowSec: T0 + 12 * DAY,
    email2Days: 3,
    email3Days: 10,
    email3GraceDays: 10,
    kitLots,
  });

  it("lote Kit cancelado + campanha Brevo → mostra a campanha Brevo", () => {
    const e = entry({
      email1_sent_at: new Date(T0 * 1000).toISOString(),
      email3_state: "campaign_created",
      email3_campaign_id: 999,
      email3_decided_at: new Date((T0 + 11 * DAY) * 1000).toISOString(),
    });
    const r = buildOnboardingFunnelEntry(e, opts([kitLot({ status: "cancelled" })]));
    assert.equal(r.email3.provider, "brevo");
    assert.equal(r.email3.campaignOrBroadcastId, 999);
  });

  it("lote Kit cancelado + entry pending → estado pendente, não 'cancelado'", () => {
    const e = entry({ email1_sent_at: new Date(T0 * 1000).toISOString() });
    const r = buildOnboardingFunnelEntry(e, opts([kitLot({ status: "cancelled" })]));
    assert.equal(r.email3.stage, "aguardando_dados");
    assert.equal(r.email3.provider, null);
  });

  it("lote Kit não-cancelado segue vencendo", () => {
    const e = entry({ email3_state: "campaign_created", email3_campaign_id: 999 });
    const r = buildOnboardingFunnelEntry(e, opts([kitLot({ status: "scheduled" })]));
    assert.equal(r.email3.provider, "kit");
  });
});

describe("#9151 (review PR #9181) — plano refiltrado contra o disco antes de enviar", () => {
  it("readStoreUnderLock falha com o lock preso (antes de qualquer envio)", () => {
    const storePath = tmpStore({});
    const lockPath = `${storePath}.lock`;
    try {
      acquireLock(lockPath);
      try {
        assert.throws(() => readStoreUnderLock(storePath, 200), /lock timeout/);
      } finally {
        releaseLock(lockPath);
      }
      assert.equal(readStoreUnderLock(storePath).last_detection_cursor, T0);
    } finally {
      rmSync(dirname(storePath), { recursive: true, force: true });
    }
  });

  it("Kit gravou lote/sent_at durante a rodada → a ação Brevo da mesma rodada vira skip alterado_no_disco", () => {
    const snap = entry();
    const plan: RunPlanResult = {
      actions: [
        { kind: "email1", entry: snap },
        { kind: "email2", entry: entry({ subscription_id: "sub-2", email: "2@example.com" }) },
        { kind: "email1", entry: entry({ subscription_id: "sub-livre", email: "l@example.com" }) },
        { kind: "email3_campaign", entries: [entry({ subscription_id: "sub-3" }), entry({ subscription_id: "sub-3b" })] },
      ],
      skips: [],
    };
    const fresh = emptyStore();
    fresh.entries["sub-kit"] = entry();
    fresh.entries["sub-2"] = entry({ subscription_id: "sub-2", email2_sent_at: "2026-09-15T09:00:00.000Z" });
    fresh.entries["sub-3"] = entry({ subscription_id: "sub-3", email3_state: "campaign_created" });
    fresh.kit_transport = {
      lots: { l1: kitLot({ lot_id: "l1", kind: "email1", status: "pending", broadcast_id: null }) },
    };
    const out = dropActionsCoveredOnDisk(plan, fresh);
    const kept = out.actions.map((a) => (a.kind === "email3_campaign" ? `e3:${a.entries.map((e) => e.subscription_id).join(",")}` : `${a.kind}:${a.entry.subscription_id}`));
    assert.deepEqual(kept, ["email1:sub-livre", "e3:sub-3b"]);
    assert.equal(out.skips.filter((s) => s.motivo === "alterado_no_disco").length, 3);
  });

  it("gravação que falha depois dos envios deixa arquivo de socorro e relança", () => {
    const storePath = tmpStore({});
    try {
      const { store } = readStore(storePath);
      const baseline = cloneStore(store);
      store.entries["x"] = entry({ subscription_id: "x", email1_sent_at: "2026-09-15T09:05:00.000Z" });
      writeFileSync(storePath, "{ quebrado");
      assert.throws(() => persistBrevoStore(storePath, baseline, store), /CORROMPIDO/);
      const rescue = readdirSync(dirname(storePath)).filter((f) => f.startsWith("store.json.pending-"));
      assert.equal(rescue.length, 1);
    } finally {
      rmSync(dirname(storePath), { recursive: true, force: true });
    }
  });

  it("entry nova que outro processo já criou no disco: vale o disco, conflito reportado", () => {
    const baseline = emptyStore();
    const updated = cloneStore(baseline);
    updated.entries["n"] = entry({ subscription_id: "n", email1_sent_at: "brevo" });
    const fresh = cloneStore(baseline);
    fresh.entries["n"] = entry({ subscription_id: "n" });
    const { store, conflicts } = mergeStoreDelta(fresh, baseline, updated);
    assert.equal(store.entries["n"].email1_sent_at, null);
    assert.deepEqual(conflicts, [{ subscription_id: "n", field: "*entry_nova_ja_no_disco" }]);
  });
});
