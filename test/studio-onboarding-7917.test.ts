/**
 * test/studio-onboarding-7917.test.ts (#7917)
 *
 * Cobre `scripts/studio-ui/studio-onboarding.ts`: fail-soft sem `data/`/sem
 * store, snapshot local do funil sobre um store real gravado em disco,
 * dedup de refresh Brevo por campanha (nunca por assinante), e falha de
 * consulta isolada por campanha (nunca aborta as demais).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeStore, emptyStore, type OnboardingEntry } from "../scripts/lib/onboarding-store.ts";
import {
  buildOnboardingFunnelData,
  refreshBrevoCampaignStates,
  pendingBrevoCampaignIds,
} from "../scripts/studio-ui/studio-onboarding.ts";
import type { LinkableApoiador } from "../scripts/lib/metrics/apoiador-link.ts";

const T0 = 1_755_000_000;
const DAY = 86_400;

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "studio-onboarding-test-"));
  mkdirSync(join(root, "data"), { recursive: true });
  return root;
}

function entry(overrides: Partial<OnboardingEntry> = {}): OnboardingEntry {
  return {
    subscription_id: "sub_1",
    email: "leitor@example.com",
    status_detectado: "active",
    created_at: T0 - 30 * DAY,
    detected_at: new Date((T0 - 30 * DAY) * 1000).toISOString(),
    email1_sent_at: new Date((T0 - 20 * DAY) * 1000).toISOString(),
    email1_brevo_id: "msg-1",
    email2_sent_at: new Date((T0 - 17 * DAY) * 1000).toISOString(),
    email2_brevo_id: "msg-2",
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
    ...overrides,
  };
}

describe("buildOnboardingFunnelData — fail-soft", () => {
  it("sem data/ inteiro: db.available false, entries vazio, nunca lança", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-onboarding-nodata-"));
    try {
      const result = buildOnboardingFunnelData(root, { apoiadores: [] });
      assert.equal(result.db.hasDataDir, false);
      assert.equal(result.db.available, false);
      assert.deepEqual(result.entries, []);
      assert.equal(result.summary.total, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("data/ existe mas store.json ainda não (nenhuma rodada do executor): available false", () => {
    const root = makeRoot();
    try {
      const result = buildOnboardingFunnelData(root, { apoiadores: [] });
      assert.equal(result.db.hasDataDir, true);
      assert.equal(result.db.available, false);
      assert.deepEqual(result.entries, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildOnboardingFunnelData — snapshot sobre store real", () => {
  it("lê entries + kit_transport.lots do store gravado em disco, agrega, nunca consulta rede por padrão", () => {
    const root = makeRoot();
    try {
      const store = emptyStore();
      store.entries["sub_1"] = entry({ subscription_id: "sub_1" });
      store.entries["sub_2"] = entry({
        subscription_id: "sub_2",
        email: "d10@example.com",
        email3_state: "campaign_created",
        email3_campaign_id: 777,
        email3_decided_at: new Date((T0 - 1 * DAY) * 1000).toISOString(),
      });
      store.kit_transport = {
        lots: {
          "email3-01": {
            lot_id: "email3-01",
            kind: "email3",
            tag_name: "onboarding-email3-01",
            tag_id: 1,
            broadcast_id: 55,
            recipient_subscription_ids: ["sub_2"],
            recipient_emails: ["d10@example.com"],
            status: "scheduled",
            created_at: new Date((T0 - 1 * DAY) * 1000).toISOString(),
            send_at: new Date((T0 + 1 * DAY) * 1000).toISOString(),
            last_reconciled_at: null,
            last_error: null,
          },
        },
      };
      writeStore(store, resolve(root, "data", "onboarding", "store.json"));

      const result = buildOnboardingFunnelData(root, { nowSec: T0, apoiadores: [] });
      assert.equal(result.db.available, true);
      assert.equal(result.entries.length, 2);
      assert.equal(result.liveBrevoChecked, false);

      const sub2 = result.entries.find((e) => e.subscriptionId === "sub_2");
      assert.equal(sub2?.email3.provider, "kit");
      assert.equal(sub2?.email3.stage, "agendado");
      assert.equal(sub2?.email3.campaignOrBroadcastId, 55);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("apoiadores injetado vazio ([]): índice existe mas vazio → linked:false explícito (checagem tentada, sem match)", () => {
    const root = makeRoot();
    try {
      const store = emptyStore();
      store.entries["sub_1"] = entry();
      writeStore(store, resolve(root, "data", "onboarding", "store.json"));

      const result = buildOnboardingFunnelData(root, { nowSec: T0, apoiadores: [] });
      assert.deepEqual(result.entries[0].apoiador, { linked: false, firstConfirmedAt: null, daysToFirstApoio: null });
      assert.equal(result.summary.cohort.semIndiceApoiador, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("com apoiadores injetados e vínculo confirmado: primeirosApoiosConfirmados conta", () => {
    const root = makeRoot();
    try {
      const store = emptyStore();
      store.entries["sub_1"] = entry({ email: "apoiador@example.com" });
      writeStore(store, resolve(root, "data", "onboarding", "store.json"));

      const apoiadores: LinkableApoiador[] = [
        { emails: ["apoiador@example.com"], firstConfirmedAt: "2026-09-10T00:00:00.000Z", currentMonthlyValue: 25 },
      ];
      const result = buildOnboardingFunnelData(root, { nowSec: T0, apoiadores });
      assert.equal(result.entries[0].apoiador?.linked, true);
      assert.equal(result.summary.cohort.primeirosApoiosConfirmados, 1);
      assert.equal(result.summary.cohort.semIndiceApoiador, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pendingBrevoCampaignIds + refreshBrevoCampaignStates — dedup e falha isolada", () => {
  it("dedup: 3 entradas na mesma campanha viram 1 id só", () => {
    const entries = [
      entry({ subscription_id: "a", email3_state: "campaign_created", email3_campaign_id: 10 }),
      entry({ subscription_id: "b", email3_state: "campaign_created", email3_campaign_id: 10 }),
      entry({ subscription_id: "c", email3_state: "campaign_created", email3_campaign_id: 20 }),
      entry({ subscription_id: "d", email3_state: "pending" }), // não-elegível pra refresh
    ];
    assert.deepEqual(pendingBrevoCampaignIds(entries).sort(), [10, 20]);
  });

  it("1 GET por id distinto; falha em uma campanha não aborta as demais", async () => {
    const calls: number[] = [];
    const fakeGetCampaign = async (_apiKey: string, campaignId: number) => {
      calls.push(campaignId);
      if (campaignId === 20) throw new Error("Brevo 500");
      return { id: campaignId, name: "x", status: "sent", scheduledAt: null };
    };
    const result = await refreshBrevoCampaignStates("fake-key", [10, 10, 20], fakeGetCampaign as any);
    assert.deepEqual(calls.sort(), [10, 20]); // dedup: 10 chamado 1x mesmo pedido 2x
    assert.equal(result.states.get(10)?.status, "sent");
    assert.equal(result.states.has(20), false);
    assert.equal(result.failed.has(20), true);
    assert.equal(result.attempted, 2);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].campaignId, 20);
  });

  it("estados de refresh aplicados via buildOnboardingFunnelData: sucesso vira enviado, falha vira falha_consulta", () => {
    const root = makeRoot();
    try {
      const store = emptyStore();
      store.entries["ok"] = entry({ subscription_id: "ok", email3_state: "campaign_created", email3_campaign_id: 10, email3_decided_at: new Date((T0 - 5 * DAY) * 1000).toISOString() });
      store.entries["falhou"] = entry({ subscription_id: "falhou", email: "f@example.com", email3_state: "campaign_created", email3_campaign_id: 20, email3_decided_at: new Date((T0 - 5 * DAY) * 1000).toISOString() });
      writeStore(store, resolve(root, "data", "onboarding", "store.json"));

      const brevoCampaignStates = new Map([[10, { status: "sent", scheduledAt: null }]]);
      const brevoFailedCampaignIds = new Set([20]);
      const result = buildOnboardingFunnelData(root, { nowSec: T0, apoiadores: [], brevoCampaignStates, brevoFailedCampaignIds });

      assert.equal(result.liveBrevoChecked, true);
      const ok = result.entries.find((e) => e.subscriptionId === "ok");
      const falhou = result.entries.find((e) => e.subscriptionId === "falhou");
      assert.equal(ok?.email3.stage, "enviado");
      assert.equal(falhou?.email3.stage, "falha_consulta");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
