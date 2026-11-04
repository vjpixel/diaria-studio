/**
 * test/studio-utms-medium-12066.test.ts (#12066) — /utms corta assinantes por
 * utm_medium (comparar topo x rodapé do box do Dossiê Master, #12031).
 * Sem rede: fetchers e env injetados.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateByUtmSourceMedium } from "../scripts/count-subscriptions-by-utm.ts";
import { buildUtmsData, clearUtmsCache } from "../scripts/studio-ui/studio-utms.ts";

describe("aggregateByUtmSourceMedium (#12066)", () => {
  it("conta por source e medium, normalizando e usando __none__", () => {
    const out = aggregateByUtmSourceMedium([
      { utm_source: "Dossiemaster", utm_medium: "topo" },
      { utm_source: "dossiemaster", utm_medium: " TOPO " },
      { utm_source: "dossiemaster", utm_medium: "rodape" },
      { utm_source: "dossiemaster" },
      { utm_source: null, utm_medium: "x" },
    ]);
    assert.deepEqual(out, {
      dossiemaster: { topo: 2, rodape: 1, __none__: 1 },
      __none__: { x: 1 },
    });
  });
});

describe("buildUtmsData subscribersByMedium (#12066)", () => {
  beforeEach(() => clearUtmsCache());

  it("expõe o corte topo x rodapé no emissor dossiemaster", async () => {
    const root = mkdtempSync(join(tmpdir(), "utms-12066-"));
    try {
      const snap = await buildUtmsData(root, {
        subscriberBackend: "beehiiv",
        env: {},
        forceRefresh: true,
        fetchClicks: async () => ({ clicksByCampaign: {}, campaignsRead: 0 }),
        fetchSubscriptions: async () => ({
          counts: { dossiemaster: 5 },
          campaignCounts: { cadastro: 5 },
          mediumCounts: { dossiemaster: { topo: 4, rodape: 1 } },
          total: 5,
          fetched_at: "2026-11-04T00:00:00Z",
        }),
      });
      const row = snap.emitters.find((e) => e.source === "dossiemaster");
      assert.ok(row, "emissor dossiemaster no registry");
      assert.equal(row.subscribers, 5);
      assert.deepEqual(row.subscribersByMedium, { topo: 4, rodape: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fetcher sem mediumCounts degrada pra {} e erro vira null", async () => {
    const root = mkdtempSync(join(tmpdir(), "utms-12066-"));
    try {
      const ok = await buildUtmsData(root, {
        subscriberBackend: "beehiiv", env: {}, forceRefresh: true,
        fetchClicks: async () => ({ clicksByCampaign: {}, campaignsRead: 0 }),
        fetchSubscriptions: async () => ({ counts: {}, campaignCounts: {}, total: 0, fetched_at: "x" }),
      });
      assert.deepEqual(ok.emitters.find((e) => e.source === "dossiemaster")?.subscribersByMedium, {});
      clearUtmsCache();
      const bad = await buildUtmsData(root, {
        subscriberBackend: "beehiiv", env: {}, forceRefresh: true,
        fetchClicks: async () => ({ clicksByCampaign: {}, campaignsRead: 0 }),
        fetchSubscriptions: async () => { throw new Error("boom"); },
      });
      assert.equal(bad.emitters.find((e) => e.source === "dossiemaster")?.subscribersByMedium, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
