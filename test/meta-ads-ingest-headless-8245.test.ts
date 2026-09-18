/**
 * test/meta-ads-ingest-headless-8245.test.ts (#8245, regressão #633)
 *
 * Cobre o caminho HEADLESS novo de `scripts/meta-ads-ingest-spend.ts`
 * (sem `--input`, com `META_ADS_ACCESS_TOKEN`) — reusa `fetchMetaAdsChannelMetrics`
 * (`scripts/lib/ads-campaign-economics-fetch.ts`) via `fetch` mockado, nunca
 * chama a Graph API real. Cobre também `aggregateMetaAdsChannelMetricsByMonth`
 * (agregação pura por mês) e o contrato de fallback sem token (mesmo texto/
 * exit code do Google/Microsoft, #5237/#5502).
 *
 * O caminho `--input` (envelope MCP, #5469) NÃO muda nesta issue — coberto
 * por `test/meta-ads-ingest-5469.test.ts` (inalterado) e
 * `test/meta-ads-ingest-spend.test.ts` (canal, #8239).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  META_ADS_CANAL,
  META_ADS_HEADLESS_FONTE_LABEL,
  aggregateMetaAdsChannelMetricsByMonth,
  runHeadless,
} from "../scripts/meta-ads-ingest-spend.ts";
import type { ChannelDailyMetric } from "../scripts/lib/ads-campaign-economics.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------------------
// aggregateMetaAdsChannelMetricsByMonth — puro
// ---------------------------------------------------------------------------

describe("#8245 — aggregateMetaAdsChannelMetricsByMonth", () => {
  it("agrega por mês, soma o gasto, e monta `fonte` no formato exigido", () => {
    const metrics: ChannelDailyMetric[] = [
      { canal: "x", date: "2026-09-05", gastoBrl: 170.17, cliques: 1, impressoes: 10 },
      { canal: "x", date: "2026-09-06", gastoBrl: 100, cliques: 1, impressoes: 10 },
      { canal: "x", date: "2026-09-07", gastoBrl: 50.5, cliques: 1, impressoes: 10 },
    ];
    const rows = aggregateMetaAdsChannelMetricsByMonth(metrics, META_ADS_CANAL);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canal, META_ADS_CANAL);
    assert.equal(rows[0].mes, "2026-09");
    assert.equal(rows[0].moeda, "BRL");
    assert.equal(rows[0].valor, 320.67);
    assert.equal(
      rows[0].fonte,
      `${META_ADS_HEADLESS_FONTE_LABEL}, 3 dia(s) (2026-09-05..2026-09-07), ingestão automática`,
    );
  });

  it("1 único dia no range: fonte usa a data única, não um range com '..'", () => {
    const metrics: ChannelDailyMetric[] = [{ canal: "x", date: "2026-09-05", gastoBrl: 10, cliques: 0, impressoes: 0 }];
    const rows = aggregateMetaAdsChannelMetricsByMonth(metrics, META_ADS_CANAL);
    assert.equal(rows[0].fonte, `${META_ADS_HEADLESS_FONTE_LABEL}, 1 dia(s) (2026-09-05), ingestão automática`);
  });

  it("2 meses distintos geram 2 linhas SpendRow, cada uma com sua própria soma", () => {
    const metrics: ChannelDailyMetric[] = [
      { canal: "x", date: "2026-08-30", gastoBrl: 5, cliques: 0, impressoes: 0 },
      { canal: "x", date: "2026-08-31", gastoBrl: 5, cliques: 0, impressoes: 0 },
      { canal: "x", date: "2026-09-01", gastoBrl: 7, cliques: 0, impressoes: 0 },
    ];
    const rows = aggregateMetaAdsChannelMetricsByMonth(metrics, META_ADS_CANAL);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => [r.mes, r.valor]),
      [
        ["2026-08", 10],
        ["2026-09", 7],
      ],
    );
  });

  it("linha sem `date` reconhecível é descartada, nunca contamina como 0", () => {
    const metrics = [
      { canal: "x", date: "not-a-date", gastoBrl: 999, cliques: 0, impressoes: 0 },
      { canal: "x", date: "2026-09-05", gastoBrl: 10, cliques: 0, impressoes: 0 },
    ] as ChannelDailyMetric[];
    const rows = aggregateMetaAdsChannelMetricsByMonth(metrics, META_ADS_CANAL);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].valor, 10);
  });
});

// ---------------------------------------------------------------------------
// runHeadless — orquestração fail-soft (mock de fetch, sem rede real)
// ---------------------------------------------------------------------------

describe("#8245 — runHeadless (caminho sem --input)", () => {
  let tmpDir: string;
  let spendPath: string;
  let savedToken: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "meta-ads-headless-"));
    spendPath = join(tmpDir, "spend.csv");
    savedToken = process.env.META_ADS_ACCESS_TOKEN;
    delete process.env.META_ADS_ACCESS_TOKEN;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedToken === undefined) delete process.env.META_ADS_ACCESS_TOKEN;
    else process.env.META_ADS_ACCESS_TOKEN = savedToken;
  });

  it("(a) sem META_ADS_ACCESS_TOKEN: exit 0, spend.csv NUNCA criado/tocado, fetch NUNCA chamado, aviso explícito no console", async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return jsonResponse(200, { data: [] });
    }) as typeof fetch;

    const warnLines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnLines.push(args.join(" "));
    let code: number;
    try {
      code = await runHeadless(spendPath, fetchImpl);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(code, 0);
    assert.equal(fetchCalled, false, "sem token, fetchMetaAdsChannelMetrics não deveria ser chamado");
    assert.equal(existsSync(spendPath), false, "spend.csv não deveria ser criado sem token");
    const combined = warnLines.join("\n");
    // Mesmo contrato do Google/Microsoft (#5237/#5502): marcador genérico de
    // fallback presente, SEM nenhum marcador benigno — é o que faz
    // `classifyRunText` (scripts/lib/ads-spend-ingest-alarm.ts) devolver
    // "defect" pra esse texto, caso um dia o alarme leia o log do Meta.
    assert.match(combined, /fallback pro CSV manual/);
    assert.match(combined, /variável\(is\) de ambiente ausente\(s\): META_ADS_ACCESS_TOKEN/);
    assert.doesNotMatch(combined, /acesso ainda não liberado \(Basic Access na fila/);
    assert.doesNotMatch(combined, /fetch não devolveu nenhuma linha com custo/);
  });

  it("(b) com META_ADS_ACCESS_TOKEN (mockado): grava 'Meta Ads (teste 2608),AAAA-MM' com fonte no formato exigido", async () => {
    process.env.META_ADS_ACCESS_TOKEN = "tok-fake-nunca-logado";
    const fetchImpl = (async () =>
      jsonResponse(200, {
        data: [
          { date_start: "2026-09-05", spend: "170.17", clicks: "3", impressions: "300" },
          { date_start: "2026-09-06", spend: "100.00", clicks: "2", impressions: "200" },
        ],
        paging: {},
      })) as typeof fetch;

    const code = await runHeadless(spendPath, fetchImpl);

    assert.equal(code, 0);
    assert.ok(existsSync(spendPath), "spend.csv deveria ser criado");
    const csv = readFileSync(spendPath, "utf8");
    assert.match(csv, /Meta Ads \(teste 2608\),2026-09,BRL,270\.17,/);
    assert.match(
      csv,
      /Meta Graph API insights \(level=account, time_increment=1\), 2 dia\(s\) \(2026-09-05\.\.2026-09-06\), ingestão automática/,
    );
  });

  it("API responde sem nenhuma linha de gasto: não é falha — spend.csv fica intocado (arquivo nem chega a ser criado)", async () => {
    process.env.META_ADS_ACCESS_TOKEN = "tok-fake";
    const fetchImpl = (async () => jsonResponse(200, { data: [], paging: {} })) as typeof fetch;

    const code = await runHeadless(spendPath, fetchImpl);

    assert.equal(code, 0);
    assert.equal(existsSync(spendPath), false);
  });

  it("erro da Graph API (ex: token inválido): fallback com o erro no texto, exit 0, spend.csv intocado", async () => {
    process.env.META_ADS_ACCESS_TOKEN = "tok-invalido";
    const fetchImpl = (async () => jsonResponse(400, { error: { message: "Invalid OAuth access token", code: 190 } })) as typeof fetch;

    const code = await runHeadless(spendPath, fetchImpl);

    assert.equal(code, 0);
    assert.equal(existsSync(spendPath), false);
  });
});
