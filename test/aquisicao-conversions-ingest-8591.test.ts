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
import { defaultProcessingDay, mergePanelChannels, resolveDailyCount } from "../scripts/aquisicao-conversions-ingest.ts";
import type { PanelInput } from "../scripts/aquisicao-reconcile.ts";

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
    const { counts, discardedCount } = extractMetaCompleteRegistrationDaily(rows);
    assert.deepEqual(counts, [
      { date: "2026-09-27", count: 5 },
      { date: "2026-09-28", count: 1 },
    ]);
    assert.equal(discardedCount, 0);
  });

  it("dia com date_start válido mas sem a ação (ou sem actions nenhum) conta como 0 real, não é descartado", () => {
    const rows: MetaAdsInsightsApiRow[] = [
      { date_start: "2026-09-27", actions: [{ action_type: "lead", value: "10" }] },
      { date_start: "2026-09-28" },
    ];
    const { counts, discardedCount } = extractMetaCompleteRegistrationDaily(rows);
    assert.deepEqual(counts, [
      { date: "2026-09-27", count: 0 },
      { date: "2026-09-28", count: 0 },
    ]);
    assert.equal(discardedCount, 0);
  });

  it("linha sem date_start reconhecível é descartada e contada (nunca soma como 0 silencioso)", () => {
    const rows: MetaAdsInsightsApiRow[] = [
      { actions: [{ action_type: "complete_registration", value: "7" }] },
      { date_start: "not-a-date", actions: [{ action_type: "complete_registration", value: "7" }] },
    ];
    const { counts, discardedCount } = extractMetaCompleteRegistrationDaily(rows);
    assert.deepEqual(counts, []);
    assert.equal(discardedCount, 2);
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
    const { counts, discardedCount } = extractMetaCompleteRegistrationDaily(rows);
    assert.deepEqual(counts, [{ date: "2026-09-27", count: 4 }]);
    assert.equal(discardedCount, 0);
  });
});

describe("#8591 (review) — resolveDailyCount", () => {
  it("dia presente em counts devolve o count real, mesmo que 0", () => {
    assert.equal(resolveDailyCount([{ date: "2026-09-27", count: 0 }], "2026-09-27", 0), 0);
    assert.equal(resolveDailyCount([{ date: "2026-09-27", count: 5 }], "2026-09-27", 0), 5);
  });

  it("dia ausente SEM descarte é 0 real (API respondeu limpo, sem linha pro dia)", () => {
    assert.equal(resolveDailyCount([], "2026-09-27", 0), 0);
  });

  it("dia ausente COM descarte é null — nunca um 0 fabricado (achado do review da PR #8929)", () => {
    assert.equal(resolveDailyCount([], "2026-09-27", 3), null);
    // mesmo com outro dia presente em counts, o dia PEDIDO continua ausente
    // e há descarte na janela — não confiar no 0 implícito.
    assert.equal(resolveDailyCount([{ date: "2026-09-28", count: 2 }], "2026-09-27", 1), null);
  });
});

describe("#8591 (review) — mergePanelChannels", () => {
  it("sem painel existente, devolve só o que foi buscado", () => {
    const fetched: PanelInput["channels"] = { google: { reported_conversions: 3, cohort_key: "google-ads" } };
    assert.deepEqual(mergePanelChannels(undefined, fetched), fetched);
  });

  it("preserva canais do painel existente que esta run não buscou (microsoft/linkedin manuais)", () => {
    const existing: PanelInput["channels"] = {
      microsoft: { reported_conversions: 7, cohort_key: "microsoft" },
      linkedin: { reported_conversions: 1, cohort_key: "linkedin" },
    };
    const fetched: PanelInput["channels"] = { google: { reported_conversions: 3, cohort_key: "google-ads" } };
    assert.deepEqual(mergePanelChannels(existing, fetched), {
      microsoft: { reported_conversions: 7, cohort_key: "microsoft" },
      linkedin: { reported_conversions: 1, cohort_key: "linkedin" },
      google: { reported_conversions: 3, cohort_key: "google-ads" },
    });
  });

  it("a run atual SOBRESCREVE só a chave que de fato buscou, nunca zera as demais (achado do review da PR #8929)", () => {
    const existing: PanelInput["channels"] = {
      google: { reported_conversions: 999, cohort_key: "google-ads" },
      meta: { reported_conversions: 1, cohort_key: "meta-ads" },
    };
    const fetched: PanelInput["channels"] = { google: { reported_conversions: 4, cohort_key: "google-ads" } };
    assert.deepEqual(mergePanelChannels(existing, fetched), {
      google: { reported_conversions: 4, cohort_key: "google-ads" },
      meta: { reported_conversions: 1, cohort_key: "meta-ads" },
    });
  });
});

describe("#8591 — defaultProcessingDay (aquisicao-conversions-ingest.ts)", () => {
  it("dia BRT anterior ao instante de execução — mesma convenção de aquisicao-reconcile-daily.ts", () => {
    assert.equal(defaultProcessingDay(new Date("2026-09-28T13:00:00Z")), "2026-09-27");
  });
});
