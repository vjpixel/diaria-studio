/**
 * test/meta-ads-ingest-month-end-9459.test.ts (#9459, regressão #633)
 *
 * Com a janela default móvel de 30 dias, o guard de mês truncado só gravava
 * outubro na rodada de 30/10; as de 31/10 e 01/11 descartavam outubro, e o
 * gasto do fim do mês nunca chegava ao spend.csv. A janela default agora
 * começa sempre num dia 1: do mês anterior nos dias 1..5, do mês corrente
 * depois disso (o mês anterior fechado não é regravado o mês inteiro).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  META_ADS_CANAL,
  META_ADS_PREV_MONTH_REACH_DAYS,
  defaultMetaAdsLookbackDays,
  runHeadless,
} from "../scripts/meta-ads-ingest-spend.ts";
import { metaAdsDateRange } from "../scripts/lib/ads-campaign-economics-fetch.ts";
import { formatSpendCsv } from "../scripts/lib/aquisicao-spend.ts";

const sinceAt = (iso: string) => {
  const now = new Date(iso);
  return metaAdsDateRange(now, defaultMetaAdsLookbackDays(now)).since;
};

describe("#9459 — defaultMetaAdsLookbackDays sempre começa num dia 1", () => {
  it("30/10 e 31/10: desde 01/10 (mês corrente inteiro)", () => {
    assert.equal(sinceAt("2026-10-30T12:54:00Z"), "2026-10-01");
    assert.equal(sinceAt("2026-10-31T12:54:00Z"), "2026-10-01");
  });
  it("01/11 e dia 5: desde 01/10 (fecha o mês anterior)", () => {
    assert.equal(sinceAt("2026-11-01T12:54:00Z"), "2026-10-01");
    assert.equal(sinceAt(`2026-11-0${META_ADS_PREV_MONTH_REACH_DAYS}T12:54:00Z`), "2026-10-01");
  });
  it("dia 6: volta pro mês corrente (mês anterior não é mais tocado)", () => {
    assert.equal(sinceAt("2026-11-06T12:54:00Z"), "2026-11-01");
  });
  it("borda UTC: 22:00 BRT de 31/10 = 01/11 01:00 UTC → desde 01/10", () => {
    assert.equal(sinceAt("2026-11-01T01:00:00Z"), "2026-10-01");
  });
  it("virada de ano: 02/01 desde 01/12 do ano anterior", () => {
    assert.equal(sinceAt("2027-01-02T12:00:00Z"), "2026-12-01");
  });
});

describe("#9459 — runHeadless SEM lookbackDays grava outubro inteiro", () => {
  let dir: string;
  let spendPath: string;
  let savedToken: string | undefined;
  let requestedUrls: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meta-9459-"));
    spendPath = join(dir, "spend.csv");
    savedToken = process.env.META_ADS_ACCESS_TOKEN;
    process.env.META_ADS_ACCESS_TOKEN = "tok-fake";
    requestedUrls = [];
    // Outubro parcial já gravado (rodada de 30/10, sem o dia 31).
    writeFileSync(spendPath, formatSpendCsv([{ canal: META_ADS_CANAL, mes: "2026-10", moeda: "BRL", valor: 300, fonte: "parcial" }]), "utf8");
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.META_ADS_ACCESS_TOKEN;
    else process.env.META_ADS_ACCESS_TOKEN = savedToken;
    rmSync(dir, { recursive: true, force: true });
  });

  // Simula a Graph API respeitando o time_range pedido: outubro R$ 10/dia + 01/11 R$ 3.
  const all = [
    ...Array.from({ length: 31 }, (_, i) => ({ date_start: `2026-10-${String(i + 1).padStart(2, "0")}`, spend: "10" })),
    { date_start: "2026-11-01", spend: "3" },
  ];
  const fetchImpl = (async (url: string | URL) => {
    requestedUrls.push(String(url));
    const tr = JSON.parse(new URL(String(url)).searchParams.get("time_range") ?? "{}");
    const data = all
      .filter((r) => r.date_start >= tr.since && r.date_start <= tr.until)
      .map((r) => ({ ...r, clicks: "1", impressions: "10" }));
    return new Response(JSON.stringify({ data, paging: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const requestedSince = () => JSON.parse(new URL(requestedUrls[0]).searchParams.get("time_range") ?? "{}").since;

  for (const nowIso of ["2026-10-31T12:54:00Z", "2026-11-01T12:54:00Z"]) {
    it(`now=${nowIso}: since=2026-10-01 e outubro = 310`, async () => {
      const code = await runHeadless(spendPath, fetchImpl, { now: new Date(nowIso), campaignIds: ["123"] });
      assert.equal(code, 0);
      assert.equal(requestedSince(), "2026-10-01");
      assert.match(readFileSync(spendPath, "utf8"), /Meta Ads \(teste 2608\),2026-10,BRL,310,/);
    });
  }

  it("now=2026-11-06: outubro (fechado) não é regravado", async () => {
    writeFileSync(spendPath, formatSpendCsv([{ canal: META_ADS_CANAL, mes: "2026-10", moeda: "BRL", valor: 999, fonte: "reconciliação manual" }]), "utf8");
    const code = await runHeadless(spendPath, fetchImpl, { now: new Date("2026-11-06T12:54:00Z"), campaignIds: ["123"] });
    assert.equal(code, 0);
    assert.equal(requestedSince(), "2026-11-01");
    assert.match(readFileSync(spendPath, "utf8"), /2026-10,BRL,999,/);
  });
});
