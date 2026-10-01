/**
 * test/meta-ads-spend-per-campaign-9378.test.ts (#9378, regressão #633)
 *
 * A ingestão do gasto Meta lia `act_{id}/insights?level=account` — a conta
 * inteira. Desde 24/09/2026 a mesma conta roda a campanha do ingresso do
 * evento agente-ia, e todo esse gasto entrava como canal `meta-ads` da
 * newsletter. Regressão: gasto de OUTRA campanha da mesma conta não entra.
 * `fetch` é mockado simulando a Graph API (aplica o `filtering` da URL) —
 * nunca chama a API real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildMetaAdsInsightsLevelParams,
  fetchMetaAdsChannelMetrics,
  fetchMetaAdsCompleteRegistrationDaily,
  loadMetaAdsCampaignIds,
  normalizeMetaAdsInsightsRows,
} from "../scripts/lib/ads-campaign-economics-fetch.ts";
import { lookbackDaysSince, runHeadless } from "../scripts/meta-ads-ingest-spend.ts";

const NEWSLETTER = "52527432124198";
const INGRESSO = "99999999999999";

/** Linhas por campanha por dia — o que `level=campaign` devolve. */
const CAMPAIGN_ROWS = [
  { campaign_id: NEWSLETTER, date_start: "2026-09-24", spend: "10.00", clicks: "1", impressions: "100", actions: [{ action_type: "complete_registration", value: "2" }] },
  { campaign_id: INGRESSO, date_start: "2026-09-24", spend: "500.00", clicks: "50", impressions: "5000", actions: [{ action_type: "complete_registration", value: "40" }] },
  { campaign_id: NEWSLETTER, date_start: "2026-09-25", spend: "5.50", clicks: "1", impressions: "50", actions: [] },
  { campaign_id: INGRESSO, date_start: "2026-09-25", spend: "974.59", clicks: "90", impressions: "9000", actions: [] },
];

/** Simula a Graph API: `level=account` soma tudo por dia; `level=campaign`
 *  aplica `filtering` (campaign.id IN [...]). Guarda as URLs pedidas. */
function fakeGraph(urls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const u = new URL(url);
    const level = u.searchParams.get("level");
    let rows = CAMPAIGN_ROWS;
    if (level === "campaign") {
      const f = JSON.parse(u.searchParams.get("filtering") ?? "[]") as Array<{ field: string; value: string[] }>;
      const ids = f.find((x) => x.field === "campaign.id")?.value;
      if (ids) rows = rows.filter((r) => ids.includes(r.campaign_id));
    } else {
      const byDay = new Map<string, { date_start: string; spend: number; clicks: number; impressions: number; actions: { action_type: string; value: string }[] }>();
      for (const r of rows) {
        const d = byDay.get(r.date_start) ?? { date_start: r.date_start, spend: 0, clicks: 0, impressions: 0, actions: [] };
        d.spend += Number(r.spend);
        d.clicks += Number(r.clicks);
        d.impressions += Number(r.impressions);
        d.actions.push(...r.actions);
        byDay.set(r.date_start, d);
      }
      rows = [...byDay.values()].map((d) => ({ ...d, campaign_id: "", spend: d.spend.toFixed(2), clicks: String(d.clicks), impressions: String(d.impressions) }));
    }
    return new Response(JSON.stringify({ data: rows, paging: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const NOW = new Date("2026-09-30T12:00:00Z");

describe("#9378 — buildMetaAdsInsightsLevelParams", () => {
  it("com ids: level=campaign + filtering campaign.id IN", () => {
    const p = new URLSearchParams(buildMetaAdsInsightsLevelParams([NEWSLETTER]));
    assert.equal(p.get("level"), "campaign");
    assert.deepEqual(JSON.parse(p.get("filtering")!), [{ field: "campaign.id", operator: "IN", value: [NEWSLETTER] }]);
  });
  it("lista vazia: level=account (conta inteira)", () => {
    assert.equal(buildMetaAdsInsightsLevelParams([]), "level=account");
  });
});

describe("#9378 — loadMetaAdsCampaignIds", () => {
  it("o platform.config.json real lista a campanha da newsletter", () => {
    assert.ok(loadMetaAdsCampaignIds().includes(NEWSLETTER));
  });
  it("config ausente/sem a chave/valor não numérico → filtrado; ilegível lança (#9413)", () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-9378-cfg-"));
    try {
      assert.deepEqual(loadMetaAdsCampaignIds(join(dir, "nao-existe.json")), []);
      const p = join(dir, "c.json");
      writeFileSync(p, JSON.stringify({ outra: 1 }));
      assert.deepEqual(loadMetaAdsCampaignIds(p), []);
      writeFileSync(p, JSON.stringify({ meta_ads: { campaign_ids: ["123", 456, "abc"] } }));
      assert.deepEqual(loadMetaAdsCampaignIds(p), ["123", "456"]);
      writeFileSync(p, "{ quebrado");
      assert.throws(() => loadMetaAdsCampaignIds(p), /ilegível/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#9378 — normalizeMetaAdsInsightsRows soma por dia (N campanhas/dia)", () => {
  it("2 linhas no mesmo dia viram 1 ponto com a soma", () => {
    const out = normalizeMetaAdsInsightsRows(
      [
        { date_start: "2026-09-24", spend: "10.10", clicks: "1", impressions: "10" },
        { date_start: "2026-09-24", spend: "0.20", clicks: "2", impressions: "20" },
        { date_start: "2026-09-25", spend: "1", clicks: "0", impressions: "0" },
      ],
      "c",
    );
    assert.deepEqual(out, [
      { canal: "c", date: "2026-09-24", gastoBrl: 10.3, cliques: 3, impressoes: 30 },
      { canal: "c", date: "2026-09-25", gastoBrl: 1, cliques: 0, impressoes: 0 },
    ]);
  });
});

describe("#9378 — gasto de outra campanha da mesma conta não entra no canal meta-ads", () => {
  it("fetchMetaAdsChannelMetrics usa level=campaign filtrado e só soma a newsletter", async () => {
    const urls: string[] = [];
    const r = await fetchMetaAdsChannelMetrics(fakeGraph(urls), "tok", { now: NOW, campaignIds: [NEWSLETTER] });
    assert.equal(r.error, null);
    assert.match(urls[0], /level=campaign/);
    assert.doesNotMatch(urls[0], /level=account/);
    assert.deepEqual(r.metrics.map((m) => [m.date, m.gastoBrl]), [["2026-09-24", 10], ["2026-09-25", 5.5]]);
  });

  it("default (sem campaignIds) lê a config — nunca a conta inteira", async () => {
    const urls: string[] = [];
    const r = await fetchMetaAdsChannelMetrics(fakeGraph(urls), "tok", { now: NOW });
    assert.equal(r.metrics.reduce((s, m) => s + m.gastoBrl, 0), 15.5);
    assert.ok(urls[0].includes(encodeURIComponent(NEWSLETTER)));
  });

  it("controle: com [] (conta inteira) o gasto do ingresso entraria — é o bug", async () => {
    const r = await fetchMetaAdsChannelMetrics(fakeGraph([]), "tok", { now: NOW, campaignIds: [] });
    assert.equal(Math.round(r.metrics.reduce((s, m) => s + m.gastoBrl, 0) * 100) / 100, 1490.09);
  });

  it("cadastros (complete_registration) também filtram pela campanha", async () => {
    const urls: string[] = [];
    const r = await fetchMetaAdsCompleteRegistrationDaily(fakeGraph(urls), "tok", { now: NOW, campaignIds: [NEWSLETTER] });
    assert.equal(r.error, null);
    assert.match(urls[0], /level=campaign/);
    assert.deepEqual(r.counts, [{ date: "2026-09-24", count: 2 }, { date: "2026-09-25", count: 0 }]);
  });
});

describe("#9378 — runHeadless grava em spend.csv só o gasto da newsletter", () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meta-9378-"));
    saved = process.env.META_ADS_ACCESS_TOKEN;
    process.env.META_ADS_ACCESS_TOKEN = "tok-fake";
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.META_ADS_ACCESS_TOKEN;
    else process.env.META_ADS_ACCESS_TOKEN = saved;
  });

  it("linha 2026-09 = 15.50 (newsletter), não 1490.09 (conta inteira)", async () => {
    const spendPath = join(dir, "spend.csv");
    const code = await runHeadless(spendPath, fakeGraph([]), { now: NOW, campaignIds: [NEWSLETTER], sleep: async () => {} });
    assert.equal(code, 0);
    const csv = readFileSync(spendPath, "utf8");
    assert.match(csv, /Meta Ads \(teste 2608\),2026-09,BRL,15\.5,/);
    assert.doesNotMatch(csv, /1490/);
  });
});

describe("#9378 — lookbackDaysSince (--since do recálculo)", () => {
  it("inclusivo nas duas pontas", () => {
    assert.equal(lookbackDaysSince("2026-09-01", new Date("2026-10-01T09:00:00Z")), 31);
    assert.equal(lookbackDaysSince("2026-10-01", new Date("2026-10-01T09:00:00Z")), 1);
  });
  it("inválido ou futuro → null", () => {
    assert.equal(lookbackDaysSince("01/09/2026", NOW), null);
    assert.equal(lookbackDaysSince("2026-10-05", NOW), null);
  });
});
