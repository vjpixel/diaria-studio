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

test("queryDomainStatsV2 — resposta 2xx não-JSON erra com contexto (proxy/truncamento), nunca lança SyntaxError cru", async () => {
  const fake = (async () => new Response("<html>proxy interceptou</html>", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      queryDomainStatsV2("clarice.ai", [{ name: "spam_rate", standardMetric: "SPAM_RATE" }], { start: { year: 2026, month: 8, day: 1 }, end: { year: 2026, month: 8, day: 1 } }, fake),
    /não é JSON válido.*proxy interceptou/s,
  );
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
