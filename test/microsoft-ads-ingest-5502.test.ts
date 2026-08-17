/**
 * test/microsoft-ads-ingest-5502.test.ts (#5502)
 *
 * Cobre `scripts/lib/microsoft-ads-ingest.ts`: normalização
 * CampaignPerformanceReport→SpendRow (incluindo os dois formatos de data
 * aceitos), e o caminho fail-soft (rede/auth nunca lança) — nunca chama a
 * API real. Espelha `test/google-ads-ingest-5237.test.ts` ponto a ponto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateMicrosoftAdsSpendByMonth,
  refreshMicrosoftAdsAccessToken,
  fetchMicrosoftAdsSpendRows,
  runMicrosoftAdsIngest,
  type MicrosoftAdsReportRow,
  type MicrosoftAdsAuthConfig,
  type FetchLike,
} from "../scripts/lib/microsoft-ads-ingest.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";

const AUTH: MicrosoftAdsAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  developerToken: "dev-token",
  customerId: "12345678",
  accountId: "87654321",
};

describe("#5502 — aggregateMicrosoftAdsSpendByMonth", () => {
  it("agrega Spend por mês, formato de data MM/DD/YYYY (default da Reporting API)", () => {
    const rows: MicrosoftAdsReportRow[] = [
      { TimePeriod: "08/01/2026", Spend: "10.50" },
      { TimePeriod: "08/15/2026", Spend: "25.00" },
      { TimePeriod: "07/30/2026", Spend: "5.00" },
    ];

    const out = aggregateMicrosoftAdsSpendByMonth(rows, {
      canal: "Microsoft Advertising",
      moeda: "BRL",
      fonteLabel: "Microsoft Advertising Reporting API",
    });

    assert.equal(out.length, 2);
    const ago = out.find((r) => r.mes === "2026-08")!;
    const jul = out.find((r) => r.mes === "2026-07")!;
    assert.equal(ago.valor, 35.5);
    assert.equal(jul.valor, 5.0);
    assert.equal(ago.canal, "Microsoft Advertising");
    assert.equal(ago.moeda, "BRL");
    assert.match(ago.fonte, /Microsoft Advertising Reporting API/);
    assert.match(ago.fonte, /2 dia\(s\)/);
  });

  it("também aceita TimePeriod em YYYY-MM-DD (robustez a mudança de serialização upstream)", () => {
    const rows: MicrosoftAdsReportRow[] = [{ TimePeriod: "2026-08-01", Spend: 12.34 }];
    const out = aggregateMicrosoftAdsSpendByMonth(rows, { canal: "Microsoft Advertising", moeda: "BRL", fonteLabel: "x" });
    assert.equal(out.length, 1);
    assert.equal(out[0].valor, 12.34);
  });

  it("Spend como number (não só string) também é aceito", () => {
    const rows: MicrosoftAdsReportRow[] = [{ TimePeriod: "08/01/2026", Spend: 9.99 }];
    const out = aggregateMicrosoftAdsSpendByMonth(rows, { canal: "Microsoft Advertising", moeda: "BRL", fonteLabel: "x" });
    assert.equal(out[0].valor, 9.99);
  });

  it("ignora linhas sem TimePeriod, com data não reconhecida, ou sem Spend — nunca soma como zero silencioso", () => {
    const rows: MicrosoftAdsReportRow[] = [
      { Spend: "10.00" },
      { TimePeriod: "08/01/2026" },
      { TimePeriod: "not-a-date", Spend: "10.00" },
      { TimePeriod: "2026-13-99", Spend: "10.00" }, // não casa nenhum dos 2 padrões aceitos
    ];
    assert.deepEqual(
      aggregateMicrosoftAdsSpendByMonth(rows, { canal: "Microsoft Advertising", moeda: "BRL", fonteLabel: "x" }),
      [],
    );
  });

  it("lista vazia de rows produz lista vazia", () => {
    assert.deepEqual(aggregateMicrosoftAdsSpendByMonth([], { canal: "Microsoft Advertising", moeda: "BRL", fonteLabel: "x" }), []);
  });
});

describe("#5502 — refreshMicrosoftAdsAccessToken (fail-soft)", () => {
  it("sucesso devolve o access_token", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ access_token: "tok-123" }), { status: 200 });
    const out = await refreshMicrosoftAdsAccessToken(fetchImpl, AUTH);
    assert.deepEqual(out, { accessToken: "tok-123" });
  });

  it("falha de rede nunca lança — devolve { error }", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const out = await refreshMicrosoftAdsAccessToken(fetchImpl, AUTH);
    assert.ok("error" in out);
    assert.match(out.error, /ECONNREFUSED/);
  });

  it("resposta HTTP de erro (sem access_token) devolve { error }, não lança", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ error_description: "invalid_grant" }), { status: 400 });
    const out = await refreshMicrosoftAdsAccessToken(fetchImpl, AUTH);
    assert.ok("error" in out);
    assert.match(out.error, /invalid_grant/);
  });

  it("corpo não-JSON (ex: HTML de proxy) devolve { error }, não lança", async () => {
    const fetchImpl: FetchLike = async () => new Response("<html>502</html>", { status: 502 });
    const out = await refreshMicrosoftAdsAccessToken(fetchImpl, AUTH);
    assert.ok("error" in out);
  });
});

describe("#5502 — fetchMicrosoftAdsSpendRows (fail-soft)", () => {
  it("sucesso devolve as rows do payload", async () => {
    const rows: MicrosoftAdsReportRow[] = [{ TimePeriod: "08/01/2026", Spend: "10.00" }];
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ rows }), { status: 200 });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", "https://reporting.example/submit");
    assert.deepEqual(out, { rows });
  });

  it("credencial rejeitada/HTTP de erro vira { error }, não lança", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ error: "InvalidCredentials" }), { status: 401 });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", "https://reporting.example/submit");
    assert.ok("error" in out);
  });

  it("falha de rede nunca lança", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", "https://reporting.example/submit");
    assert.ok("error" in out);
  });
});

describe("#5502 — runMicrosoftAdsIngest (orquestração end-to-end, fail-soft)", () => {
  const existingRows: SpendRow[] = [
    { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "painel manual" },
    { canal: "LinkedIn", mes: "2026-08", moeda: "BRL", valor: 0, fonte: "placeholder" },
  ];

  it("caminho feliz: token + Reporting API OK produz merge atualizado", async () => {
    let call = 0;
    const fetchImpl: FetchLike = async (url) => {
      call++;
      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      return new Response(JSON.stringify({ rows: [{ TimePeriod: "08/10/2026", Spend: "50.00" }] }), { status: 200 });
    };

    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows });
    assert.equal(call, 2);
    assert.equal(result.kind, "updated");
    if (result.kind === "updated") {
      assert.equal(result.fetchedRows, 1);
      const ms = result.rows.find((r) => r.canal === "Microsoft Advertising" && r.mes === "2026-08");
      assert.ok(ms);
      assert.equal(ms!.valor, 50);
      // Google Ads e LinkedIn (não recobertos pela query) preservados.
      assert.ok(result.rows.some((r) => r.canal === "Google Ads"));
      assert.ok(result.rows.some((r) => r.canal === "LinkedIn"));
    }
  });

  it("canal default é EXATAMENTE o nome reservado em RESERVED_CHANNEL_NAMES (#5493) — nunca 'Microsoft Ads'/'Bing Ads'", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      return new Response(JSON.stringify({ rows: [{ TimePeriod: "08/10/2026", Spend: "1.00" }] }), { status: 200 });
    };
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows: [] });
    assert.equal(result.kind, "updated");
    if (result.kind === "updated") {
      assert.equal(result.rows[0]?.canal, "Microsoft Advertising");
    }
  });

  it("MCP/API indisponível (falha de token) → fallback, spend.csv não é tocado", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.match(result.reason, /ETIMEDOUT/);
  });

  it("token OK mas Reporting API falha (ex: credencial não emitida) → fallback", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      return new Response(JSON.stringify({ error: "InvalidCredentials" }), { status: 401 });
    };
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows });
    assert.equal(result.kind, "fallback");
  });

  it("Reporting API responde sem nenhuma linha de custo → fallback (nada pra atualizar)", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      return new Response(JSON.stringify({ rows: [] }), { status: 200 });
    };
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows });
    assert.equal(result.kind, "fallback");
  });
});
