/**
 * test/postmaster-campaign-spam.test.ts (#4704 — spam POR CAMPANHA)
 *
 * Cobre só as funções PURAS de scripts/lib/postmaster-campaign-spam.ts —
 * sem I/O de rede. Os fixtures de `FEEDBACK_LOOP_ID` são o shape REAL
 * observado ao vivo em 260806 (comentário do editor na #4704): 27/07
 * devolveu `["11130585", "11130585_99", "77.32.148.101"]`; 02/08 devolveu
 * `["11130585", "11130585_105", "11130585_106", "11130585_107", "77.32.148.101"]`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFeedbackLoopId,
  collectCampaignFeedbackLoopIds,
  aggregateCampaignSpamReadings,
  sortCampaignSpamReport,
  findWorstCampaignSpam,
  toCampaignSpamRecords,
  mergeCampaignSpamRecords,
  type CampaignSpamAggregate,
} from "../scripts/lib/postmaster-campaign-spam.ts";
import type { PostmasterCampaignSpamRecord } from "../scripts/lib/dashboard-kv-types.ts";

// ── parseFeedbackLoopId ──

test("parseFeedbackLoopId — casa {conta}_{campanha} e devolve os dois numéricos", () => {
  assert.deepEqual(parseFeedbackLoopId("11130585_107"), {
    feedbackLoopId: "11130585_107",
    account: "11130585",
    campaignId: 107,
  });
});

test("parseFeedbackLoopId — rejeita conta sozinha (sem underscore, tráfego não atribuído a campanha)", () => {
  assert.equal(parseFeedbackLoopId("11130585"), null);
});

test("parseFeedbackLoopId — rejeita IP cru", () => {
  assert.equal(parseFeedbackLoopId("77.32.148.101"), null);
});

test("parseFeedbackLoopId — rejeita formato com mais de 2 segmentos (nunca casar parcialmente)", () => {
  assert.equal(parseFeedbackLoopId("11130585_107_extra"), null);
});

test("parseFeedbackLoopId — rejeita segmento não-numérico", () => {
  assert.equal(parseFeedbackLoopId("11130585_abc"), null);
  assert.equal(parseFeedbackLoopId("conta_107"), null);
});

test("parseFeedbackLoopId — tolera espaço em volta (trim antes de casar)", () => {
  assert.deepEqual(parseFeedbackLoopId("  11130585_107  "), {
    feedbackLoopId: "  11130585_107  ",
    account: "11130585",
    campaignId: 107,
  });
});

// ── collectCampaignFeedbackLoopIds ──

test("collectCampaignFeedbackLoopIds — fixture real 260806: filtra conta sozinha e IP, mantém só as 3 campanhas de 02/08", () => {
  const idsByDay = [
    { ids: ["11130585", "11130585_99", "77.32.148.101"] }, // 27/07
    { ids: ["11130585", "11130585_105", "11130585_106", "11130585_107", "77.32.148.101"] }, // 02/08
  ];
  const result = collectCampaignFeedbackLoopIds(idsByDay);
  assert.deepEqual(
    result.map((r) => r.campaignId),
    [99, 105, 106, 107],
  );
});

test("collectCampaignFeedbackLoopIds — dedup: mesma campanha repetida em vários dias vira 1 entrada só", () => {
  const idsByDay = [
    { ids: ["11130585_107"] },
    { ids: ["11130585_107"] },
    { ids: ["11130585_107"] },
  ];
  const result = collectCampaignFeedbackLoopIds(idsByDay);
  assert.equal(result.length, 1);
  assert.equal(result[0].campaignId, 107);
});

test("collectCampaignFeedbackLoopIds — accountId filtra ids de OUTRA conta", () => {
  const idsByDay = [{ ids: ["11130585_107", "99999999_50"] }];
  const result = collectCampaignFeedbackLoopIds(idsByDay, "11130585");
  assert.deepEqual(
    result.map((r) => r.campaignId),
    [107],
  );
});

test("collectCampaignFeedbackLoopIds — sem accountId aceita qualquer conta numérica", () => {
  const idsByDay = [{ ids: ["11130585_107", "99999999_50"] }];
  const result = collectCampaignFeedbackLoopIds(idsByDay);
  assert.deepEqual(
    result.map((r) => r.campaignId).sort((a, b) => a - b),
    [50, 107],
  );
});

test("collectCampaignFeedbackLoopIds — janela sem nenhum id de campanha devolve array vazio, nunca lança", () => {
  const idsByDay = [{ ids: ["11130585", "77.32.148.101"] }];
  assert.deepEqual(collectCampaignFeedbackLoopIds(idsByDay), []);
});

test("collectCampaignFeedbackLoopIds — ordena por campaignId crescente (determinístico)", () => {
  const idsByDay = [{ ids: ["11130585_107", "11130585_50", "11130585_99"] }];
  const result = collectCampaignFeedbackLoopIds(idsByDay);
  assert.deepEqual(
    result.map((r) => r.campaignId),
    [50, 99, 107],
  );
});

// ── aggregateCampaignSpamReadings ──

test("aggregateCampaignSpamReadings — reflete o achado real da #4704: pico do dia > média da janela", () => {
  // Fixture inspirada no achado ao vivo: 1,39% num dia isolado, 0% nos outros.
  const readings = [
    { date: "2026-08-01", ratio: 0 },
    { date: "2026-08-02", ratio: 0.0139 },
    { date: "2026-08-03", ratio: 0 },
  ];
  const agg = aggregateCampaignSpamReadings(107, "11130585_107", readings);
  assert.ok(agg);
  assert.equal(agg!.peakSpamRatePct, 1.39);
  assert.equal(agg!.peakDate, "2026-08-02");
  assert.ok(agg!.avgSpamRatePct < agg!.peakSpamRatePct, "média sobre a janela deve ser menor que o pico isolado");
  assert.equal(Math.round(agg!.avgSpamRatePct * 1000) / 1000, 0.463);
});

test("aggregateCampaignSpamReadings — dailyReadings sai ordenado cronologicamente mesmo com input fora de ordem", () => {
  const readings = [
    { date: "2026-08-03", ratio: 0.01 },
    { date: "2026-08-01", ratio: 0.02 },
    { date: "2026-08-02", ratio: 0.03 },
  ];
  const agg = aggregateCampaignSpamReadings(1, "x_1", readings);
  assert.deepEqual(
    agg!.dailyReadings.map((d) => d.date),
    ["2026-08-01", "2026-08-02", "2026-08-03"],
  );
});

test("aggregateCampaignSpamReadings — array vazio devolve null, nunca inventa média/pico de zero elementos", () => {
  assert.equal(aggregateCampaignSpamReadings(1, "x_1", []), null);
});

test("aggregateCampaignSpamReadings — daysWithData conta exatamente as leituras recebidas", () => {
  const readings = [
    { date: "2026-08-01", ratio: 0 },
    { date: "2026-08-02", ratio: 0 },
  ];
  const agg = aggregateCampaignSpamReadings(1, "x_1", readings);
  assert.equal(agg!.daysWithData, 2);
});

test("aggregateCampaignSpamReadings — empate no pico usa o primeiro em ordem cronológica", () => {
  const readings = [
    { date: "2026-08-02", ratio: 0.05 },
    { date: "2026-08-01", ratio: 0.05 },
  ];
  const agg = aggregateCampaignSpamReadings(1, "x_1", readings);
  assert.equal(agg!.peakDate, "2026-08-01");
});

// ── sortCampaignSpamReport ──

test("sortCampaignSpamReport — desc por pico, não por média", () => {
  const rows: CampaignSpamAggregate[] = [
    { campaignId: 1, feedbackLoopId: "a_1", avgSpamRatePct: 0.5, peakSpamRatePct: 0.5, peakDate: "2026-08-01", daysWithData: 1, dailyReadings: [] },
    { campaignId: 2, feedbackLoopId: "a_2", avgSpamRatePct: 0.1, peakSpamRatePct: 1.39, peakDate: "2026-08-02", daysWithData: 3, dailyReadings: [] },
    { campaignId: 3, feedbackLoopId: "a_3", avgSpamRatePct: 0.0, peakSpamRatePct: 0.0, peakDate: "2026-08-03", daysWithData: 1, dailyReadings: [] },
  ];
  const sorted = sortCampaignSpamReport(rows);
  assert.deepEqual(sorted.map((r) => r.campaignId), [2, 1, 3]);
});

test("sortCampaignSpamReport — não muta o array de entrada", () => {
  const rows: CampaignSpamAggregate[] = [
    { campaignId: 1, feedbackLoopId: "a_1", avgSpamRatePct: 0, peakSpamRatePct: 0, peakDate: "2026-08-01", daysWithData: 1, dailyReadings: [] },
    { campaignId: 2, feedbackLoopId: "a_2", avgSpamRatePct: 0, peakSpamRatePct: 1, peakDate: "2026-08-02", daysWithData: 1, dailyReadings: [] },
  ];
  const originalOrder = rows.map((r) => r.campaignId);
  sortCampaignSpamReport(rows);
  assert.deepEqual(rows.map((r) => r.campaignId), originalOrder);
});

// ── findWorstCampaignSpam ──

// #4780: `daysWithData` da campanha VENCEDORA precisa sobreviver até
// `WorstCampaignSpam` (antes só existia em `CampaignSpamAggregate`, 1 nível
// abaixo, e era descartado aqui) — sem isso, um pico de 1 dia isolado fica
// indistinguível de um pico sustentado por vários dias no consumidor final.
test("findWorstCampaignSpam — propaga daysWithData da campanha vencedora (#4780)", () => {
  const aggregates: CampaignSpamAggregate[] = [
    { campaignId: 1, feedbackLoopId: "a_1", avgSpamRatePct: 0.5, peakSpamRatePct: 0.5, peakDate: "2026-08-01", daysWithData: 5, dailyReadings: [] },
    { campaignId: 2, feedbackLoopId: "a_2", avgSpamRatePct: 1.39, peakSpamRatePct: 1.39, peakDate: "2026-08-02", daysWithData: 1, dailyReadings: [] },
  ];
  const worst = findWorstCampaignSpam(aggregates);
  assert.equal(worst?.campaignId, 2);
  assert.equal(worst?.daysWithData, 1, "cobertura da campanha vencedora (campanha 2), não da 1");
});

// ── toCampaignSpamRecords / mergeCampaignSpamRecords (#4970) ──

const NOW_4970 = new Date("2026-08-11T12:00:00.000Z");

test("toCampaignSpamRecords — converte agregados num mapa campaignId(string) -> record, com updatedAt=now", () => {
  const aggregates: CampaignSpamAggregate[] = [
    { campaignId: 107, feedbackLoopId: "11130585_107", avgSpamRatePct: 0.9, peakSpamRatePct: 1.39, peakDate: "2026-08-02", daysWithData: 3, dailyReadings: [] },
    { campaignId: 105, feedbackLoopId: "11130585_105", avgSpamRatePct: 0.1, peakSpamRatePct: 0.1, peakDate: "2026-08-01", daysWithData: 1, dailyReadings: [] },
  ];
  const map = toCampaignSpamRecords(aggregates, NOW_4970);
  assert.deepEqual(Object.keys(map).sort(), ["105", "107"]);
  assert.equal(map["107"].campaignId, 107);
  assert.equal(map["107"].feedbackLoopId, "11130585_107");
  assert.equal(map["107"].peakSpamRatePct, 1.39);
  assert.equal(map["107"].avgSpamRatePct, 0.9);
  assert.equal(map["107"].peakDate, "2026-08-02");
  assert.equal(map["107"].daysWithData, 3);
  assert.equal(map["107"].updatedAt, NOW_4970.toISOString());
});

test("toCampaignSpamRecords — array vazio vira mapa vazio (nunca lança)", () => {
  assert.deepEqual(toCampaignSpamRecords([], NOW_4970), {});
});

function mkRecord(overrides: Partial<PostmasterCampaignSpamRecord> = {}): PostmasterCampaignSpamRecord {
  return {
    campaignId: 107,
    feedbackLoopId: "11130585_107",
    avgSpamRatePct: 0.5,
    peakSpamRatePct: 1.0,
    peakDate: "2026-08-01",
    daysWithData: 1,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

test("mergeCampaignSpamRecords — chave nova em fresh é adicionada ao resultado", () => {
  const previous = { "105": mkRecord({ campaignId: 105, feedbackLoopId: "11130585_105" }) };
  const fresh = { "107": mkRecord({ campaignId: 107 }) };
  const merged = mergeCampaignSpamRecords(previous, fresh);
  assert.deepEqual(Object.keys(merged).sort(), ["105", "107"]);
});

test("mergeCampaignSpamRecords — chave ausente em fresh mas presente em previous é PRESERVADA intacta (#4970 core do 'acumular')", () => {
  // Cenário real: campanha 105 caiu fora da janela de 10 dias sondada nesta
  // execução (foi enviada há mais tempo), mas seu valor histórico continua
  // válido — o Postmaster não republica dado de campanha antiga.
  const previous = { "105": mkRecord({ campaignId: 105, feedbackLoopId: "11130585_105", peakSpamRatePct: 2.5 }) };
  const fresh = { "107": mkRecord({ campaignId: 107 }) };
  const merged = mergeCampaignSpamRecords(previous, fresh);
  assert.deepEqual(merged["105"], previous["105"], "campanha 105 preservada byte-a-byte, mesmo sem aparecer nesta execução");
  assert.equal(merged["107"].campaignId, 107);
});

test("mergeCampaignSpamRecords — chave presente nos DOIS é SUBSTITUÍDA pela versão fresh (mais cobertura, dentro da janela)", () => {
  const previous = { "107": mkRecord({ daysWithData: 1, peakSpamRatePct: 1.0, updatedAt: "2026-08-01T00:00:00.000Z" }) };
  const fresh = { "107": mkRecord({ daysWithData: 3, peakSpamRatePct: 1.39, updatedAt: "2026-08-05T00:00:00.000Z" }) };
  const merged = mergeCampaignSpamRecords(previous, fresh);
  assert.deepEqual(merged["107"], fresh["107"], "fresh vence — mais dias de cobertura acumulados dentro da mesma janela");
});

test("mergeCampaignSpamRecords — previous null/undefined é tratado como mapa vazio (1ª execução pós-#4970, ou KV vazio)", () => {
  const fresh = { "107": mkRecord() };
  assert.deepEqual(mergeCampaignSpamRecords(null, fresh), fresh);
  assert.deepEqual(mergeCampaignSpamRecords(undefined, fresh), fresh);
});

test("mergeCampaignSpamRecords — não muta nenhum dos 2 argumentos", () => {
  const previous = { "105": mkRecord({ campaignId: 105 }) };
  const fresh = { "107": mkRecord({ campaignId: 107 }) };
  const previousSnapshot = JSON.parse(JSON.stringify(previous));
  const freshSnapshot = JSON.parse(JSON.stringify(fresh));
  mergeCampaignSpamRecords(previous, fresh);
  assert.deepEqual(previous, previousSnapshot);
  assert.deepEqual(fresh, freshSnapshot);
});

test("mergeCampaignSpamRecords — acumulação real em 3 'execuções' sucessivas nunca perde uma campanha antiga (regressão #4970)", () => {
  // Simula 3 syncs seguidos: cada um só vê as campanhas da sua janela (10
  // dias), mas a tabela Envios precisa reter TODAS (~90 dias). Sem o merge,
  // a execução 3 apagaria as campanhas 100/101 (só vistas na execução 1).
  const exec1 = mergeCampaignSpamRecords(null, {
    "100": mkRecord({ campaignId: 100 }),
    "101": mkRecord({ campaignId: 101 }),
  });
  const exec2 = mergeCampaignSpamRecords(exec1, {
    "102": mkRecord({ campaignId: 102 }),
  });
  const exec3 = mergeCampaignSpamRecords(exec2, {
    "103": mkRecord({ campaignId: 103 }),
  });
  assert.deepEqual(
    Object.keys(exec3).sort(),
    ["100", "101", "102", "103"],
    "3 execuções depois, campanhas 100/101 (só vistas na 1ª execução) continuam no mapa",
  );
});
