/**
 * #4154: scripts/postmaster-spam-sync.ts — automatiza a leitura do spamRate
 * do Google Postmaster Tools via API, substituindo a leitura manual
 * (postmaster-spam-entry.ts) sem mudar o consumidor (resolveSpamSignal).
 *
 * 260730 (pedido do editor + achado comparando contra a UI do Postmaster):
 * a leitura virou MÉDIA sobre HEALTH_SAMPLE_DAYS (mesma janela das outras
 * métricas da Rampa), e "200 sem o campo" passou a valer 0% (não mais "dado
 * insuficiente, pular") — confirmado que a API omite o campo em dias com
 * spam genuinamente 0%, comportamento padrão de serialização JSON de double
 * protobuf no valor default.
 *
 * Cobre só as partes puras/testáveis (sem I/O de rede nem KV).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toApiDateStr,
  apiDateToEntryDate,
  extractDayRatio,
  collectSpamReadings,
  buildAveragedEntry,
  parseWindowDaysArg,
} from "../scripts/postmaster-spam-sync.ts";

const NOW = new Date("2026-07-30T09:00:00.000Z");

test("toApiDateStr — formata YYYYMMDD sem hífen, em UTC", () => {
  assert.equal(toApiDateStr(new Date("2026-07-30T09:00:00.000Z")), "20260730");
  assert.equal(toApiDateStr(new Date("2026-01-05T00:00:00.000Z")), "20260105");
});

test("apiDateToEntryDate — YYYYMMDD vira YYYY-MM-DD", () => {
  assert.equal(apiDateToEntryDate("20260727"), "2026-07-27");
});

// ── extractDayRatio — o achado central de 260730 ──

test("extractDayRatio — userReportedSpamRatio presente retorna o valor", () => {
  assert.equal(extractDayRatio({ userReportedSpamRatio: 0.009 }), 0.009);
});

test("extractDayRatio — userReportedSpamRatio AUSENTE vira 0 (achado 260730: confirmado contra a UI do Postmaster, não é mais 'dado insuficiente')", () => {
  assert.equal(extractDayRatio({ domainReputation: "HIGH" }), 0);
});

// ── collectSpamReadings ──

test("collectSpamReadings — coleta 1 leitura por dia com 200 (campo presente OU ausente=0), pula 404", async () => {
  const fetchStats = async (apiDate: string) => {
    if (apiDate === "20260730") return { status: 404, body: null };
    if (apiDate === "20260729") return { status: 200, body: { userReportedSpamRatio: 0.009 } };
    if (apiDate === "20260728") return { status: 200, body: { domainReputation: "HIGH" } }; // sem o campo = 0%
    return { status: 404, body: null };
  };
  const { readings, daysChecked } = await collectSpamReadings(7, NOW, fetchStats);
  assert.equal(daysChecked, 7);
  assert.deepEqual(readings, [
    { apiDate: "20260729", ratio: 0.009 },
    { apiDate: "20260728", ratio: 0 },
  ]);
});

test("collectSpamReadings — readings[0] é o dia mais recente (offset 0 sondado primeiro)", async () => {
  const fetchStats = async (apiDate: string) => ({ status: 200, body: { userReportedSpamRatio: 0.01 } });
  const { readings } = await collectSpamReadings(3, NOW, fetchStats);
  assert.equal(readings[0].apiDate, "20260730");
  assert.equal(readings[2].apiDate, "20260728");
});

test("collectSpamReadings — status de erro (403) é registrado em httpErrors, NUNCA vira uma leitura de 0%", async () => {
  const fetchStats = async (apiDate: string) => {
    if (apiDate === "20260730") return { status: 403, body: null, errorText: "SERVICE_DISABLED" };
    return { status: 200, body: { userReportedSpamRatio: 0.01 } };
  };
  const { readings, httpErrors } = await collectSpamReadings(3, NOW, fetchStats);
  assert.equal(readings.length, 2, "403 não deve virar uma leitura");
  assert.deepEqual(httpErrors, [{ apiDate: "20260730", status: 403, errorText: "SERVICE_DISABLED" }]);
});

test("collectSpamReadings — 404 (não publicado) e erro de HTTP (500) coexistem sem se confundir", async () => {
  const fetchStats = async (apiDate: string) => {
    if (apiDate === "20260730") return { status: 404, body: null };
    if (apiDate === "20260729") return { status: 500, body: null, errorText: "internal" };
    return { status: 200, body: { userReportedSpamRatio: 0.02 } };
  };
  const { readings, httpErrors } = await collectSpamReadings(3, NOW, fetchStats);
  assert.equal(readings.length, 1);
  assert.deepEqual(httpErrors, [{ apiDate: "20260729", status: 500, errorText: "internal" }]);
});

test("collectSpamReadings — TODOS os dias com erro de HTTP → readings vazio, httpErrors com todos (caller decide abortar)", async () => {
  const fetchStats = async () => ({ status: 403, body: null, errorText: "SERVICE_DISABLED" });
  const { readings, daysChecked, httpErrors } = await collectSpamReadings(3, NOW, fetchStats);
  assert.equal(readings.length, 0);
  assert.equal(httpErrors.length, daysChecked);
});

test("collectSpamReadings — janela inteira sem publicação (tudo 404) → readings vazio, sem erro", async () => {
  const fetchStats = async () => ({ status: 404, body: null });
  const { readings, httpErrors } = await collectSpamReadings(5, NOW, fetchStats);
  assert.equal(readings.length, 0);
  assert.equal(httpErrors.length, 0);
});

// ── buildAveragedEntry ──

test("buildAveragedEntry — média simples do ratio sobre as leituras, spamRatePct em % (×100)", () => {
  const entry = buildAveragedEntry(
    [
      { apiDate: "20260730", ratio: 0.01 }, // 1.0%
      { apiDate: "20260728", ratio: 0.02 }, // 2.0%
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
      { apiDate: "20260730", ratio: 0.03 }, // 3.0%
      { apiDate: "20260729", ratio: 0 }, // 0.0%
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
      { apiDate: "20260730", ratio: 0.01 },
      { apiDate: "20260729", ratio: 0.02 },
      { apiDate: "20260728", ratio: 0 },
    ],
    NOW,
    10, // janela pedida era 10 dias, só 3 tiveram leitura válida
  );
  assert.equal(entry?.daysWithData, 3);
  assert.equal(entry?.daysProbed, 10);
});

// Achado convergente de 2 agentes no self-review do #4345 (silent-failure-hunter
// + type-design-analyzer): buildAveragedEntry não deve confiar que readings[0]
// é o mais recente — acha o apiDate máximo explicitamente, mesmo com input
// fora de ordem (ex: um futuro collectSpamReadings paralelizado que não
// preserve a ordem sequencial de hoje).
test("buildAveragedEntry — acha o dia mais recente mesmo com readings fora de ordem", () => {
  const entry = buildAveragedEntry(
    [
      { apiDate: "20260722", ratio: 0.008 }, // mais antigo primeiro
      { apiDate: "20260730", ratio: 0.02 }, // mais recente no meio/fim
      { apiDate: "20260725", ratio: 0.01 },
    ],
    NOW,
    3,
  );
  assert.equal(entry?.date, "2026-07-30");
});

// Cenário real que motivou este PR (print do editor comparando a API contra
// a UI do Postmaster, 260730): janela de 10 dias, só 3 tinham trafficStats
// publicado (os outros 7 eram 404), um deles com o campo ausente = 0%.
test("cenário real 260730: janela de 10 dias com 3 leituras (27/07=0%, 24/07=0.9%, 22/07=0.8%) → média 0.567%", async () => {
  const now = new Date("2026-07-30T19:52:13.513Z");
  const responsesByDate: Record<string, { status: number; body: Record<string, unknown> | null }> = {
    "20260727": { status: 200, body: { domainReputation: "HIGH" } }, // sem o campo = 0%
    "20260724": { status: 200, body: { userReportedSpamRatio: 0.009 } },
    "20260722": { status: 200, body: { userReportedSpamRatio: 0.008 } },
  };
  const fetchStats = async (apiDate: string) => responsesByDate[apiDate] ?? { status: 404, body: null };

  const { readings, daysChecked, httpErrors } = await collectSpamReadings(10, now, fetchStats);
  assert.equal(daysChecked, 10);
  assert.equal(httpErrors.length, 0);
  assert.equal(readings.length, 3);

  const entry = buildAveragedEntry(readings, now, daysChecked);
  assert.equal(entry?.date, "2026-07-27");
  assert.ok(Math.abs((entry?.spamRatePct ?? 0) - 0.5666666666666667) < 1e-9, `esperava ~0.567%, achou ${entry?.spamRatePct}`);
  assert.equal(entry?.producedBy, "auto");
  assert.equal(entry?.daysWithData, 3);
  assert.equal(entry?.daysProbed, 10);
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
