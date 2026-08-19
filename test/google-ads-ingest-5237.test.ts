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
  aggregateGaqlSpendByMonthWithDiscards,
  mergeSpendRows,
  refreshGoogleAdsAccessToken,
  fetchGoogleAdsSpendRows,
  runGoogleAdsIngest,
  buildDefaultGaqlQuery,
  classifyGoogleAdsFailure,
  DEFAULT_LOOKBACK_DAYS,
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

describe("#5598 — aggregateGaqlSpendByMonthWithDiscards", () => {
  it("perda PARCIAL: discardedCount bate com o número exato de linhas malformadas, mesmo com linhas válidas", () => {
    const rows: GaqlSpendApiRow[] = [
      { segments: { date: "2026-08-10" }, metrics: { costMicros: "5000000" } }, // válida
      { segments: {}, metrics: { costMicros: "3000000" } }, // descartada: sem data
      { segments: { date: "2026-08-12" }, metrics: {} }, // descartada: sem custo
      { segments: { date: "not-a-date" }, metrics: { costMicros: "1000000" } }, // descartada: data inválida
      { segments: { date: "2026-08-15" }, metrics: { costMicros: "2500000" } }, // válida
    ];

    const out = aggregateGaqlSpendByMonthWithDiscards(rows, {
      canal: "Google Ads",
      moeda: "BRL",
      fonteLabel: "x",
    });

    assert.equal(out.discardedCount, 3);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].mes, "2026-08");
    assert.equal(out.rows[0].valor, 7.5); // (5_000_000 + 2_500_000) / 1e6 — as 3 malformadas nunca contaminam a soma
  });

  it("perda TOTAL: discardedCount === nº de linhas de entrada, agregado vazio", () => {
    const rows: GaqlSpendApiRow[] = [
      { segments: {}, metrics: { costMicros: "1000000" } },
      { segments: { date: "2026-08-01" }, metrics: {} },
    ];
    const out = aggregateGaqlSpendByMonthWithDiscards(rows, { canal: "Google Ads", moeda: "BRL", fonteLabel: "x" });
    assert.equal(out.discardedCount, 2);
    assert.deepEqual(out.rows, []);
  });

  it("sem malformação: discardedCount é 0", () => {
    const rows: GaqlSpendApiRow[] = [{ segments: { date: "2026-08-01" }, metrics: { costMicros: "1000000" } }];
    const out = aggregateGaqlSpendByMonthWithDiscards(rows, { canal: "Google Ads", moeda: "BRL", fonteLabel: "x" });
    assert.equal(out.discardedCount, 0);
  });

  it("aggregateGaqlSpendByMonth continua devolvendo só as rows (atalho preservado)", () => {
    const rows: GaqlSpendApiRow[] = [
      { segments: { date: "2026-08-10" }, metrics: { costMicros: "5000000" } },
      { segments: {}, metrics: { costMicros: "3000000" } },
    ];
    const opts = { canal: "Google Ads", moeda: "BRL", fonteLabel: "x" };
    assert.deepEqual(aggregateGaqlSpendByMonth(rows, opts), aggregateGaqlSpendByMonthWithDiscards(rows, opts).rows);
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
    // Forma REAL do OAuth2 (RFC 6749 §5.2): o código máquina-legível vem em
    // `error`, não em `error_description` (que é só o texto humano). Achado
    // do review do PR #5591, 2ª rodada — o fixture anterior colocava
    // "invalid_grant" em error_description, uma forma que a API real nunca
    // produz, e mascarava o bug de refreshGoogleAdsAccessToken só ler
    // error_description.
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
        { status: 400 },
      );
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

  it("USER_PERMISSION_DENIED com login-customer-id = MCC retenta com login-customer-id = a própria conta (achado ao vivo 19/08/2026)", async () => {
    const rows: GaqlSpendApiRow[] = [{ segments: { date: "2026-08-01" }, metrics: { costMicros: "1000000" } }];
    const loginIdsSeen: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      const loginId = headers["login-customer-id"];
      loginIdsSeen.push(loginId);
      if (loginId === AUTH.loginCustomerId) {
        return new Response(
          JSON.stringify({
            error: {
              details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }] }],
            },
          }),
          { status: 403 },
        );
      }
      // retry com login-customer-id = customerId
      assert.equal(loginId, AUTH.customerId);
      return new Response(JSON.stringify({ results: rows }), { status: 200 });
    };
    const out = await fetchGoogleAdsSpendRows(fetchImpl, AUTH, "tok", "SELECT 1");
    assert.deepEqual(out, { rows });
    assert.deepEqual(loginIdsSeen, [AUTH.loginCustomerId, AUTH.customerId]);
  });

  it("USER_PERMISSION_DENIED continua falhando se o retry com self-login TAMBÉM falhar", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          error: {
            details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }] }],
          },
        }),
        { status: 403 },
      );
    const out = await fetchGoogleAdsSpendRows(fetchImpl, AUTH, "tok", "SELECT 1");
    assert.ok("error" in out);
    assert.equal(out.failureClass, "auth-pending");
  });

  it("não retenta quando login-customer-id configurado JÁ é a própria conta (nunca chama fetch 2x à toa)", async () => {
    let calls = 0;
    const auth: GoogleAdsAuthConfig = { ...AUTH, loginCustomerId: AUTH.customerId };
    const fetchImpl: FetchLike = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          error: {
            details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }] }],
          },
        }),
        { status: 403 },
      );
    };
    const out = await fetchGoogleAdsSpendRows(fetchImpl, auth, "tok", "SELECT 1");
    assert.ok("error" in out);
    assert.equal(calls, 1);
  });

  it("outra classe de 403 (DEVELOPER_TOKEN_NOT_APPROVED) não dispara retry", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          error: {
            details: [{ errors: [{ errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" } }] }],
          },
        }),
        { status: 403 },
      );
    };
    const out = await fetchGoogleAdsSpendRows(fetchImpl, AUTH, "tok", "SELECT 1");
    assert.ok("error" in out);
    assert.equal(calls, 1);
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

// ---------------------------------------------------------------------------
// Regressão do bug encontrado ao vivo em 17/08/2026 (#5237)
//
// A 1ª versão (#5380) mandava `WHERE segments.date DURING LAST_90_DAYS`. Esse
// literal NÃO EXISTE no GAQL: a API responde 400 `INVALID_VALUE_WITH_DURING_
// OPERATOR` em toda versão testada (v22 e v25). Como o GAQL valida a query
// ANTES da autorização, o 400 vinha mesmo com o developer token ainda em
// nível de teste — e o fail-soft o registrava como "API indisponível", igual
// a um `DEVELOPER_TOKEN_NOT_APPROVED`. A ingestão jamais teria funcionado,
// nem depois do Basic Access sair da fila, e nada no output diria isso.
//
// Os corpos abaixo são as respostas REAIS capturadas nessa verificação.
// ---------------------------------------------------------------------------

/**
 * Resposta real da API à query com `DURING LAST_90_DAYS` (v25, 17/08/2026).
 *
 * **Formatada com indentação de propósito** — é assim que a Google Ads API
 * responde de fato, e é o que torna a truncagem relevante: no corpo
 * indentado o `errorCode` só aparece depois do caractere ~300, então o
 * `slice(0, 300)` antigo o cortava fora e o log dizia apenas "HTTP 400".
 * Com `JSON.stringify` compacto o campo cabe em 300 e o teste passaria
 * mesmo com a truncagem antiga — ou seja, não travaria nada.
 */
const REAL_QUERY_ERROR_BODY = JSON.stringify(
  {
    error: {
      code: 400,
      message: "Request contains an invalid argument.",
      status: "INVALID_ARGUMENT",
      details: [
        {
          "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
          errors: [
            {
              errorCode: { queryError: "INVALID_VALUE_WITH_DURING_OPERATOR" },
              message: "Invalid date literal supplied for DURING operator: LAST_90_DAYS.",
            },
          ],
          requestId: "FAk-3h1TY-uJkxzKVt6jJg",
        },
      ],
    },
  },
  null,
  2,
);

/** Resposta real com `login-customer-id` presente (403, 17/08/2026). */
const REAL_USER_PERMISSION_DENIED_BODY = JSON.stringify({
  error: {
    code: 403,
    message: "The caller does not have permission",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.ads.googleads.v22.errors.GoogleAdsFailure",
        errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }],
      },
    ],
  },
});

/** Resposta real sem `login-customer-id` (403, 17/08/2026) — o estado
 *  verdadeiro do projeto: Basic Access ainda na fila. */
const REAL_TOKEN_NOT_APPROVED_BODY = JSON.stringify({
  error: {
    code: 403,
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.ads.googleads.v22.errors.GoogleAdsFailure",
        errors: [{ errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" } }],
      },
    ],
  },
});

describe("#5237 — buildDefaultGaqlQuery (regressão: LAST_90_DAYS não existe)", () => {
  const NOW = new Date("2026-08-17T12:00:00Z");

  it("NUNCA emite o operador DURING nem o literal inválido LAST_90_DAYS", () => {
    const q = buildDefaultGaqlQuery(NOW);
    assert.doesNotMatch(q, /DURING/);
    assert.doesNotMatch(q, /LAST_90_DAYS/);
  });

  it("usa BETWEEN com um range explícito de 90 dias terminando hoje", () => {
    const q = buildDefaultGaqlQuery(NOW);
    // 90 dias INCLUSIVE: 2026-08-17 menos 89 dias = 2026-05-20.
    assert.match(q, /WHERE segments\.date BETWEEN '2026-05-20' AND '2026-08-17'/);
  });

  it("mantém as colunas que aggregateGaqlSpendByMonth consome", () => {
    const q = buildDefaultGaqlQuery(NOW);
    assert.match(q, /segments\.date/);
    assert.match(q, /metrics\.cost_micros/);
  });

  it("a janela é configurável e continua sem literal de data", () => {
    const q = buildDefaultGaqlQuery(NOW, 30);
    assert.match(q, /BETWEEN '2026-07-19' AND '2026-08-17'/);
    assert.doesNotMatch(q, /DURING/);
    assert.equal(DEFAULT_LOOKBACK_DAYS, 90);
  });

  it("runGoogleAdsIngest manda a query construída, não um literal", async () => {
    let sentQuery = "";
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      sentQuery = JSON.parse(String(init?.body)).query;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    await runGoogleAdsIngest(fetchImpl, { auth: AUTH, existingRows: [], now: NOW });
    assert.doesNotMatch(sentQuery, /DURING|LAST_90_DAYS/);
    assert.match(sentQuery, /BETWEEN '2026-05-20' AND '2026-08-17'/);
  });
});

describe("#5237 — classifyGoogleAdsFailure (fail-soft não pode mascarar bug)", () => {
  it("queryError real (LAST_90_DAYS) é DEFEITO, não indisponibilidade", () => {
    assert.equal(classifyGoogleAdsFailure(REAL_QUERY_ERROR_BODY), "defect");
  });

  it("UNSUPPORTED_VERSION é defeito — esperar não conserta versão morta", () => {
    assert.equal(
      classifyGoogleAdsFailure('{"errorCode":{"requestError":"UNSUPPORTED_VERSION"}}'),
      "defect",
    );
  });

  it("DEVELOPER_TOKEN_NOT_APPROVED é auth-pending (estado esperado hoje)", () => {
    assert.equal(classifyGoogleAdsFailure(REAL_TOKEN_NOT_APPROVED_BODY), "auth-pending");
  });

  it("USER_PERMISSION_DENIED é auth-pending, não defeito de header", () => {
    assert.equal(classifyGoogleAdsFailure(REAL_USER_PERMISSION_DENIED_BODY), "auth-pending");
  });

  it("5xx/rede sem código conhecido é transient", () => {
    assert.equal(classifyGoogleAdsFailure("<html>502 Bad Gateway</html>"), "transient");
  });
});

describe("#5237 — classe de falha propagada até o CLI", () => {
  const tokenOk = (body: string, status: number): FetchLike => async (url) =>
    url.includes("oauth2.googleapis.com")
      ? new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })
      : new Response(body, { status });

  it("query malformada chega como failureClass 'defect' (com o errorCode legível)", async () => {
    const result = await runGoogleAdsIngest(tokenOk(REAL_QUERY_ERROR_BODY, 400), {
      auth: AUTH,
      existingRows: [],
      gaqlQuery: "SELECT segments.date FROM customer WHERE segments.date DURING LAST_90_DAYS",
    });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") {
      assert.equal(result.failureClass, "defect");
      // A truncagem antiga (300 chars) cortava o errorCode e foi o que
      // escondeu este bug — o motivo precisa carregá-lo.
      assert.match(result.reason, /INVALID_VALUE_WITH_DURING_OPERATOR/);
    }
  });

  it("token na fila chega como 'auth-pending', não como defeito", async () => {
    const result = await runGoogleAdsIngest(tokenOk(REAL_TOKEN_NOT_APPROVED_BODY, 403), {
      auth: AUTH,
      existingRows: [],
    });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.equal(result.failureClass, "auth-pending");
  });

  it("conta pausada (chamada OK, zero linhas) é 'empty' — zero não é falha", async () => {
    const result = await runGoogleAdsIngest(tokenOk(JSON.stringify({ results: [] }), 200), {
      auth: AUTH,
      existingRows: [],
    });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.equal(result.failureClass, "empty");
  });

  it("gasto zero explícito (costMicros '0') NÃO é 'empty' — é dado válido, atualiza", async () => {
    const body = JSON.stringify({
      results: [{ segments: { date: "2026-08-10" }, metrics: { costMicros: "0" } }],
    });
    const result = await runGoogleAdsIngest(tokenOk(body, 200), { auth: AUTH, existingRows: [] });
    // Linha com custo 0 é dado válido: vira SpendRow de valor 0 e ATUALIZA.
    assert.equal(result.kind, "updated");
    if (result.kind === "updated") {
      assert.equal(result.rows.find((r) => r.canal === "Google Ads")?.valor, 0);
    }
  });

  it("falha de rede continua 'transient'", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const result = await runGoogleAdsIngest(fetchImpl, { auth: AUTH, existingRows: [] });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.equal(result.failureClass, "transient");
  });
});

describe("#5237 — 'empty' não pode encobrir schema drift (achado do review do PR #5591)", () => {
  const tokenThen = (body: string, status = 200): FetchLike => async (url) =>
    url.includes("oauth2.googleapis.com")
      ? new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })
      : new Response(body, { status });

  it("API devolve linhas mas a agregação descarta TODAS → 'defect', não 'empty'", async () => {
    // Cenário de schema drift: o Google renomeia `costMicros`, e
    // `aggregateGaqlSpendByMonth` (que pula linha malformada em silêncio por
    // design) devolve zero linhas. O gasto EXISTE; nós é que não sabemos ler.
    // Reportar isso como "gasto zero, conta pausada" seria mascarar o bug —
    // e em silêncio justo quando a #5524 começar a gastar.
    const drifted = JSON.stringify({
      results: [
        { segments: { date: "2026-08-10" }, metrics: { cost_micros_v2: "5000000" } },
        { segments: { date: "2026-08-11" }, metrics: { cost_micros_v2: "3000000" } },
      ],
    });
    const result = await runGoogleAdsIngest(tokenThen(drifted), { auth: AUTH, existingRows: [] });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.equal(result.failureClass, "defect");
  });

  it("API devolve ZERO linhas → 'empty' (conta pausada é resposta legítima)", async () => {
    const result = await runGoogleAdsIngest(tokenThen(JSON.stringify({ results: [] })), {
      auth: AUTH,
      existingRows: [],
    });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.equal(result.failureClass, "empty");
  });

  it("agregação parcial (algumas linhas válidas) atualiza normalmente", async () => {
    const mixed = JSON.stringify({
      results: [
        { segments: { date: "2026-08-10" }, metrics: { costMicros: "5000000" } },
        { segments: {}, metrics: { costMicros: "3000000" } }, // descartada
      ],
    });
    const result = await runGoogleAdsIngest(tokenThen(mixed), { auth: AUTH, existingRows: [] });
    assert.equal(result.kind, "updated");
  });
});

describe("#5598 — perda parcial na agregação fica visível (discardedCount + warning), não some em silêncio", () => {
  const tokenThen = (body: string, status = 200): FetchLike => async (url) =>
    url.includes("oauth2.googleapis.com")
      ? new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })
      : new Response(body, { status });

  it("resultado 'updated' expõe discardedCount batendo com o nº exato de linhas descartadas", async () => {
    const mixed = JSON.stringify({
      results: [
        { segments: { date: "2026-08-10" }, metrics: { costMicros: "5000000" } }, // válida
        { segments: {}, metrics: { costMicros: "3000000" } }, // descartada: sem data
        { segments: { date: "2026-08-12" }, metrics: {} }, // descartada: sem custo
      ],
    });
    const result = await runGoogleAdsIngest(tokenThen(mixed), { auth: AUTH, existingRows: [] });
    assert.equal(result.kind, "updated");
    if (result.kind === "updated") {
      assert.equal(result.discardedCount, 2);
      assert.equal(result.fetchedRows, 3); // linhas GAQL BRUTAS, não o nº de meses agregados
    }
  });

  it("discardedCount > 0 emite console.warn no caminho de SUCESSO, sem virar defect/exit não-zero", async () => {
    const mixed = JSON.stringify({
      results: [
        { segments: { date: "2026-08-10" }, metrics: { costMicros: "5000000" } },
        { segments: {}, metrics: { costMicros: "3000000" } },
      ],
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const result = await runGoogleAdsIngest(tokenThen(mixed), { auth: AUTH, existingRows: [] });
      assert.equal(result.kind, "updated");
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(warnings.some((w) => w.includes("1") && /descartad/.test(w)));
  });

  it("discardedCount === 0 (nenhuma linha malformada) NÃO emite warning", async () => {
    const clean = JSON.stringify({
      results: [{ segments: { date: "2026-08-10" }, metrics: { costMicros: "5000000" } }],
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const result = await runGoogleAdsIngest(tokenThen(clean), { auth: AUTH, existingRows: [] });
      assert.equal(result.kind, "updated");
      if (result.kind === "updated") assert.equal(result.discardedCount, 0);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 0);
  });

  it("perda TOTAL continua caindo em 'defect' (fallback), não em 'updated' com discardedCount", async () => {
    const drifted = JSON.stringify({
      results: [{ segments: { date: "2026-08-10" }, metrics: { cost_micros_v2: "5000000" } }],
    });
    const result = await runGoogleAdsIngest(tokenThen(drifted), { auth: AUTH, existingRows: [] });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.equal(result.failureClass, "defect");
  });
});

describe("#5237 — falha de refresh token é classificada (achado do review do PR #5591)", () => {
  it("invalid_grant (refresh token revogado) é 'defect' — esperar não conserta", async () => {
    // Corpo real do endpoint de token do Google OAuth2 pra refresh token
    // revogado/expirado — `error` (não `error_description`) carrega o
    // código máquina-legível. 2ª rodada de review do PR #5591 achou que o
    // fixture anterior ("invalid_grant" só em error_description) não batia
    // com a forma real e mascarava o mesmo bug que este teste deveria travar.
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
        { status: 400 },
      );
    const result = await runGoogleAdsIngest(fetchImpl, { auth: AUTH, existingRows: [] });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.equal(result.failureClass, "defect");
  });

  it("falha de rede na renovação continua 'transient'", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await runGoogleAdsIngest(fetchImpl, { auth: AUTH, existingRows: [] });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.equal(result.failureClass, "transient");
  });

  it("OAUTH_TOKEN_INVALID é defeito de credencial, não fila do Basic Access", () => {
    assert.equal(
      classifyGoogleAdsFailure('{"errorCode":{"authenticationError":"OAUTH_TOKEN_INVALID"}}'),
      "defect",
    );
  });
});

describe("#5237 — truncagem 300→600 preserva o errorCode (regressão real)", () => {
  it("o corpo REAL (indentado, como a API responde) esconde o errorCode em 300 chars", () => {
    // Se isto falhar, o fixture virou compacto e o teste abaixo deixou de
    // travar coisa nenhuma — foi exatamente o furo apontado no review.
    assert.equal(REAL_QUERY_ERROR_BODY.slice(0, 300).includes("INVALID_VALUE_WITH_DURING_OPERATOR"), false);
    assert.equal(REAL_QUERY_ERROR_BODY.slice(0, 600).includes("INVALID_VALUE_WITH_DURING_OPERATOR"), true);
  });

  it("fetchGoogleAdsSpendRows preserva o errorCode na mensagem de erro", async () => {
    const fetchImpl: FetchLike = async () => new Response(REAL_QUERY_ERROR_BODY, { status: 400 });
    const out = await fetchGoogleAdsSpendRows(fetchImpl, AUTH, "tok", "SELECT 1");
    assert.ok("error" in out);
    if ("error" in out) {
      assert.match(out.error, /INVALID_VALUE_WITH_DURING_OPERATOR/);
      assert.equal(out.failureClass, "defect");
    }
  });
});
