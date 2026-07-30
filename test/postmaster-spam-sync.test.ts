/**
 * #4154: scripts/postmaster-spam-sync.ts — automatiza a leitura do spamRate
 * do Google Postmaster Tools via API, substituindo a leitura manual
 * (postmaster-spam-entry.ts) sem mudar o consumidor (resolveSpamSignal).
 *
 * Cobre só as partes puras/testáveis (sem I/O de rede nem KV).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toApiDateStr,
  apiDateToEntryDate,
  parseTrafficStatsResponse,
  findLatestSpamReading,
  parseLookbackDaysArg,
} from "../scripts/postmaster-spam-sync.ts";

const NOW = new Date("2026-07-30T09:00:00.000Z");

test("toApiDateStr — formata YYYYMMDD sem hífen, em UTC", () => {
  assert.equal(toApiDateStr(new Date("2026-07-30T09:00:00.000Z")), "20260730");
  assert.equal(toApiDateStr(new Date("2026-01-05T00:00:00.000Z")), "20260105");
});

test("apiDateToEntryDate — YYYYMMDD vira YYYY-MM-DD", () => {
  assert.equal(apiDateToEntryDate("20260727"), "2026-07-27");
});

test("parseTrafficStatsResponse — userReportedSpamRatio presente vira spamRatePct (ratio × 100)", () => {
  const entry = parseTrafficStatsResponse({ userReportedSpamRatio: 0.0102 }, "20260727", NOW);
  assert.deepEqual(entry, {
    date: "2026-07-27",
    spamRatePct: 1.02,
    recordedAt: NOW.toISOString(),
  });
});

test("parseTrafficStatsResponse — userReportedSpamRatio AUSENTE retorna null, nunca 0% (evita falso-verde, #4063)", () => {
  const entry = parseTrafficStatsResponse({ domainReputation: "HIGH" }, "20260727", NOW);
  assert.equal(entry, null);
});

test("findLatestSpamReading — acha o dia mais recente (offset 0) quando disponível", async () => {
  const calls: string[] = [];
  const fetchStats = async (apiDate: string) => {
    calls.push(apiDate);
    return { status: 200, body: { userReportedSpamRatio: 0.005 } };
  };
  const { entry, daysChecked } = await findLatestSpamReading(7, NOW, fetchStats);
  assert.equal(entry?.date, "2026-07-30");
  assert.equal(daysChecked, 1);
  assert.deepEqual(calls, ["20260730"]);
});

test("findLatestSpamReading — pula 404 (dado ainda não publicado, lag ~2 dias) até achar 200", async () => {
  const fetchStats = async (apiDate: string) => {
    if (apiDate === "20260730" || apiDate === "20260729") return { status: 404, body: null };
    return { status: 200, body: { userReportedSpamRatio: 0.02 } };
  };
  const { entry, daysChecked } = await findLatestSpamReading(7, NOW, fetchStats);
  assert.equal(entry?.date, "2026-07-28");
  assert.equal(daysChecked, 3);
});

test("findLatestSpamReading — 200 mas sem userReportedSpamRatio conta como 'daysWithDataNoRatio' e continua procurando", async () => {
  const fetchStats = async (apiDate: string) => {
    if (apiDate === "20260730") return { status: 200, body: { domainReputation: "HIGH" } };
    return { status: 200, body: { userReportedSpamRatio: 0.03 } };
  };
  const { entry, daysWithDataNoRatio } = await findLatestSpamReading(7, NOW, fetchStats);
  assert.equal(entry?.date, "2026-07-29");
  assert.equal(daysWithDataNoRatio, 1);
});

test("findLatestSpamReading — esgota lookbackDays sem achar ratio → entry null, NUNCA inventa 0% (#4063)", async () => {
  const fetchStats = async () => ({ status: 200, body: { domainReputation: "HIGH" } });
  const { entry, daysChecked, daysWithDataNoRatio } = await findLatestSpamReading(5, NOW, fetchStats);
  assert.equal(entry, null);
  assert.equal(daysChecked, 5);
  assert.equal(daysWithDataNoRatio, 5);
});

// ── httpErrors: erro de HTTP NUNCA pode ser confundido com "sem dado ainda" ──
// (achado convergente de 3 agentes no self-review do #4342 — 403
// SERVICE_DISABLED é exatamente o tipo de erro que causou o #4154 original
// a ser mal-diagnosticado como "sem acesso ao domínio").

test("findLatestSpamReading — status de erro (403) é registrado em httpErrors, NUNCA em daysWithDataNoRatio", async () => {
  const fetchStats = async (apiDate: string) => {
    if (apiDate === "20260730") return { status: 403, body: null, errorText: "SERVICE_DISABLED" };
    return { status: 200, body: { userReportedSpamRatio: 0.01 } };
  };
  const { entry, daysWithDataNoRatio, httpErrors } = await findLatestSpamReading(7, NOW, fetchStats);
  assert.equal(entry?.date, "2026-07-29");
  assert.equal(daysWithDataNoRatio, 0, "erro de HTTP não é 'dado ausente' — contadores distintos");
  assert.deepEqual(httpErrors, [{ apiDate: "20260730", status: 403, errorText: "SERVICE_DISABLED" }]);
});

test("findLatestSpamReading — 404 (não publicado) e erro de HTTP (500) coexistem sem se confundir", async () => {
  const fetchStats = async (apiDate: string) => {
    if (apiDate === "20260730") return { status: 404, body: null };
    if (apiDate === "20260729") return { status: 500, body: null, errorText: "internal" };
    return { status: 200, body: { userReportedSpamRatio: 0.04 } };
  };
  const { entry, httpErrors } = await findLatestSpamReading(7, NOW, fetchStats);
  assert.equal(entry?.date, "2026-07-28");
  assert.deepEqual(httpErrors, [{ apiDate: "20260729", status: 500, errorText: "internal" }]);
});

test("findLatestSpamReading — TODOS os dias com erro de HTTP → entry null e httpErrors com todos os dias (caller decide abortar)", async () => {
  const fetchStats = async () => ({ status: 403, body: null, errorText: "SERVICE_DISABLED" });
  const { entry, daysChecked, httpErrors } = await findLatestSpamReading(3, NOW, fetchStats);
  assert.equal(entry, null);
  assert.equal(httpErrors.length, daysChecked, "todos os dias sondados falharam com erro — nenhum é 'sem dado ainda'");
});

// ── parseLookbackDaysArg ──

test("parseLookbackDaysArg — vazio usa o default (7)", () => {
  assert.equal(parseLookbackDaysArg(""), 7);
});

test("parseLookbackDaysArg — valor numérico válido é usado", () => {
  assert.equal(parseLookbackDaysArg("14"), 14);
});

test("parseLookbackDaysArg — não-numérico ou < 1 lança erro explícito", () => {
  assert.throws(() => parseLookbackDaysArg("abc"), /inválido/);
  assert.throws(() => parseLookbackDaysArg("0"), /inválido/);
  assert.throws(() => parseLookbackDaysArg("-3"), /inválido/);
});
