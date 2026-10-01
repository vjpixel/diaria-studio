/**
 * test/meta-ads-ingest-window-zero-9413.test.ts (#9413, regressão #633)
 *
 * 1. Mês inteiro dentro da janela sem nenhuma linha de gasto não entrava no
 *    retorno de `aggregateMetaAdsChannelMetricsByMonth`, e `mergeSpendRows`
 *    mantinha a linha antiga (ex: `--since 2026-08-01` não tocava agosto se a
 *    campanha da newsletter não gastou lá — o agregado `level=account` velho
 *    ficava). Agora sai `valor: 0`.
 * 2. `loadMetaAdsCampaignIds` engolia JSON malformado e devolvia `[]` =
 *    `level=account` em silêncio. Agora config ilegível é falha explícita.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  META_ADS_CANAL,
  META_ADS_INGEST_FAILURE_EXIT_CODE,
  aggregateMetaAdsChannelMetricsByMonth,
  lookbackDaysSince,
  runHeadless,
} from "../scripts/meta-ads-ingest-spend.ts";
import { fetchMetaAdsChannelMetrics, fetchMetaAdsCompleteRegistrationDaily } from "../scripts/lib/ads-campaign-economics-fetch.ts";
import { formatSpendCsv } from "../scripts/lib/aquisicao-spend.ts";
import type { ChannelDailyMetric } from "../scripts/lib/ads-campaign-economics.ts";

const m = (date: string, gastoBrl: number): ChannelDailyMetric => ({ canal: "x", date, gastoBrl, cliques: 0, impressoes: 0 });

describe("#9413 — mês da janela sem gasto vira valor 0", () => {
  it("--since 01/08 com gasto só em setembro: agosto sai com 0", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth([m("2026-09-19", 100)], META_ADS_CANAL, "BRL", "2026-08-01", "2026-09-30");
    assert.deepEqual(rows.map((r) => [r.mes, r.valor]), [["2026-08", 0], ["2026-09", 100]]);
    assert.match(rows[0].fonte, /0 dia\(s\) com gasto na janela 2026-08-01\.\.2026-09-30/);
  });

  it("mês em andamento (windowEnd) sem gasto também sai com 0", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth([m("2026-09-19", 100)], META_ADS_CANAL, "BRL", "2026-09-01", "2026-10-01");
    assert.deepEqual(rows.map((r) => [r.mes, r.valor]), [["2026-09", 100], ["2026-10", 0]]);
  });

  it("mês truncado pela janela (começa no meio) NÃO é zerado", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth([m("2026-10-01", 5)], META_ADS_CANAL, "BRL", "2026-09-02", "2026-10-01");
    assert.deepEqual(rows.map((r) => r.mes), ["2026-10"]);
  });

  it("buraco no meio da janela cruzando o ano", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth(
      [m("2025-11-03", 1), m("2026-02-02", 2)],
      META_ADS_CANAL,
      "BRL",
      "2025-11-01",
      "2026-02-10",
    );
    assert.deepEqual(rows.map((r) => [r.mes, r.valor]), [["2025-11", 1], ["2025-12", 0], ["2026-01", 0], ["2026-02", 2]]);
  });

  it("sem windowEnd: preenche até o mês mais recente com dado", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth([m("2026-09-19", 100)], META_ADS_CANAL, "BRL", "2026-08-01");
    assert.deepEqual(rows.map((r) => r.mes), ["2026-08", "2026-09"]);
  });

  it("sem windowStart: nada é preenchido (janela desconhecida)", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth([m("2026-08-01", 1), m("2026-10-01", 2)], META_ADS_CANAL);
    assert.deepEqual(rows.map((r) => r.mes), ["2026-08", "2026-10"]);
  });

  it("nenhuma linha datada: nada é zerado (pode ser schema drift)", () => {
    assert.deepEqual(aggregateMetaAdsChannelMetricsByMonth([], META_ADS_CANAL, "BRL", "2026-08-01", "2026-10-01"), []);
  });
});

describe("#9413 — runHeadless", () => {
  let dir: string;
  let spendPath: string;
  let savedToken: string | undefined;
  let calls = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meta-9413-"));
    spendPath = join(dir, "spend.csv");
    savedToken = process.env.META_ADS_ACCESS_TOKEN;
    process.env.META_ADS_ACCESS_TOKEN = "tok-fake";
    calls = 0;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.META_ADS_ACCESS_TOKEN;
    else process.env.META_ADS_ACCESS_TOKEN = savedToken;
    rmSync(dir, { recursive: true, force: true });
  });

  const fetchImpl = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ data: [{ date_start: "2026-09-19", spend: "100", clicks: "1", impressions: "10" }], paging: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  it("--since 2026-08-01: agosto antigo (level=account) é regravado com 0", async () => {
    writeFileSync(
      spendPath,
      formatSpendCsv([{ canal: META_ADS_CANAL, mes: "2026-08", moeda: "BRL", valor: 999.99, fonte: "level=account" }]),
      "utf8",
    );
    const now = new Date("2026-09-30T12:00:00Z");
    const lookbackDays = lookbackDaysSince("2026-08-01", now);
    assert.ok(lookbackDays !== null);
    const code = await runHeadless(spendPath, fetchImpl, { lookbackDays, now, campaignIds: ["123"] });
    assert.equal(code, 0);
    const csv = readFileSync(spendPath, "utf8");
    assert.match(csv, /Meta Ads \(teste 2608\),2026-08,BRL,0,/);
    assert.match(csv, /Meta Ads \(teste 2608\),2026-09,BRL,100,/);
    assert.doesNotMatch(csv, /999\.99/);
  });

  it("platform.config.json ilegível: falha explícita, sem chamar a API, spend.csv intocado", async () => {
    const cfg = join(dir, "platform.config.json");
    writeFileSync(cfg, "{ quebrado");
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));
    let code: number;
    try {
      code = await runHeadless(spendPath, fetchImpl, { campaignConfigPath: cfg, now: new Date("2026-09-30T12:00:00Z") });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(code, META_ADS_INGEST_FAILURE_EXIT_CODE);
    assert.equal(calls, 0);
    assert.equal(existsSync(spendPath), false);
    assert.ok(warns.some((w) => w.includes("ilegível")), warns.join("\n"));
  });

  it("config sem a chave: segue com level=account, mas avisa", async () => {
    const cfg = join(dir, "platform.config.json");
    writeFileSync(cfg, JSON.stringify({ outra: 1 }));
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));
    let code: number;
    try {
      code = await runHeadless(spendPath, fetchImpl, { campaignConfigPath: cfg, now: new Date("2026-09-30T12:00:00Z") });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(code, 0);
    assert.ok(warns.some((w) => w.includes("level=account")), warns.join("\n"));
  });
});

describe("#9413 — fetchers com campaign_ids não-lista na config", () => {
  it("campaign_ids presente mas não-array: loadMetaAdsCampaignIds lança", async () => {
    const { loadMetaAdsCampaignIds } = await import("../scripts/lib/ads-campaign-economics-fetch.ts");
    const dir = mkdtempSync(join(tmpdir(), "meta-9413-cfg-"));
    try {
      const p = join(dir, "c.json");
      writeFileSync(p, JSON.stringify({ meta_ads: { campaign_ids: "123" } }));
      assert.throws(() => loadMetaAdsCampaignIds(p), /não é uma lista/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("override explícito não lê a config (fetchers seguem nunca lançando)", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ data: [], paging: {} }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const r1 = await fetchMetaAdsChannelMetrics(f, "tok", { campaignIds: ["1"] });
    assert.equal(r1.error, null);
    const r2 = await fetchMetaAdsCompleteRegistrationDaily(f, "tok", { campaignIds: ["1"] });
    assert.equal(r2.error, null);
  });
});
