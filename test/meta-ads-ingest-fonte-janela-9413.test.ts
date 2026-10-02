/**
 * test/meta-ads-ingest-fonte-janela-9413.test.ts (#9413 itens 3 e 4, regressão #633)
 *
 * 3. A `fonte` de um mês com gasto não registrava a janela consultada —
 *    "N dia(s) (2026-09-19..2026-09-30)" parecia mês truncado mesmo quando a
 *    janela cobriu desde 01/09. Agora inclui `janela AAAA-MM-DD..AAAA-MM-DD`.
 * 4. O início da janela era calculado em dois lugares (`runHeadless` e a
 *    privada `toMetaAdsDateRange`). Agora `metaAdsDateRange` é exportado e é
 *    a fonte única — a janela da `fonte`/guard bate com o `time_range` da URL.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { META_ADS_CANAL, aggregateMetaAdsChannelMetricsByMonth, runHeadless } from "../scripts/meta-ads-ingest-spend.ts";
import { metaAdsDateRange } from "../scripts/lib/ads-campaign-economics-fetch.ts";
import type { ChannelDailyMetric } from "../scripts/lib/ads-campaign-economics.ts";

const m = (date: string, gastoBrl: number): ChannelDailyMetric => ({ canal: "x", date, gastoBrl, cliques: 0, impressoes: 0 });

describe("#9413 item 3 — fonte registra a janela", () => {
  it("mês com gasto a partir do dia 19, janela desde 01/09: fonte diz a janela", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth(
      [m("2026-09-19", 10), m("2026-09-30", 5)],
      META_ADS_CANAL,
      "BRL",
      "2026-09-01",
      "2026-09-30",
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].fonte, /2 dia\(s\) \(2026-09-19\.\.2026-09-30\), janela 2026-09-01\.\.2026-09-30, ingestão automática$/);
  });

  it("sem windowStart (chamador legado): formato antigo, sem janela", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth([m("2026-09-05", 1)], META_ADS_CANAL);
    assert.doesNotMatch(rows[0].fonte, /janela/);
  });

  it("sem windowEnd: janela aberta 'AAAA-MM-DD..'", () => {
    const rows = aggregateMetaAdsChannelMetricsByMonth([m("2026-09-05", 1)], META_ADS_CANAL, "BRL", "2026-09-01");
    assert.match(rows[0].fonte, /janela 2026-09-01\.\., ingestão automática$/);
  });
});

describe("#9413 item 4 — metaAdsDateRange é a fonte única da janela", () => {
  it("lookbackDays inclusivo nas duas pontas, calendário UTC", () => {
    assert.deepEqual(metaAdsDateRange(new Date("2026-09-30T12:00:00Z"), 30), { since: "2026-09-01", until: "2026-09-30" });
    assert.deepEqual(metaAdsDateRange(new Date("2026-03-01T00:30:00Z"), 1), { since: "2026-03-01", until: "2026-03-01" });
    assert.deepEqual(metaAdsDateRange(new Date("2026-01-02T23:59:00Z"), 3), { since: "2025-12-31", until: "2026-01-02" });
  });

  let dir: string;
  let prevToken: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meta-9413-janela-"));
    prevToken = process.env.META_ADS_ACCESS_TOKEN;
    process.env.META_ADS_ACCESS_TOKEN = "tok-fake";
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevToken === undefined) delete process.env.META_ADS_ACCESS_TOKEN;
    else process.env.META_ADS_ACCESS_TOKEN = prevToken;
  });

  it("runHeadless: janela gravada na fonte == time_range consultado na Graph API", async () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const lookbackDays = 45;
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: [{ date_start: "2026-09-19", spend: "10.00" }], paging: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const spendPath = join(dir, "spend.csv");
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    let code: number;
    try {
      code = await runHeadless(spendPath, fetchImpl, { now, lookbackDays, campaignIds: ["123"] });
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    assert.equal(code, 0);
    const timeRange = JSON.parse(decodeURIComponent(new URL(urls[0]).searchParams.get("time_range") ?? "null")) as {
      since: string;
      until: string;
    };
    assert.deepEqual(timeRange, metaAdsDateRange(now, lookbackDays));
    const csv = readFileSync(spendPath, "utf8");
    assert.ok(csv.includes(`janela ${timeRange.since}..${timeRange.until}`), csv);
  });
});
