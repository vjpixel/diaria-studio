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
} from "../scripts/postmaster-spam-sync.ts";
import type { QueryDomainStatsResponseV2 } from "../scripts/lib/postmaster-v2-client.ts";

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
