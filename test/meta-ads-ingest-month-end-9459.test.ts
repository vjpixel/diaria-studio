/**
 * test/meta-ads-ingest-month-end-9459.test.ts (#9459, regressão #633)
 *
 * Com a janela default móvel de 30 dias, o guard de mês truncado só gravava
 * outubro na rodada de 30/10; as de 31/10 e 01/11 descartavam outubro, e o
 * gasto do fim do mês nunca chegava ao spend.csv. A janela default agora
 * começa no dia 1 do mês anterior.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  META_ADS_CANAL,
  aggregateMetaAdsChannelMetricsByMonth,
  defaultMetaAdsLookbackDays,
} from "../scripts/meta-ads-ingest-spend.ts";
import { metaAdsDateRange } from "../scripts/lib/ads-campaign-economics-fetch.ts";
import type { ChannelDailyMetric } from "../scripts/lib/ads-campaign-economics.ts";

const m = (date: string, gastoBrl: number): ChannelDailyMetric => ({ canal: "x", date, gastoBrl, cliques: 0, impressoes: 0 });

// Outubro inteiro com R$ 10/dia, mais 30/09 e 01/11.
const metrics: ChannelDailyMetric[] = [
  m("2026-09-30", 5),
  ...Array.from({ length: 31 }, (_, i) => m(`2026-10-${String(i + 1).padStart(2, "0")}`, 10)),
  m("2026-11-01", 3),
];

function runAt(iso: string) {
  const now = new Date(iso);
  const { since, until } = metaAdsDateRange(now, defaultMetaAdsLookbackDays(now));
  const visible = metrics.filter((x) => x.date >= since && x.date <= until);
  return { since, rows: aggregateMetaAdsChannelMetricsByMonth(visible, META_ADS_CANAL, "BRL", since, until) };
}

describe("#9459 — janela default cobre o mês anterior inteiro", () => {
  it("30/10: janela começa em 01/09, outubro gravado até o dia 30", () => {
    const { since, rows } = runAt("2026-10-30T12:54:00Z");
    assert.equal(since, "2026-09-01");
    assert.equal(rows.find((r) => r.mes === "2026-10")?.valor, 300);
  });

  it("31/10: outubro gravado inteiro (antes: descartado)", () => {
    const { since, rows } = runAt("2026-10-31T12:54:00Z");
    assert.equal(since, "2026-09-01");
    assert.equal(rows.find((r) => r.mes === "2026-10")?.valor, 310);
  });

  it("01/11: outubro fechado regravado inteiro + novembro parcial", () => {
    const { since, rows } = runAt("2026-11-01T12:54:00Z");
    assert.equal(since, "2026-10-01");
    assert.deepEqual(rows.map((r) => [r.mes, r.valor]), [["2026-10", 310], ["2026-11", 3]]);
  });

  it("virada de ano: 15/01 começa em 01/12 do ano anterior", () => {
    const now = new Date("2027-01-15T12:00:00Z");
    assert.equal(metaAdsDateRange(now, defaultMetaAdsLookbackDays(now)).since, "2026-12-01");
  });
});
