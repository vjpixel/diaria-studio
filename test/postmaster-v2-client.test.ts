/**
 * test/postmaster-v2-client.test.ts (#4704)
 *
 * Cobre só as partes puras/testáveis de scripts/lib/postmaster-v2-client.ts
 * (sem I/O de rede real). O shape de resposta usado nos fixtures abaixo (nos
 * testes de `extractSpamRateReadingsV2` e no fake fetch de
 * `queryDomainStatsV2`) é o shape REAL devolvido pela API — confirmado ao
 * vivo em 260806 via probe direto contra `domains/clarice.ai/domainStats:query`
 * (métrica `SPAM_RATE`, 01–06/08/2026): dias 01 e 03/08 vieram com
 * `floatValue: 0`, dia 02/08 com `floatValue: 0.0041067763`, e os dias
 * 04–06/08 (sem tráfego publicado ainda) simplesmente NÃO apareceram na
 * lista `domainStats` — não um `floatValue` zerado, ausência total da
 * entrada. É esse "ausência = sem dado" que `extractSpamRateReadingsV2`
 * precisa preservar (nunca inventar um dia que a API não devolveu).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDomainStatsQueryBody,
  calendarDateToEntryDate,
  extractSpamRateReadingsV2,
  extractFeedbackLoopIdsV2,
  queryDomainStatsV2,
} from "../scripts/lib/postmaster-v2-client.ts";

// ── buildDomainStatsQueryBody ──

test("buildDomainStatsQueryBody — monta parent/timeQuery/metricDefinitions no shape da API", () => {
  const body = buildDomainStatsQueryBody(
    "clarice.ai",
    [{ name: "spam_rate", standardMetric: "SPAM_RATE" }],
    { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 6 } },
  );
  assert.deepEqual(body, {
    parent: "domains/clarice.ai",
    aggregationGranularity: "DAILY",
    timeQuery: {
      dateRanges: {
        dateRanges: [
          { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 6 } },
        ],
      },
    },
    metricDefinitions: [{ name: "spam_rate", baseMetric: { standardMetric: "SPAM_RATE" } }],
  });
});

test("buildDomainStatsQueryBody — inclui filter só quando a métrica declara um (FEEDBACK_LOOP_SPAM_RATE)", () => {
  const body = buildDomainStatsQueryBody(
    "clarice.ai",
    [{ name: "fbl_107", standardMetric: "FEEDBACK_LOOP_SPAM_RATE", filter: 'feedback_loop_id = "11130585_107"' }],
    { start: { year: 2026, month: 8, day: 2 }, end: { year: 2026, month: 8, day: 2 } },
  );
  const defs = body.metricDefinitions as Array<Record<string, unknown>>;
  assert.equal(defs[0].filter, 'feedback_loop_id = "11130585_107"');
});

test("buildDomainStatsQueryBody — metricDefinitions vazio lança erro explícito (nunca manda request sem métrica)", () => {
  assert.throws(
    () => buildDomainStatsQueryBody("clarice.ai", [], { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 1 } }),
    /metricDefinitions vazio/,
  );
});

// ── calendarDateToEntryDate ──

test("calendarDateToEntryDate — CalendarDate vira YYYY-MM-DD com zero-padding", () => {
  assert.equal(calendarDateToEntryDate({ year: 2026, month: 8, day: 1 }), "2026-08-01");
  assert.equal(calendarDateToEntryDate({ year: 2026, month: 12, day: 31 }), "2026-12-31");
});

// ── extractSpamRateReadingsV2 ──

test("extractSpamRateReadingsV2 — extrai value.floatValue por dia, filtrando pelo nome da métrica pedida", () => {
  // Fixture = resposta REAL do probe de 260806 (clarice.ai, 01-03/08).
  const response = {
    domainStats: [
      { name: "domains/clarice.ai/domainStats/spamrate.nofilter.20260801", metric: "spam_rate", date: { year: 2026, month: 8, day: 1 }, value: { floatValue: 0 } },
      { name: "domains/clarice.ai/domainStats/spamrate.nofilter.20260802", metric: "spam_rate", date: { year: 2026, month: 8, day: 2 }, value: { floatValue: 0.0041067763 } },
      { name: "domains/clarice.ai/domainStats/spamrate.nofilter.20260803", metric: "spam_rate", date: { year: 2026, month: 8, day: 3 }, value: { floatValue: 0 } },
    ],
  };
  const readings = extractSpamRateReadingsV2(response, "spam_rate");
  assert.deepEqual(readings, [
    { date: "2026-08-01", ratio: 0 },
    { date: "2026-08-02", ratio: 0.0041067763 },
    { date: "2026-08-03", ratio: 0 },
  ]);
});

test("extractSpamRateReadingsV2 — dias ausentes na resposta simplesmente não aparecem (nunca virar 0 inventado, ver docstring do arquivo)", () => {
  // Cenário real do probe de 260806: janela pedida 01-06/08, API só devolveu 3 dias (04-06 sem tráfego publicado ainda).
  const response = {
    domainStats: [
      { metric: "spam_rate", date: { year: 2026, month: 8, day: 1 }, value: { floatValue: 0 } },
      { metric: "spam_rate", date: { year: 2026, month: 8, day: 2 }, value: { floatValue: 0.0041067763 } },
      { metric: "spam_rate", date: { year: 2026, month: 8, day: 3 }, value: { floatValue: 0 } },
    ],
  };
  const readings = extractSpamRateReadingsV2(response, "spam_rate");
  assert.equal(readings.length, 3, "só os 3 dias que a API de fato devolveu — não inventa 04/05/06");
  assert.ok(!readings.some((r) => r.date === "2026-08-04"));
});

test("extractSpamRateReadingsV2 — ignora métricas de outro nome (resposta com múltiplas metricDefinitions na mesma query)", () => {
  const response = {
    domainStats: [
      { metric: "spam_rate", date: { year: 2026, month: 8, day: 1 }, value: { floatValue: 0.01 } },
      { metric: "auth_rate", date: { year: 2026, month: 8, day: 1 }, value: { floatValue: 0.99 } },
    ],
  };
  assert.deepEqual(extractSpamRateReadingsV2(response, "spam_rate"), [{ date: "2026-08-01", ratio: 0.01 }]);
});

test("extractSpamRateReadingsV2 — entrada sem value.floatValue numérico (ex: só intValue/stringValue, ou value ausente) é ignorada, não vira NaN/0 silencioso", () => {
  const response = {
    domainStats: [
      { metric: "spam_rate", date: { year: 2026, month: 8, day: 1 }, value: { floatValue: 0.02 } },
      { metric: "spam_rate", date: { year: 2026, month: 8, day: 2 }, value: { intValue: "5" } }, // sem floatValue
      { metric: "spam_rate", date: { year: 2026, month: 8, day: 3 } }, // sem value nenhum
    ],
  };
  assert.deepEqual(extractSpamRateReadingsV2(response, "spam_rate"), [{ date: "2026-08-01", ratio: 0.02 }]);
});

// ── queryDomainStatsV2 (I/O via fetchImpl injetado) ──

test("queryDomainStatsV2 — 200: retorna domainStats parseado (shape real confirmado ao vivo em 260806)", async () => {
  const fake = (async () =>
    new Response(
      JSON.stringify({
        domainStats: [
          { name: "domains/clarice.ai/domainStats/spamrate.nofilter.20260801", value: { floatValue: 0 }, date: { year: 2026, month: 8, day: 1 }, metric: "spam_rate" },
          { name: "domains/clarice.ai/domainStats/spamrate.nofilter.20260802", value: { floatValue: 0.0041067763 }, date: { year: 2026, month: 8, day: 2 }, metric: "spam_rate" },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const result = await queryDomainStatsV2(
    "clarice.ai",
    [{ name: "spam_rate", standardMetric: "SPAM_RATE" }],
    { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 2 } },
    fake,
  );
  assert.equal(result.domainStats.length, 2);
});

test("queryDomainStatsV2 — 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT aponta pro oauth-setup.ts (#4704)", async () => {
  const fake = (async () =>
    new Response('{"error":{"message":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}}', { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      queryDomainStatsV2("clarice.ai", [{ name: "spam_rate", standardMetric: "SPAM_RATE" }], { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 1 } }, fake),
    /oauth-setup\.ts/,
  );
});

test("queryDomainStatsV2 — 403 SERVICE_DISABLED aponta pro console GCP", async () => {
  const fake = (async () => new Response('{"error":{"message":"SERVICE_DISABLED"}}', { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      queryDomainStatsV2("clarice.ai", [{ name: "spam_rate", standardMetric: "SPAM_RATE" }], { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 1 } }, fake),
    /console\.cloud\.google\.com/,
  );
});

test("queryDomainStatsV2 — 401 pós-retry aponta pro oauth-setup.ts (refresh token revogado, #4585 mesmo padrão do #4539)", async () => {
  const fake = (async () => new Response('{"error":{"status":"UNAUTHENTICATED"}}', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      queryDomainStatsV2("clarice.ai", [{ name: "spam_rate", standardMetric: "SPAM_RATE" }], { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 1 } }, fake),
    /oauth-setup\.ts/,
  );
});

test("queryDomainStatsV2 — 403 sem código de scope/API reconhecido aponta pra permissão de domínio, não pro fallback genérico", async () => {
  const fake = (async () =>
    new Response('{"error":{"message":"The caller does not have permission"}}', { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      queryDomainStatsV2("clarice.ai", [{ name: "spam_rate", standardMetric: "SPAM_RATE" }], { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 1 } }, fake),
    /postmaster\.google\.com\/managedomains/,
  );
});

test("queryDomainStatsV2 — 429 aponta pra outro consumidor de quota/execução concorrente, não pro fallback genérico (#4716)", async () => {
  const fake = (async () => new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      queryDomainStatsV2("clarice.ai", [{ name: "spam_rate", standardMetric: "SPAM_RATE" }], { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 1 } }, fake),
    /execução concorrente/,
  );
});

test("queryDomainStatsV2 — status HTTP inesperado (ex: 500) cai no fallback genérico com o corpo truncado, nunca vira sucesso silencioso", async () => {
  const fake = (async () => new Response('{"error":{"status":"INTERNAL"}}', { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      queryDomainStatsV2("clarice.ai", [{ name: "spam_rate", standardMetric: "SPAM_RATE" }], { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 1 } }, fake),
    /HTTP 500 inesperado/,
  );
});

test("buildDomainStatsQueryBody — FEEDBACK_LOOP_SPAM_RATE sem filter lança erro explícito (nunca manda request malformado, #4711 fleet review)", () => {
  assert.throws(
    () =>
      buildDomainStatsQueryBody(
        "clarice.ai",
        [{ name: "fbl", standardMetric: "FEEDBACK_LOOP_SPAM_RATE" }],
        { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 1 } },
      ),
    /FEEDBACK_LOOP_SPAM_RATE sem filter/,
  );
});

test("extractSpamRateReadingsV2 — cai em doubleValue quando floatValue está ausente (fallback defensivo, #4711 fleet review)", () => {
  const response = {
    domainStats: [{ metric: "spam_rate", date: { year: 2026, month: 8, day: 1 }, value: { doubleValue: 0.03 } }],
  };
  assert.deepEqual(extractSpamRateReadingsV2(response, "spam_rate"), [{ date: "2026-08-01", ratio: 0.03 }]);
});

test("queryDomainStatsV2 — resposta 2xx não-JSON erra com contexto (proxy/truncamento), nunca lança SyntaxError cru", async () => {
  const fake = (async () => new Response("<html>proxy interceptou</html>", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      queryDomainStatsV2("clarice.ai", [{ name: "spam_rate", standardMetric: "SPAM_RATE" }], { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 1 } }, fake),
    /não é JSON válido.*proxy interceptou/s,
  );
});

// ── extractFeedbackLoopIdsV2 (#4704 — spam POR CAMPANHA) ──

test("extractFeedbackLoopIdsV2 — fixture real 260806: extrai a lista de ids por dia (métrica FEEDBACK_LOOP_ID)", () => {
  // Shape confirmado ao vivo pelo editor no comentário da #4704: 27/07 e 02/08.
  const response = {
    domainStats: [
      {
        metric: "feedback_loop_id",
        date: { year: 2026, month: 7, day: 27 },
        value: { stringList: ["11130585", "11130585_99", "77.32.148.101"] },
      },
      {
        metric: "feedback_loop_id",
        date: { year: 2026, month: 8, day: 2 },
        value: { stringList: ["11130585", "11130585_105", "11130585_106", "11130585_107", "77.32.148.101"] },
      },
    ],
  };
  const result = extractFeedbackLoopIdsV2(response, "feedback_loop_id");
  assert.deepEqual(result, [
    { date: "2026-07-27", ids: ["11130585", "11130585_99", "77.32.148.101"] },
    { date: "2026-08-02", ids: ["11130585", "11130585_105", "11130585_106", "11130585_107", "77.32.148.101"] },
  ]);
});

test("extractFeedbackLoopIdsV2 — dia sem stringList (ausente ou vazio) não aparece no resultado (ausência ≠ lista vazia)", () => {
  const response = {
    domainStats: [
      { metric: "feedback_loop_id", date: { year: 2026, month: 8, day: 1 }, value: { stringList: [] } },
      { metric: "feedback_loop_id", date: { year: 2026, month: 8, day: 2 } }, // sem value
      { metric: "feedback_loop_id", date: { year: 2026, month: 8, day: 3 }, value: { stringList: ["11130585_50"] } },
    ],
  };
  const result = extractFeedbackLoopIdsV2(response, "feedback_loop_id");
  assert.deepEqual(result, [{ date: "2026-08-03", ids: ["11130585_50"] }]);
});

test("extractFeedbackLoopIdsV2 — ignora entradas de métrica diferente (query com múltiplas metricDefinitions)", () => {
  const response = {
    domainStats: [
      { metric: "feedback_loop_id", date: { year: 2026, month: 8, day: 1 }, value: { stringList: ["11130585_50"] } },
      { metric: "spam_rate", date: { year: 2026, month: 8, day: 1 }, value: { floatValue: 0.01 } },
    ],
  };
  assert.deepEqual(extractFeedbackLoopIdsV2(response, "feedback_loop_id"), [
    { date: "2026-08-01", ids: ["11130585_50"] },
  ]);
});

test("queryDomainStatsV2 — domainStats ausente na resposta 200 vira array vazio, nunca undefined (mesma disciplina de listDomains em postmaster-register-domain.ts)", async () => {
  const fake = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  const result = await queryDomainStatsV2(
    "clarice.ai",
    [{ name: "spam_rate", standardMetric: "SPAM_RATE" }],
    { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 1 } },
    fake,
  );
  assert.deepEqual(result.domainStats, []);
});

// ── queryDomainStatsV2 — paginação (#4972: nextPageToken nunca era drenado, janela > 10 dias perdia os dias MAIS RECENTES) ──

test("queryDomainStatsV2 — sem paginação (resposta cabe numa página, sem nextPageToken) faz exatamente 1 chamada e não muda o comportamento anterior", async () => {
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        domainStats: [
          { metric: "spam_rate", date: { year: 2026, month: 8, day: 1 }, value: { floatValue: 0 } },
          { metric: "spam_rate", date: { year: 2026, month: 8, day: 2 }, value: { floatValue: 0.01 } },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await queryDomainStatsV2(
    "clarice.ai",
    [{ name: "spam_rate", standardMetric: "SPAM_RATE" }],
    { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 2 } },
    fake,
  );

  assert.equal(calls, 1, "resposta sem nextPageToken não deve disparar uma 2ª chamada");
  assert.equal(result.domainStats.length, 2);
  assert.equal(result.nextPageToken, undefined, "totalmente drenado — nextPageToken final deve ser undefined");
});

test("queryDomainStatsV2 — drena TODAS as páginas até nextPageToken vazio, agregando entradas de todas elas — incluindo os dias MAIS RECENTES que ficariam de fora sem o fix (#4972)", async () => {
  // Réplica do achado ao vivo: janela grande devolve N páginas pequenas, mais
  // antiga → mais nova. Sem drenar, os dias 11-13/08 (última página, sem
  // token) nunca apareceriam no resultado.
  const pages = [
    {
      domainStats: Array.from({ length: 10 }, (_, i) => ({
        metric: "spam_rate",
        date: { year: 2026, month: 8, day: i + 1 },
        value: { floatValue: 0.001 * (i + 1) },
      })),
      nextPageToken: "page-2-token",
    },
    {
      domainStats: Array.from({ length: 10 }, (_, i) => ({
        metric: "spam_rate",
        date: { year: 2026, month: 8, day: i + 11 },
        value: { floatValue: 0.001 * (i + 11) },
      })),
      nextPageToken: "page-3-token",
    },
    {
      // Última página: SEM nextPageToken — carrega os dias mais recentes da janela (21/08 = dia 21).
      domainStats: Array.from({ length: 3 }, (_, i) => ({
        metric: "spam_rate",
        date: { year: 2026, month: 8, day: i + 19 },
        value: { floatValue: 0.001 * (i + 19) },
      })),
    },
  ];

  const requestedPageTokens: (string | undefined)[] = [];
  let callIndex = 0;
  const fake = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    requestedPageTokens.push(body.pageToken);
    const page = pages[callIndex];
    callIndex += 1;
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await queryDomainStatsV2(
    "clarice.ai",
    [{ name: "spam_rate", standardMetric: "SPAM_RATE" }],
    { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 21 } },
    fake,
  );

  assert.equal(callIndex, 3, "deve ter feito exatamente 3 chamadas — 1 por página");
  assert.equal(result.domainStats.length, 23, "10 + 10 + 3 = 23 entradas de TODAS as páginas agregadas");
  assert.equal(result.nextPageToken, undefined, "totalmente drenado — nextPageToken final deve ser undefined");

  // Confirma que o pageToken de cada resposta é reenviado na próxima chamada.
  assert.deepEqual(requestedPageTokens, [undefined, "page-2-token", "page-3-token"]);

  // O achado central do #4972: os dias MAIS RECENTES (só presentes na última
  // página, que não tem nextPageToken) precisam aparecer no resultado final.
  const readings = extractSpamRateReadingsV2(result, "spam_rate");
  assert.ok(readings.some((r) => r.date === "2026-08-19"));
  assert.ok(readings.some((r) => r.date === "2026-08-20"));
  assert.ok(readings.some((r) => r.date === "2026-08-21"), "dia mais recente da janela — o que sumia antes do fix");
});

test("queryDomainStatsV2 — guard de sanidade: teto de páginas evita loop infinito se a API nunca parar de devolver nextPageToken, e loga warning (nunca trava silenciosamente, #4972)", async () => {
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        domainStats: [{ metric: "spam_rate", date: { year: 2026, month: 8, day: 1 }, value: { floatValue: 0 } }],
        nextPageToken: `token-${calls}`, // nunca fica vazio — simula bug de paginação da API
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const originalWarn = console.warn;
  const warnCalls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  try {
    const result = await queryDomainStatsV2(
      "clarice.ai",
      [{ name: "spam_rate", standardMetric: "SPAM_RATE" }],
      { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 1 } },
      fake,
    );
    assert.equal(calls, 100, "deve parar exatamente no teto, nunca rodar indefinidamente");
    assert.equal(result.domainStats.length, 100, "acumula as entradas de todas as páginas drenadas até o teto");
    assert.equal(result.nextPageToken, "token-100", "sinaliza que a drenagem NÃO terminou (token ainda presente)");
    assert.equal(warnCalls.length, 1, "loga exatamente 1 warning ao bater o teto");
    assert.match(String(warnCalls[0][0]), /teto de 100 páginas/);
  } finally {
    console.warn = originalWarn;
  }
});
