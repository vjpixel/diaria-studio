/**
 * test/microsoft-ads-ingest-8256.test.ts (#8256)
 *
 * Cobre a parte pura de `scripts/lib/microsoft-ads-ingest.ts` adicionada
 * pela separação por campanha do braço Microsoft (PMax 571543153 x Search
 * 571615527, teste 2608): `normalizeMicrosoftAdsPerformanceRowsByCampaign`
 * e a nova coluna `CampaignId` no parser de linhas de performance. Sem
 * rede — a cobertura de rede (submit→poll→download com `CampaignId` no
 * header real) fica em `test/ads-campaign-economics-fetch-8256.test.ts`,
 * que exercita `fetchMicrosoftAdsChannelMetrics` fim-a-fim.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMicrosoftAdsPerformanceRowsByCampaign,
  ADS_DASHBOARD_PERFORMANCE_COLUMNS_BY_CAMPAIGN,
  ADS_DASHBOARD_PERFORMANCE_COLUMNS,
  type MicrosoftAdsPerformanceReportRow,
} from "../scripts/lib/microsoft-ads-ingest.ts";

describe("#8256 — ADS_DASHBOARD_PERFORMANCE_COLUMNS_BY_CAMPAIGN", () => {
  it("é a variante COM CampaignId — a variante sem campanha (dashboard agregado) nunca ganha a coluna por engano", () => {
    assert.deepEqual(ADS_DASHBOARD_PERFORMANCE_COLUMNS_BY_CAMPAIGN, ["TimePeriod", "CampaignId", "Impressions", "Clicks", "Spend"]);
    assert.deepEqual(ADS_DASHBOARD_PERFORMANCE_COLUMNS, ["TimePeriod", "Impressions", "Clicks", "Spend"]);
    assert.ok(!(ADS_DASHBOARD_PERFORMANCE_COLUMNS as readonly string[]).includes("CampaignId"));
  });
});

describe("#8256 — normalizeMicrosoftAdsPerformanceRowsByCampaign (pure)", () => {
  const CAMPAIGN_MAP = {
    "571543153": "Microsoft Ads (teste 2608) — PMax",
    "571615527": "Microsoft Ads (teste 2608) — Search",
  };

  it("1 linha por (campanha, dia) — rotula pelas 2 campanhas conhecidas do teste 2608", () => {
    const rows: MicrosoftAdsPerformanceReportRow[] = [
      { TimePeriod: "2026-09-05", CampaignId: "571543153", Impressions: "10", Clicks: "2", Spend: "10.00" },
      { TimePeriod: "2026-09-05", CampaignId: "571615527", Impressions: "20", Clicks: "3", Spend: "15.00" },
    ];
    const out = normalizeMicrosoftAdsPerformanceRowsByCampaign(rows, CAMPAIGN_MAP);
    assert.equal(out.length, 2);
    const pmax = out.find((r) => r.campaignId === "571543153");
    const search = out.find((r) => r.campaignId === "571615527");
    assert.deepEqual(pmax, { canal: "Microsoft Ads (teste 2608) — PMax", campaignId: "571543153", date: "2026-09-05", gastoBrl: 10, cliques: 2, impressoes: 10 });
    assert.deepEqual(search, {
      canal: "Microsoft Ads (teste 2608) — Search",
      campaignId: "571615527",
      date: "2026-09-05",
      gastoBrl: 15,
      cliques: 3,
      impressoes: 20,
    });
  });

  it("CampaignId desconhecido (fora do mapa) nunca é descartado — fallback nomeado pelo próprio id", () => {
    const rows: MicrosoftAdsPerformanceReportRow[] = [{ TimePeriod: "2026-09-05", CampaignId: "999999999", Impressions: "1", Clicks: "0", Spend: "1.00" }];
    const out = normalizeMicrosoftAdsPerformanceRowsByCampaign(rows, CAMPAIGN_MAP);
    assert.equal(out.length, 1);
    assert.equal(out[0].canal, "Microsoft Ads (campanha 999999999)");
    assert.equal(out[0].gastoBrl, 1);
  });

  it("linha sem CampaignId (não deveria acontecer com a coluna pedida, mas nunca é descartada) usa o fallback '(sem CampaignId)'", () => {
    const rows: MicrosoftAdsPerformanceReportRow[] = [{ TimePeriod: "2026-09-05", Impressions: "1", Clicks: "0", Spend: "1.00" }];
    const out = normalizeMicrosoftAdsPerformanceRowsByCampaign(rows, CAMPAIGN_MAP);
    assert.equal(out.length, 1);
    assert.equal(out[0].campaignId, "(sem CampaignId)");
    assert.match(out[0].canal, /sem CampaignId/);
  });

  it("somar as linhas por campanha reconstitui o total que a variante sem CampaignId devolveria (nenhum gasto perdido/duplicado)", () => {
    const rows: MicrosoftAdsPerformanceReportRow[] = [
      { TimePeriod: "2026-09-05", CampaignId: "571543153", Impressions: "10", Clicks: "2", Spend: "10.00" },
      { TimePeriod: "2026-09-05", CampaignId: "571615527", Impressions: "20", Clicks: "3", Spend: "15.00" },
      { TimePeriod: "2026-09-06", CampaignId: "571543153", Impressions: "5", Clicks: "1", Spend: "5.00" },
      { TimePeriod: "2026-09-06", CampaignId: "571615527", Impressions: "8", Clicks: "2", Spend: "8.00" },
    ];
    const out = normalizeMicrosoftAdsPerformanceRowsByCampaign(rows, CAMPAIGN_MAP);
    const totalByDate = new Map<string, number>();
    for (const r of out) totalByDate.set(r.date, Math.round(((totalByDate.get(r.date) ?? 0) + r.gastoBrl) * 100) / 100);
    assert.equal(totalByDate.get("2026-09-05"), 25);
    assert.equal(totalByDate.get("2026-09-06"), 13);
  });

  it("TimePeriod irreconhecível é descartado, nunca inventa dia (mesma disciplina de normalizeMicrosoftAdsPerformanceRows)", () => {
    const rows: MicrosoftAdsPerformanceReportRow[] = [{ TimePeriod: "não-é-uma-data", CampaignId: "571543153", Spend: "10.00" }];
    const out = normalizeMicrosoftAdsPerformanceRowsByCampaign(rows, CAMPAIGN_MAP);
    assert.deepEqual(out, []);
  });

  it("mapa vazio (default) sempre cai no fallback — nunca lança por mapa ausente", () => {
    const rows: MicrosoftAdsPerformanceReportRow[] = [{ TimePeriod: "2026-09-05", CampaignId: "571543153", Spend: "1.00" }];
    const out = normalizeMicrosoftAdsPerformanceRowsByCampaign(rows);
    assert.equal(out[0].canal, "Microsoft Ads (campanha 571543153)");
  });
});
