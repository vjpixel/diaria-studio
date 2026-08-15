/**
 * test/google-ads-ingest-5237.test.ts (#5237)
 *
 * Cobre `scripts/lib/google-ads-ingest.ts`: agregação GAQL→SpendRow, merge
 * idempotente em cima do `spend.csv` existente, e o caminho fail-soft
 * (item 5 do checklist da issue) que precisa devolver `{ kind: "fallback" }`
 * em vez de lançar sempre que rede/auth falha — nunca chama a API real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateGaqlSpendByMonth,
  mergeSpendRows,
  refreshGoogleAdsAccessToken,
  fetchGoogleAdsSpendRows,
  runGoogleAdsIngest,
  type GaqlSpendApiRow,
  type GoogleAdsAuthConfig,
  type FetchLike,
} from "../scripts/lib/google-ads-ingest.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";

const AUTH: GoogleAdsAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  developerToken: "dev-token",
  loginCustomerId: "6236094249",
  customerId: "2369219639",
};

describe("#5237 — aggregateGaqlSpendByMonth", () => {
  it("agrega cost_micros por mês, convertendo pra unidade decimal", () => {
    const rows: GaqlSpendApiRow[] = [
      { segments: { date: "2026-08-01" }, metrics: { costMicros: "1000000" } },
      { segments: { date: "2026-08-15" }, metrics: { costMicros: "2500000" } },
      { segments: { date: "2026-07-30" }, metrics: { costMicros: "500000" } },
    ];

    const out = aggregateGaqlSpendByMonth(rows, {
      canal: "Google Ads",
      moeda: "BRL",
      fonteLabel: "Google Ads API (MCP oficial)",
    });

    assert.equal(out.length, 2);
    const ago = out.find((r) => r.mes === "2026-08")!;
    const jul = out.find((r) => r.mes === "2026-07")!;
    assert.equal(ago.valor, 3.5); // (1_000_000 + 2_500_000) / 1e6
    assert.equal(jul.valor, 0.5);
    assert.equal(ago.canal, "Google Ads");
    assert.equal(ago.moeda, "BRL");
    assert.match(ago.fonte, /Google Ads API \(MCP oficial\)/);
    assert.match(ago.fonte, /2 dia\(s\)/);
  });

  it("costMicros como number (não só string) também é aceito", () => {
    const rows: GaqlSpendApiRow[] = [{ segments: { date: "2026-08-01" }, metrics: { costMicros: 999999 } }];
    const out = aggregateGaqlSpendByMonth(rows, { canal: "Google Ads", moeda: "BRL", fonteLabel: "x" });
    assert.equal(out.length, 1);
    assert.equal(out[0].valor, 1.0); // arredondado pra 2 casas
  });

  it("ignora linhas sem data ou sem custo — nunca soma como zero silencioso", () => {
    const rows: GaqlSpendApiRow[] = [
      { segments: {}, metrics: { costMicros: "1000000" } },
      { segments: { date: "2026-08-01" }, metrics: {} },
      { segments: { date: "not-a-date" }, metrics: { costMicros: "1000000" } },
    ];
    assert.deepEqual(aggregateGaqlSpendByMonth(rows, { canal: "Google Ads", moeda: "BRL", fonteLabel: "x" }), []);
  });

  it("lista vazia de rows produz lista vazia", () => {
    assert.deepEqual(aggregateGaqlSpendByMonth([], { canal: "Google Ads", moeda: "BRL", fonteLabel: "x" }), []);
  });
});

describe("#5237 — mergeSpendRows", () => {
  const existing: SpendRow[] = [
    { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "painel manual" },
    { canal: "Beehiiv Boosts", mes: "2026-07", moeda: "BRL", valor: 397.08, fonte: "painel manual" },
    { canal: "LinkedIn", mes: "2026-08", moeda: "BRL", valor: 0, fonte: "placeholder" },
  ];

  it("substitui a linha existente do mesmo (canal, mes) — idempotente em re-execução", () => {
    const incoming: SpendRow[] = [
      { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 1000, fonte: "GAQL" },
    ];
    const merged = mergeSpendRows(existing, incoming);
    assert.equal(merged.length, 3);
    const ga = merged.find((r) => r.canal === "Google Ads" && r.mes === "2026-02")!;
    assert.equal(ga.valor, 1000);
    assert.equal(ga.fonte, "GAQL");
  });

  it("preserva linhas de outros canais/meses intactas", () => {
    const incoming: SpendRow[] = [
      { canal: "Google Ads", mes: "2026-08", moeda: "BRL", valor: 42, fonte: "GAQL" },
    ];
    const merged = mergeSpendRows(existing, incoming);
    assert.equal(merged.length, 4);
    assert.ok(merged.some((r) => r.canal === "Beehiiv Boosts"));
    assert.ok(merged.some((r) => r.canal === "LinkedIn"));
    assert.ok(merged.some((r) => r.canal === "Google Ads" && r.mes === "2026-02" && r.valor === 956.21));
    assert.ok(merged.some((r) => r.canal === "Google Ads" && r.mes === "2026-08" && r.valor === 42));
  });

  it("aplicar o mesmo incoming duas vezes seguidas não duplica (idempotência)", () => {
    const incoming: SpendRow[] = [
      { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 1000, fonte: "GAQL" },
    ];
    const once = mergeSpendRows(existing, incoming);
    const twice = mergeSpendRows(once, incoming);
    assert.equal(twice.length, once.length);
  });
});

describe("#5237 — refreshGoogleAdsAccessToken (fail-soft)", () => {
  it("sucesso devolve o access_token", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ access_token: "tok-123" }), { status: 200 });
    const out = await refreshGoogleAdsAccessToken(fetchImpl, AUTH);
    assert.deepEqual(out, { accessToken: "tok-123" });
  });

  it("falha de rede nunca lança — devolve { error }", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const out = await refreshGoogleAdsAccessToken(fetchImpl, AUTH);
    assert.ok("error" in out);
    assert.match(out.error, /ECONNREFUSED/);
  });

  it("resposta HTTP de erro (sem access_token) devolve { error }, não lança", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ error_description: "invalid_grant" }), { status: 400 });
    const out = await refreshGoogleAdsAccessToken(fetchImpl, AUTH);
    assert.ok("error" in out);
    assert.match(out.error, /invalid_grant/);
  });

  it("corpo não-JSON (ex: HTML de proxy) devolve { error }, não lança", async () => {
    const fetchImpl: FetchLike = async () => new Response("<html>502</html>", { status: 502 });
    const out = await refreshGoogleAdsAccessToken(fetchImpl, AUTH);
    assert.ok("error" in out);
  });
});

describe("#5237 — fetchGoogleAdsSpendRows (fail-soft)", () => {
  it("sucesso devolve as rows do payload", async () => {
    const rows: GaqlSpendApiRow[] = [{ segments: { date: "2026-08-01" }, metrics: { costMicros: "1000000" } }];
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ results: rows }), { status: 200 });
    const out = await fetchGoogleAdsSpendRows(fetchImpl, AUTH, "tok", "SELECT 1");
    assert.deepEqual(out, { rows });
  });

  it("DEVELOPER_TOKEN_NOT_APPROVED (estado atual real do projeto) vira { error }, não lança", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          error: {
            details: [{ errors: [{ errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" } }] }],
          },
        }),
        { status: 403 },
      );
    const out = await fetchGoogleAdsSpendRows(fetchImpl, AUTH, "tok", "SELECT 1");
    assert.ok("error" in out);
  });

  it("falha de rede nunca lança", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const out = await fetchGoogleAdsSpendRows(fetchImpl, AUTH, "tok", "SELECT 1");
    assert.ok("error" in out);
  });
});

describe("#5237 — runGoogleAdsIngest (orquestração end-to-end, fail-soft)", () => {
  const existingRows: SpendRow[] = [
    { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "painel manual" },
    { canal: "LinkedIn", mes: "2026-08", moeda: "BRL", valor: 0, fonte: "placeholder" },
  ];

  it("caminho feliz: token + GAQL OK produz merge atualizado", async () => {
    let call = 0;
    const fetchImpl: FetchLike = async (url) => {
      call++;
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          results: [{ segments: { date: "2026-08-10" }, metrics: { costMicros: "5000000" } }],
        }),
        { status: 200 },
      );
    };

    const result = await runGoogleAdsIngest(fetchImpl, { auth: AUTH, existingRows });
    assert.equal(call, 2);
    assert.equal(result.kind, "updated");
    if (result.kind === "updated") {
      assert.equal(result.fetchedRows, 1);
      const ga = result.rows.find((r) => r.canal === "Google Ads" && r.mes === "2026-08");
      assert.ok(ga);
      assert.equal(ga!.valor, 5);
      // Fevereiro (não recoberto pela query fixture) e LinkedIn preservados.
      assert.ok(result.rows.some((r) => r.canal === "Google Ads" && r.mes === "2026-02"));
      assert.ok(result.rows.some((r) => r.canal === "LinkedIn"));
    }
  });

  it("MCP/API indisponível (falha de token) → fallback, spend.csv não é tocado", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const result = await runGoogleAdsIngest(fetchImpl, { auth: AUTH, existingRows });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.match(result.reason, /ETIMEDOUT/);
  });

  it("token OK mas GAQL falha (ex: DEVELOPER_TOKEN_NOT_APPROVED) → fallback", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "DEVELOPER_TOKEN_NOT_APPROVED" }), { status: 403 });
    };
    const result = await runGoogleAdsIngest(fetchImpl, { auth: AUTH, existingRows });
    assert.equal(result.kind, "fallback");
  });

  it("GAQL responde sem nenhuma linha de custo → fallback (nada pra atualizar)", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    const result = await runGoogleAdsIngest(fetchImpl, { auth: AUTH, existingRows });
    assert.equal(result.kind, "fallback");
  });
});
