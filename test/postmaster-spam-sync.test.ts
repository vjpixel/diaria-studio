/**
 * #4154: scripts/postmaster-spam-sync.ts — automatiza a leitura do spamRate
 * do Google Postmaster Tools via API, substituindo a leitura manual
 * (postmaster-spam-entry.ts) sem mudar o consumidor (resolveSpamSignal).
 *
 * 260730 (pedido do editor + achado comparando contra a UI do Postmaster):
 * a leitura virou MÉDIA sobre HEALTH_SAMPLE_DAYS (mesma janela das outras
 * métricas da Rampa).
 *
 * 260806 (#4704): migração pra v2 (`domainStats:query`) — troca N GETs
 * diários (v1, `trafficStats.get`) por 1 POST de range único, elimina os 429
 * recorrentes, e passa a persistir a série diária (`dailyReadings`) em vez de
 * descartá-la depois da média. Os testes de `extractDayRatio`/
 * `extractReputationSignal`/`collectSpamReadings` (v1) foram substituídos
 * pelos equivalentes v2 abaixo — a semântica "ausente=não publicado,
 * presente com 0=0% real" já é coberta em profundidade por
 * `test/postmaster-v2-client.test.ts` (`extractSpamRateReadingsV2`), não
 * duplicada aqui.
 *
 * Cobre só as partes puras/testáveis (sem I/O de rede nem KV).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toCalendarDate,
  buildWindowRange,
  collectSpamReadingsV2,
  buildAveragedEntry,
  parseWindowDaysArg,
  collectWorstCampaignSpam,
  describeCampaignSpamCollectionLine,
  type CollectWorstCampaignSpamResult,
} from "../scripts/postmaster-spam-sync.ts";
import type { QueryDomainStatsResponseV2 } from "../scripts/lib/postmaster-v2-client.ts";
import type { WorstCampaignSpam } from "../scripts/lib/postmaster-campaign-spam.ts";

const NOW = new Date("2026-07-30T09:00:00.000Z");

// ── toCalendarDate / buildWindowRange ──

test("toCalendarDate — Date vira CalendarDate em UTC", () => {
  assert.deepEqual(toCalendarDate(new Date("2026-07-30T09:00:00.000Z")), { year: 2026, month: 7, day: 30 });
  assert.deepEqual(toCalendarDate(new Date("2026-01-05T23:59:00.000Z")), { year: 2026, month: 1, day: 5 });
});

test("buildWindowRange — cobre windowDays dias-calendário terminando em now, inclusive nos dois limites", () => {
  const range = buildWindowRange(10, NOW);
  assert.deepEqual(range.end, { year: 2026, month: 7, day: 30 });
  assert.deepEqual(range.start, { year: 2026, month: 7, day: 21 }); // 30 - 9 = 21 (10 dias inclusive)
});

test("buildWindowRange — janela de 1 dia tem start === end", () => {
  const range = buildWindowRange(1, NOW);
  assert.deepEqual(range.start, range.end);
});

// ── collectSpamReadingsV2 ──

function fakeResponse(entries: Array<{ date: { year: number; month: number; day: number }; floatValue?: number }>): QueryDomainStatsResponseV2 {
  return {
    domainStats: entries.map((e) => ({
      metric: "spam_rate",
      date: e.date,
      ...(e.floatValue !== undefined ? { value: { floatValue: e.floatValue } } : {}),
    })),
  };
}

test("collectSpamReadingsV2 — 1 chamada pro range inteiro, extrai leituras por dia (ausente = não publicado, nunca vira leitura)", async () => {
  const response = fakeResponse([
    { date: { year: 2026, month: 7, day: 29 }, floatValue: 0.009 },
    { date: { year: 2026, month: 7, day: 28 }, floatValue: 0 }, // 200 com valor 0 = 0% real
    // 30/07 e os demais dias da janela nem aparecem na lista = não publicado
  ]);
  let calledWithRange: unknown;
  const query = async (range: unknown) => {
    calledWithRange = range;
    return response;
  };
  const { readings, daysProbed } = await collectSpamReadingsV2(7, NOW, query);
  assert.equal(daysProbed, 7);
  assert.deepEqual(calledWithRange, { start: { year: 2026, month: 7, day: 24 }, end: { year: 2026, month: 7, day: 30 } });
  assert.deepEqual(
    readings.slice().sort((a, b) => a.date.localeCompare(b.date)),
    [
      { date: "2026-07-28", ratio: 0 },
      { date: "2026-07-29", ratio: 0.009 },
    ],
  );
});

test("collectSpamReadingsV2 — erro de HTTP na chamada única propaga (nunca vira 'sem dado' em silêncio)", async () => {
  const query = async () => {
    throw new Error("[postmaster-v2-client] falha em domainStats.query: 403 SERVICE_DISABLED");
  };
  await assert.rejects(() => collectSpamReadingsV2(7, NOW, query), /SERVICE_DISABLED/);
});

test("collectSpamReadingsV2 — janela inteira sem publicação (domainStats vazio) → readings vazio, sem erro", async () => {
  const query = async () => ({ domainStats: [] });
  const { readings } = await collectSpamReadingsV2(5, NOW, query);
  assert.equal(readings.length, 0);
});

// ── buildAveragedEntry ──

test("buildAveragedEntry — média simples do ratio sobre as leituras, spamRatePct em % (×100)", () => {
  const entry = buildAveragedEntry(
    [
      { date: "2026-07-30", ratio: 0.01 }, // 1.0%
      { date: "2026-07-28", ratio: 0.02 }, // 2.0%
    ],
    NOW,
    2,
  );
  assert.equal(entry?.spamRatePct, 1.5); // média = 1.5%
  assert.equal(entry?.date, "2026-07-30"); // dia mais recente da lista
  assert.equal(entry?.recordedAt, NOW.toISOString());
  assert.equal(entry?.producedBy, "auto");
});

test("buildAveragedEntry — inclui dias com ratio 0 na média (0% real, não descartado)", () => {
  const entry = buildAveragedEntry(
    [
      { date: "2026-07-30", ratio: 0.03 }, // 3.0%
      { date: "2026-07-29", ratio: 0 }, // 0.0%
    ],
    NOW,
    2,
  );
  assert.equal(entry?.spamRatePct, 1.5); // (3.0 + 0.0) / 2
});

test("buildAveragedEntry — lista vazia retorna null (nunca inventa média de zero elementos)", () => {
  assert.equal(buildAveragedEntry([], NOW, 10), null);
});

// #4541: daysWithData/daysProbed gravados na entry — base pro guard de
// cobertura mínima em resolveSpamSignal (workers/brevo-dashboard/src/thresholds.ts).
test("buildAveragedEntry — grava daysWithData (readings.length) e daysProbed (arg do chamador) na entry (#4541)", () => {
  const entry = buildAveragedEntry(
    [
      { date: "2026-07-30", ratio: 0.01 },
      { date: "2026-07-29", ratio: 0.02 },
      { date: "2026-07-28", ratio: 0 },
    ],
    NOW,
    10, // janela pedida era 10 dias, só 3 tiveram leitura válida
  );
  assert.equal(entry?.daysWithData, 3);
  assert.equal(entry?.daysProbed, 10);
});

// Achado convergente de 2 agentes no self-review do #4345 (silent-failure-hunter
// + type-design-analyzer), preservado na migração v2: buildAveragedEntry não
// deve confiar que readings[0] é o mais recente — acha o `date` máximo
// explicitamente, mesmo com input fora de ordem.
test("buildAveragedEntry — acha o dia mais recente mesmo com readings fora de ordem", () => {
  const entry = buildAveragedEntry(
    [
      { date: "2026-07-22", ratio: 0.008 }, // mais antigo primeiro
      { date: "2026-07-30", ratio: 0.02 }, // mais recente no meio/fim
      { date: "2026-07-25", ratio: 0.01 },
    ],
    NOW,
    3,
  );
  assert.equal(entry?.date, "2026-07-30");
});

// #4704: dailyReadings persiste a série completa (mais antigo primeiro),
// substituindo o descarte anterior do detalhe diário.
test("buildAveragedEntry — dailyReadings persiste a série completa em ordem cronológica, independente da ordem de entrada (#4704)", () => {
  const entry = buildAveragedEntry(
    [
      { date: "2026-07-30", ratio: 0.02 },
      { date: "2026-07-22", ratio: 0.008 },
      { date: "2026-07-25", ratio: 0.01 },
    ],
    NOW,
    3,
  );
  assert.deepEqual(entry?.dailyReadings, [
    { date: "2026-07-22", spamRatePct: 0.8 },
    { date: "2026-07-25", spamRatePct: 1.0 },
    { date: "2026-07-30", spamRatePct: 2.0 },
  ]);
});

test("buildAveragedEntry — dailyReadings inclui dias com 0% real, não filtrados", () => {
  const entry = buildAveragedEntry([{ date: "2026-07-30", ratio: 0 }], NOW, 1);
  assert.deepEqual(entry?.dailyReadings, [{ date: "2026-07-30", spamRatePct: 0 }]);
});

// Cenário real que motivou a migração (medição ao vivo 260806, comentário
// #4703): janela de 10 dias, só 3 dias publicados, um deles 0% real.
test("cenário real 260806 (v2): janela de 10 dias com 3 leituras (01/08=0%, 02/08=0,41%, 03/08=0%) → média ~0.137%", async () => {
  const now = new Date("2026-08-06T09:00:00.000Z");
  const response: QueryDomainStatsResponseV2 = {
    domainStats: [
      { metric: "spam_rate", date: { year: 2026, month: 8, day: 1 }, value: { floatValue: 0 } },
      { metric: "spam_rate", date: { year: 2026, month: 8, day: 2 }, value: { floatValue: 0.0041067763 } },
      { metric: "spam_rate", date: { year: 2026, month: 8, day: 3 }, value: { floatValue: 0 } },
      // 04-06/08 ausentes = não publicado ainda
    ],
  };
  const query = async () => response;

  const { readings, daysProbed } = await collectSpamReadingsV2(10, now, query);
  assert.equal(daysProbed, 10);
  assert.equal(readings.length, 3);

  const entry = buildAveragedEntry(readings, now, daysProbed);
  assert.equal(entry?.date, "2026-08-03");
  assert.ok(Math.abs((entry?.spamRatePct ?? 0) - 0.13689254333333334) < 1e-9, `esperava ~0.137%, achou ${entry?.spamRatePct}`);
  assert.equal(entry?.producedBy, "auto");
  assert.equal(entry?.daysWithData, 3);
  assert.equal(entry?.daysProbed, 10);
  assert.equal(entry?.dailyReadings?.length, 3);
});

// ── buildAveragedEntry + worstCampaign (#4705) ──

function mkWorstCampaign(overrides: Partial<WorstCampaignSpam> = {}): WorstCampaignSpam {
  return {
    campaignId: 107,
    feedbackLoopId: "11130585_107",
    spamRatePct: 1.39,
    date: "2026-08-02",
    daysWithData: 1,
    ...overrides,
  };
}

test("buildAveragedEntry — sem worstCampaign (default, chamadas pré-#4705 com 3 args) não grava os 3 campos novos", () => {
  const entry = buildAveragedEntry([{ date: "2026-07-30", ratio: 0.01 }], NOW, 1);
  assert.equal(entry?.worstCampaignSpamRatePct, undefined);
  assert.equal(entry?.worstCampaignFeedbackLoopId, undefined);
  assert.equal(entry?.worstCampaignDaysWithData, undefined);
});

test("buildAveragedEntry — com worstCampaign presente, grava worstCampaignSpamRatePct/worstCampaignFeedbackLoopId/worstCampaignDaysWithData (#4705, #4780)", () => {
  const entry = buildAveragedEntry([{ date: "2026-07-30", ratio: 0.0008 }], NOW, 1, mkWorstCampaign({ daysWithData: 3 }));
  assert.equal(entry?.worstCampaignSpamRatePct, 1.39);
  assert.equal(entry?.worstCampaignFeedbackLoopId, "11130585_107");
  assert.equal(entry?.worstCampaignDaysWithData, 3);
  // a média de domínio continua gravada normalmente ao lado do pico — os 2
  // números convivem na mesma entry, é resolveSpamSignal quem escolhe.
  assert.equal(entry?.spamRatePct, 0.08);
});

test("buildAveragedEntry — worstCampaign null explícito é equivalente a omitir o argumento", () => {
  const entry = buildAveragedEntry([{ date: "2026-07-30", ratio: 0.01 }], NOW, 1, null);
  assert.equal(entry?.worstCampaignSpamRatePct, undefined);
});

// ── buildAveragedEntry + campaignSpam (#4970) ──

test("buildAveragedEntry — sem campaignSpam (default, chamadas pré-#4970 com 4 args) não grava o campo", () => {
  const entry = buildAveragedEntry([{ date: "2026-07-30", ratio: 0.01 }], NOW, 1, mkWorstCampaign());
  assert.equal(entry?.campaignSpam, undefined);
});

test("buildAveragedEntry — campaignSpam com pelo menos 1 registro é gravado tal como veio (já mesclado pelo chamador)", () => {
  const campaignSpam = {
    "107": {
      campaignId: 107,
      feedbackLoopId: "11130585_107",
      avgSpamRatePct: 0.9,
      peakSpamRatePct: 1.39,
      peakDate: "2026-08-02",
      daysWithData: 3,
      updatedAt: NOW.toISOString(),
    },
  };
  const entry = buildAveragedEntry([{ date: "2026-07-30", ratio: 0.01 }], NOW, 1, null, campaignSpam);
  assert.deepEqual(entry?.campaignSpam, campaignSpam);
});

test("buildAveragedEntry — campaignSpam={} (objeto vazio) vira undefined, nunca um mapa vazio inventado (#4970, mesma disciplina de worstCampaign)", () => {
  const entry = buildAveragedEntry([{ date: "2026-07-30", ratio: 0.01 }], NOW, 1, null, {});
  assert.equal(entry?.campaignSpam, undefined);
});

test("buildAveragedEntry — campaignSpam null explícito é equivalente a omitir o argumento", () => {
  const entry = buildAveragedEntry([{ date: "2026-07-30", ratio: 0.01 }], NOW, 1, null, null);
  assert.equal(entry?.campaignSpam, undefined);
});

// ── collectWorstCampaignSpam (#4705) ──

function feedbackLoopIdResponse(idsByDay: string[][]): QueryDomainStatsResponseV2 {
  return {
    domainStats: idsByDay.map((ids, i) => ({
      metric: "feedback_loop_id",
      date: { year: 2026, month: 8, day: 1 + i },
      value: { stringList: ids },
    })),
  };
}

function campaignSpamResponse(readings: Array<{ day: number; floatValue: number }>): QueryDomainStatsResponseV2 {
  return {
    domainStats: readings.map((r) => ({
      metric: "campaign_spam_rate",
      date: { year: 2026, month: 8, day: r.day },
      value: { floatValue: r.floatValue },
    })),
  };
}

const RANGE = buildWindowRange(3, NOW);

test("collectWorstCampaignSpam — reflete o cenário real do #4705: acha o pico entre várias campanhas na janela", async () => {
  const queryFeedbackLoopIds = async () =>
    feedbackLoopIdResponse([
      ["11130585", "11130585_105", "11130585_106", "11130585_107", "77.32.148.101"],
    ]);
  const queryCampaignSpamRate = async (parsed: { campaignId: number }) => {
    if (parsed.campaignId === 107) return campaignSpamResponse([{ day: 2, floatValue: 0.0139 }]); // 1,39% — a pior
    return campaignSpamResponse([{ day: 2, floatValue: 0.001 }]); // 0,1% — as outras
  };
  const result = await collectWorstCampaignSpam(RANGE, "11130585", queryFeedbackLoopIds, queryCampaignSpamRate);
  assert.equal(result.worst?.campaignId, 107);
  assert.equal(result.worst?.feedbackLoopId, "11130585_107");
  assert.equal(result.worst?.spamRatePct, 1.39);
  // #4780: daysWithData da campanha VENCEDORA (1 leitura nesta fixture).
  assert.equal(result.worst?.daysWithData, 1);
  assert.equal(result.attempted, 3, "3 campanhas da conta 11130585 (105, 106, 107) — a conta sozinha e o IP não contam");
  assert.equal(result.failed, 0);
  assert.equal(result.otherAccountsSeen, 0);
  // #4970: `aggregates` traz TODAS as 3 campanhas (não só a pior) — base do
  // mapa por-campanha da tabela Envios.
  assert.equal(result.aggregates.length, 3);
  assert.deepEqual(
    result.aggregates.map((a) => a.campaignId).sort((a, b) => a - b),
    [105, 106, 107],
  );
  const winner = result.aggregates.find((a) => a.campaignId === 107);
  assert.equal(winner?.peakSpamRatePct, 1.39);
});

// #4780: cenário benigno original (issue) — nenhuma campanha, de nenhuma
// conta, apareceu na janela. `attempted===0` e `otherAccountsSeen===0`
// juntos são o sinal de "sem campanha atribuível", não confundível com o
// caso de accountId suspeito abaixo.
test("collectWorstCampaignSpam — nenhuma campanha atribuível na janela devolve worst=null com attempted=0/otherAccountsSeen=0 (#4780, cenário benigno)", async () => {
  const queryFeedbackLoopIds = async () => feedbackLoopIdResponse([["11130585", "77.32.148.101"]]);
  const queryCampaignSpamRate = async () => campaignSpamResponse([]);
  const result = await collectWorstCampaignSpam(RANGE, "11130585", queryFeedbackLoopIds, queryCampaignSpamRate);
  assert.equal(result.worst, null);
  assert.equal(result.attempted, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.otherAccountsSeen, 0);
});

// #4780: cenário "accountId hardcoded desatualizado" — havia campanha
// atribuível na resposta bruta, só que de OUTRA conta ESP. Antes desta
// issue, isto produzia o MESMO `null` do cenário benigno acima; agora
// `otherAccountsSeen>0` com `attempted===0` distingue os dois.
test("collectWorstCampaignSpam — accountId filtra campanhas de outra conta ESP, mas otherAccountsSeen sinaliza que existiam (#4780)", async () => {
  const queryFeedbackLoopIds = async () => feedbackLoopIdResponse([["99999999_50"]]);
  const queryCampaignSpamRate = async () => campaignSpamResponse([{ day: 1, floatValue: 0.05 }]);
  const result = await collectWorstCampaignSpam(RANGE, "11130585", queryFeedbackLoopIds, queryCampaignSpamRate);
  assert.equal(result.worst, null);
  assert.equal(result.attempted, 0);
  assert.equal(result.otherAccountsSeen, 1, "1 campanha (_50) da conta 99999999 apareceu na janela, nenhuma da conta 11130585");
});

test("collectWorstCampaignSpam — falha numa query de campanha específica é pulada (fail-soft), resto da coleta segue, failed conta só a que falhou", async () => {
  const queryFeedbackLoopIds = async () => feedbackLoopIdResponse([["11130585_105", "11130585_107"]]);
  const queryCampaignSpamRate = async (parsed: { campaignId: number }) => {
    if (parsed.campaignId === 105) throw new Error("HTTP 429");
    return campaignSpamResponse([{ day: 1, floatValue: 0.02 }]);
  };
  const result = await collectWorstCampaignSpam(RANGE, "11130585", queryFeedbackLoopIds, queryCampaignSpamRate);
  assert.equal(result.worst?.campaignId, 107, "a campanha que falhou (105) é ignorada, a que respondeu (107) governa");
  assert.equal(result.attempted, 2);
  assert.equal(result.failed, 1);
});

// #4780: CRITICAL do fleet review do #4779 — o cenário "TODAS as queries
// por-campanha falharam" é real e silencioso, distinto do benigno "sem
// campanha na janela". `attempted>0 && failed===attempted` com `worst===null`
// é a assinatura que `main()` usa pra logar diferente (console.warn, não log).
test("collectWorstCampaignSpam — TODAS as queries de campanha falham: worst=null mas attempted>0 e failed===attempted (#4780, achado CRITICAL)", async () => {
  const queryFeedbackLoopIds = async () => feedbackLoopIdResponse([["11130585_105", "11130585_107"]]);
  const queryCampaignSpamRate = async () => {
    throw new Error("HTTP 429");
  };
  const result = await collectWorstCampaignSpam(RANGE, "11130585", queryFeedbackLoopIds, queryCampaignSpamRate);
  assert.equal(result.worst, null);
  assert.equal(result.attempted, 2);
  assert.equal(result.failed, 2, "falha real e silenciosa — não confundir com 'sem campanha na janela'");
});

// #4785 (pr-test-analyzer, gap do fleet review pré-merge do #4780): todas as
// queries por-campanha TÊM SUCESSO mas nenhuma produz agregado válido
// (campaignSpamResponse([]) pra todas) — distinto do "falha" acima (aqui
// `failed===0`) e do "sem campanha" (aqui `attempted>0`). É o gatilho do
// ramo de `main()`/`describeCampaignSpamCollectionLine` "N/M campanha(s)
// consultada(s) com sucesso, mas nenhuma teve leitura na janela".
test("collectWorstCampaignSpam — todas as queries de campanha têm sucesso mas nenhuma tem leitura na janela: worst=null, attempted>0, failed=0 (#4785)", async () => {
  const queryFeedbackLoopIds = async () => feedbackLoopIdResponse([["11130585_105", "11130585_107"]]);
  const queryCampaignSpamRate = async () => campaignSpamResponse([]);
  const result = await collectWorstCampaignSpam(RANGE, "11130585", queryFeedbackLoopIds, queryCampaignSpamRate);
  assert.equal(result.worst, null);
  assert.equal(result.attempted, 2);
  assert.equal(result.failed, 0, "as queries tiveram sucesso — não é falha, é ausência de leitura na janela");
  assert.equal(result.otherAccountsSeen, 0);
});

test("collectWorstCampaignSpam — falha na query BASE de FEEDBACK_LOOP_ID propaga (o chamador, main(), decide o fail-soft de nível superior)", async () => {
  const queryFeedbackLoopIds = async () => {
    throw new Error("[postmaster-v2-client] falha em domainStats.query: 403 SERVICE_DISABLED");
  };
  const queryCampaignSpamRate = async () => campaignSpamResponse([]);
  await assert.rejects(
    () => collectWorstCampaignSpam(RANGE, "11130585", queryFeedbackLoopIds, queryCampaignSpamRate),
    /SERVICE_DISABLED/,
  );
});

// ── describeCampaignSpamCollectionLine (#4785, fix do achado CRITICAL do
// fleet review pré-merge do #4780) ──

const BENIGN_DEFAULT: CollectWorstCampaignSpamResult = { worst: null, attempted: 0, failed: 0, otherAccountsSeen: 0 };

test("describeCampaignSpamCollectionLine — baseQueryFailed=true NUNCA cai no ramo benigno, mesmo com o shape default de campaignResult (#4785, CRITICAL)", () => {
  // Este é exatamente o shape que `campaignResult` assume quando a query
  // BASE (queryFeedbackLoopIds) lança dentro de collectWorstCampaignSpam —
  // idêntico ao cenário benigno "sem campanha atribuível". Sem o parâmetro
  // baseQueryFailed, isto cairia no ramo `attempted === 0` e mascararia o
  // console.warn real já emitido pelo catch de main().
  const line = describeCampaignSpamCollectionLine(BENIGN_DEFAULT, true);
  assert.equal(line.level, "warn");
  assert.doesNotMatch(
    line.message,
    /^\[postmaster-spam-sync\] sem campanha atribuível/,
    "não pode reusar literalmente a mensagem benigna 'sem campanha atribuível na janela'",
  );
  assert.match(line.message, /query base de FEEDBACK_LOOP_ID falhou/);
  assert.match(line.message, /falha real/);
});

test("describeCampaignSpamCollectionLine — baseQueryFailed=false + attempted===0 + otherAccountsSeen===0 → mensagem benigna 'sem campanha atribuível'", () => {
  const line = describeCampaignSpamCollectionLine(BENIGN_DEFAULT, false);
  assert.equal(line.level, "log");
  assert.match(line.message, /sem campanha atribuível/);
});

test("describeCampaignSpamCollectionLine — worst presente → mensagem de pico achado (console.log, caminho normal)", () => {
  const result: CollectWorstCampaignSpamResult = {
    worst: { campaignId: 107, feedbackLoopId: "11130585_107", spamRatePct: 1.39, date: "2026-08-02", daysWithData: 1 },
    attempted: 3,
    failed: 0,
    otherAccountsSeen: 0,
  };
  const line = describeCampaignSpamCollectionLine(result, false);
  assert.equal(line.level, "log");
  assert.match(line.message, /pior campanha na janela.*11130585_107.*1\.390%/s);
});

test("describeCampaignSpamCollectionLine — attempted>0 && failed===attempted → warn 'TODAS as queries falharam'", () => {
  const result: CollectWorstCampaignSpamResult = { worst: null, attempted: 2, failed: 2, otherAccountsSeen: 0 };
  const line = describeCampaignSpamCollectionLine(result, false);
  assert.equal(line.level, "warn");
  assert.match(line.message, /TODAS as 2 campanha/);
});

test("describeCampaignSpamCollectionLine — attempted===0 && otherAccountsSeen>0 → warn 'accountId hardcoded desatualizado'", () => {
  const result: CollectWorstCampaignSpamResult = { worst: null, attempted: 0, failed: 0, otherAccountsSeen: 1 };
  const line = describeCampaignSpamCollectionLine(result, false);
  assert.equal(line.level, "warn");
  assert.match(line.message, /OUTRA conta ESP/);
});

test("describeCampaignSpamCollectionLine — attempted>0, failed<attempted, worst===null → log 'consultadas com sucesso, sem leitura'", () => {
  const result: CollectWorstCampaignSpamResult = { worst: null, attempted: 3, failed: 1, otherAccountsSeen: 0 };
  const line = describeCampaignSpamCollectionLine(result, false);
  assert.equal(line.level, "log");
  assert.match(line.message, /2\/3 campanha\(s\) consultada\(s\) com sucesso/);
});

// ── parseWindowDaysArg ──

test("parseWindowDaysArg — vazio usa o default (HEALTH_SAMPLE_DAYS, mesma janela das outras métricas da Rampa)", () => {
  assert.equal(parseWindowDaysArg(""), 10);
});

test("parseWindowDaysArg — valor numérico válido é usado", () => {
  assert.equal(parseWindowDaysArg("14"), 14);
});

test("parseWindowDaysArg — não-numérico ou < 1 lança erro explícito", () => {
  assert.throws(() => parseWindowDaysArg("abc"), /inválido/);
  assert.throws(() => parseWindowDaysArg("0"), /inválido/);
  assert.throws(() => parseWindowDaysArg("-3"), /inválido/);
});
