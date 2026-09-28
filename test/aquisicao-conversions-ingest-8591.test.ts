/**
 * test/aquisicao-conversions-ingest-8591.test.ts (#8591 item 2)
 *
 * Cobre as funções PURAS que fecham o item 2 da #8591 ("O lado do painel é
 * manual"): parsing/agregação diária de conversões do Google Ads
 * (`scripts/lib/google-ads-ingest.ts`) e do Meta Ads
 * (`scripts/lib/ads-campaign-economics-fetch.ts`), e a composição do CLI
 * (`defaultProcessingDay`, mesma convenção de `aquisicao-reconcile-daily.ts`).
 * Não chama nenhuma API real — I/O de rede já é coberto (fail-soft) pelos
 * testes existentes de `fetchGoogleAdsSpendRows`/`fetchMetaAdsChannelMetrics`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildGoogleAdsConversionsQuery,
  aggregateGoogleAdsConversionsByDayWithDiscards,
  GOOGLE_ADS_REGISTRATION_CONVERSION_ACTION_ID,
  type GaqlConversionsApiRow,
} from "../scripts/lib/google-ads-ingest.ts";
import {
  extractMetaCompleteRegistrationDaily,
  META_COMPLETE_REGISTRATION_ACTION_TYPE,
  type MetaAdsInsightsApiRow,
} from "../scripts/lib/ads-campaign-economics-fetch.ts";
import { defaultProcessingDay } from "../scripts/aquisicao-conversions-ingest.ts";

describe("#8591 — GOOGLE_ADS_REGISTRATION_CONVERSION_ACTION_ID", () => {
  it("é a ação PRIMÁRIA de cadastro (7418673798), nunca a de confirmação DOI (7762768203, secundária)", () => {
    assert.equal(GOOGLE_ADS_REGISTRATION_CONVERSION_ACTION_ID, "7418673798");
    assert.notEqual(GOOGLE_ADS_REGISTRATION_CONVERSION_ACTION_ID, "7762768203");
  });
});

describe("#8591 — buildGoogleAdsConversionsQuery", () => {
  it("monta FROM conversion_action com o id e o range BETWEEN explícitos, sem DURING", () => {
    const query = buildGoogleAdsConversionsQuery(new Date("2026-09-28T12:00:00Z"), 2, "7418673798");
    assert.match(query, /FROM conversion_action/);
    assert.match(query, /WHERE conversion_action\.id = 7418673798/);
    assert.match(query, /segments\.date BETWEEN '2026-09-27' AND '2026-09-28'/);
    assert.doesNotMatch(query, /DURING/);
  });

  it("sanitiza o id (aceita resource name completo ou string com não-dígitos)", () => {
    const query = buildGoogleAdsConversionsQuery(new Date("2026-09-28T12:00:00Z"), 1, "customers/2369219639/conversionActions/7418673798");
    assert.match(query, /conversion_action\.id = 7418673798/);
  });
});

describe("#8591 — aggregateGoogleAdsConversionsByDayWithDiscards", () => {
  it("soma metrics.conversions por dia e arredonda pro inteiro", () => {
    const rows: GaqlConversionsApiRow[] = [
      { segments: { date: "2026-09-27" }, metrics: { conversions: "1.4" } },
      { segments: { date: "2026-09-27" }, metrics: { conversions: 0.4 } },
      { segments: { date: "2026-09-28" }, metrics: { conversions: "3" } },
    ];
    const { counts, discardedCount } = aggregateGoogleAdsConversionsByDayWithDiscards(rows);
    assert.deepEqual(counts, [
      { date: "2026-09-27", count: 2 },
      { date: "2026-09-28", count: 3 },
    ]);
    assert.equal(discardedCount, 0);
  });

  it("descarta linha sem segments.date ou sem metrics.conversions parseável — nunca soma como 0 silencioso", () => {
    const rows: GaqlConversionsApiRow[] = [
      { segments: {}, metrics: { conversions: "5" } },
      { segments: { date: "2026-09-27" }, metrics: {} },
      { segments: { date: "2026-09-27" }, metrics: { conversions: "not-a-number" } },
      { segments: { date: "2026-09-28" }, metrics: { conversions: "2" } },
    ];
    const { counts, discardedCount } = aggregateGoogleAdsConversionsByDayWithDiscards(rows);
    assert.deepEqual(counts, [{ date: "2026-09-28", count: 2 }]);
    assert.equal(discardedCount, 3);
  });

  it("dia sem NENHUMA linha simplesmente não aparece no resultado (não é '0' silencioso)", () => {
    const { counts } = aggregateGoogleAdsConversionsByDayWithDiscards([]);
    assert.deepEqual(counts, []);
  });
});

describe("#8591 — META_COMPLETE_REGISTRATION_ACTION_TYPE", () => {
  it("é o vocabulário fixo da Meta, não um rótulo nosso", () => {
    assert.equal(META_COMPLETE_REGISTRATION_ACTION_TYPE, "complete_registration");
  });
});

describe("#8591 — extractMetaCompleteRegistrationDaily", () => {
  it("soma value de toda action complete_registration por dia, ignorando outras action_type", () => {
    const rows: MetaAdsInsightsApiRow[] = [
      {
        date_start: "2026-09-27",
        actions: [
          { action_type: "complete_registration", value: "3" },
          { action_type: "lead", value: "999" },
          { action_type: "complete_registration", value: "2" },
        ],
      },
      { date_start: "2026-09-28", actions: [{ action_type: "complete_registration", value: "1" }] },
    ];
    const out = extractMetaCompleteRegistrationDaily(rows);
    assert.deepEqual(out, [
      { date: "2026-09-27", count: 5 },
      { date: "2026-09-28", count: 1 },
    ]);
  });

  it("dia com date_start válido mas sem a ação (ou sem actions nenhum) conta como 0 real, não é descartado", () => {
    const rows: MetaAdsInsightsApiRow[] = [
      { date_start: "2026-09-27", actions: [{ action_type: "lead", value: "10" }] },
      { date_start: "2026-09-28" },
    ];
    const out = extractMetaCompleteRegistrationDaily(rows);
    assert.deepEqual(out, [
      { date: "2026-09-27", count: 0 },
      { date: "2026-09-28", count: 0 },
    ]);
  });

  it("linha sem date_start reconhecível é ignorada", () => {
    const rows: MetaAdsInsightsApiRow[] = [
      { actions: [{ action_type: "complete_registration", value: "7" }] },
      { date_start: "not-a-date", actions: [{ action_type: "complete_registration", value: "7" }] },
    ];
    assert.deepEqual(extractMetaCompleteRegistrationDaily(rows), []);
  });

  it("value não-numérico não contamina a soma", () => {
    const rows: MetaAdsInsightsApiRow[] = [
      {
        date_start: "2026-09-27",
        actions: [
          { action_type: "complete_registration", value: "not-a-number" },
          { action_type: "complete_registration", value: "4" },
        ],
      },
    ];
    assert.deepEqual(extractMetaCompleteRegistrationDaily(rows), [{ date: "2026-09-27", count: 4 }]);
  });
});

describe("#8591 — defaultProcessingDay (aquisicao-conversions-ingest.ts)", () => {
  it("dia BRT anterior ao instante de execução — mesma convenção de aquisicao-reconcile-daily.ts", () => {
    assert.equal(defaultProcessingDay(new Date("2026-09-28T13:00:00Z")), "2026-09-27");
  });
});
