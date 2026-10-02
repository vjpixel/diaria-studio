/**
 * test/meta-ads-ingest-window-start-9378.test.ts (#9378, regressão #633)
 *
 * O guard de mês truncado (#8245 item 3) decidia pelo primeiro dia COM
 * DADO. A campanha da newsletter só começou a gastar em ~19/09, então
 * `--since 2026-09-01` (janela cobrindo setembro inteiro) ainda descartava
 * setembro e o mês ficava com o agregado antigo da CONTA inteira
 * (R$ 2.563,12, incluindo a campanha do ingresso) — o valor errado que o
 * recálculo existe pra corrigir. Medido ao vivo no 300 em 01/10/2026.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  META_ADS_CANAL,
  aggregateMetaAdsChannelMetricsByMonth,
  lookbackDaysSince,
  runHeadless,
} from "../scripts/meta-ads-ingest-spend.ts";
import { formatSpendCsv } from "../scripts/lib/aquisicao-spend.ts";
import type { ChannelDailyMetric } from "../scripts/lib/ads-campaign-economics.ts";

const m = (date: string, gastoBrl: number): ChannelDailyMetric => ({ canal: "x", date, gastoBrl, cliques: 0, impressoes: 0 });

describe("#9378 — aggregateMetaAdsChannelMetricsByMonth com windowStart", () => {
  const metrics = [m("2026-09-19", 100), m("2026-09-30", 50), m("2026-10-01", 7.84)];

  it("janela começando no dia 1: mês mais antigo é mantido mesmo sem gasto nos primeiros dias", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth(metrics, META_ADS_CANAL, "BRL", "2026-09-01");
    assert.deepEqual(rows.map((r) => [r.mes, r.valor]), [["2026-09", 150], ["2026-10", 7.84]]);
  });

  it("janela começando antes do dia 1 também cobre o mês inteiro", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth(metrics, META_ADS_CANAL, "BRL", "2026-08-20");
    assert.equal(rows.length, 2);
  });

  it("janela começando no meio do mês: segue descartando (guard do #8245 intacto)", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth(metrics, META_ADS_CANAL, "BRL", "2026-09-02");
    assert.deepEqual(rows.map((r) => r.mes), ["2026-10"]);
  });

  it("1 mês só nos dados e janela começando no meio dele: descarta (antes regravava com o parcial)", () => {
    // Campanha pausada em outubro, rodada default em 10/10 → janela 11/09..10/10.
    const rows = aggregateMetaAdsChannelMetricsByMonth([m("2026-09-11", 10), m("2026-09-30", 5)], META_ADS_CANAL, "BRL", "2026-09-11");
    assert.deepEqual(rows, []);
  });

  it("1 mês só e janela começando antes dele: mantém", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth([m("2026-10-03", 10)], META_ADS_CANAL, "BRL", "2026-09-11");
    assert.deepEqual(rows.map((r) => [r.mes, r.valor]), [["2026-10", 10]]);
  });

  it("janela cruzando o ano: dezembro mantido quando a janela começa em 01/12", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth([m("2025-12-20", 1), m("2026-01-02", 2)], META_ADS_CANAL, "BRL", "2025-12-01");
    assert.deepEqual(rows.map((r) => r.mes), ["2025-12", "2026-01"]);
  });

  it("sem windowStart: comportamento legado pelo primeiro dia com dado", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth(metrics, META_ADS_CANAL);
    assert.deepEqual(rows.map((r) => r.mes), ["2026-10"]);
  });
});

describe("#9378 — runHeadless regrava o mês quando a janela cobre o dia 1", () => {
  let dir: string;
  let spendPath: string;
  let savedToken: string | undefined;
  let requestedUrls: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meta-9378-"));
    spendPath = join(dir, "spend.csv");
    savedToken = process.env.META_ADS_ACCESS_TOKEN;
    process.env.META_ADS_ACCESS_TOKEN = "tok-fake";
    requestedUrls = [];
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.META_ADS_ACCESS_TOKEN;
    else process.env.META_ADS_ACCESS_TOKEN = savedToken;
    rmSync(dir, { recursive: true, force: true });
  });

  const fetchImpl = (async (url: string | URL) => {
    requestedUrls.push(String(url));
    return new Response(
      JSON.stringify({
        data: [
          { date_start: "2026-09-19", spend: "100", clicks: "1", impressions: "10" },
          { date_start: "2026-09-30", spend: "50", clicks: "1", impressions: "10" },
          { date_start: "2026-10-01", spend: "7.84", clicks: "1", impressions: "10" },
        ],
        paging: {},
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  /** `since` efetivamente enviado à Graph API (time_range da 1ª página). */
  function requestedSince(): string {
    const tr = new URL(requestedUrls[0]).searchParams.get("time_range");
    return JSON.parse(tr ?? "{}").since;
  }

  function seedAccountLevelSeptember(): void {
    writeFileSync(
      spendPath,
      formatSpendCsv([{ canal: META_ADS_CANAL, mes: "2026-09", moeda: "BRL", valor: 2563.12, fonte: "level=account" }]),
      "utf8",
    );
  }

  for (const nowIso of ["2026-10-01T00:00:01Z", "2026-10-01T22:00:00Z", "2026-10-01T23:59:59Z"]) {
    it(`--since 2026-09-01 via lookbackDaysSince (now=${nowIso}): setembro e outubro regravados, since enviado = 2026-09-01`, async () => {
      seedAccountLevelSeptember();
      const now = new Date(nowIso);
      const lookbackDays = lookbackDaysSince("2026-09-01", now);
      assert.ok(lookbackDays !== null);
      const code = await runHeadless(spendPath, fetchImpl, { lookbackDays, now, campaignIds: ["123"] });
      assert.equal(code, 0);
      assert.equal(requestedSince(), "2026-09-01");
      const csv = readFileSync(spendPath, "utf8");
      assert.match(csv, /Meta Ads \(teste 2608\),2026-09,BRL,150,"Meta Graph API insights \(level=campaign/);
      assert.match(csv, /Meta Ads \(teste 2608\),2026-10,BRL,7\.84,/);
      assert.doesNotMatch(csv, /2563\.12/);
    });
  }

  // Janela de 30 dias explícita: desde o #9459 o default começa no dia 1 do
  // mês anterior; este caso segue cobrindo o guard de janela no meio do mês.
  it("janela de 30 dias (começa 02/09): setembro antigo preservado, outubro gravado, descarte avisado", async () => {
    seedAccountLevelSeptember();
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));
    let code: number;
    try {
      code = await runHeadless(spendPath, fetchImpl, { lookbackDays: 30, now: new Date("2026-10-01T22:00:00Z"), campaignIds: ["123"] });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(code, 0);
    assert.equal(requestedSince(), "2026-09-02");
    const csv = readFileSync(spendPath, "utf8");
    assert.match(csv, /2026-09,BRL,2563\.12,/);
    assert.match(csv, /2026-10,BRL,7\.84,/);
    assert.ok(
      warns.some((w) => w.includes("2026-09 não regravado") && w.includes("--since 2026-09-01")),
      warns.join("\n"),
    );
  });
});
