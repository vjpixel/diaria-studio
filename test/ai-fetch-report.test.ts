/**
 * test/ai-fetch-report.test.ts (#4902 item 3)
 *
 * Cobre `scripts/ai-fetch-report.ts` — parsing de contador, geração de
 * datas, leitura via `fetchImpl` injetado (nunca rede real) e append
 * JSONL via `ioFns` injetado (nunca escreve disco real).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCounterValue,
  listDatesBack,
  todayUtc,
  fetchAiFetchCountersForDate,
  appendAiFetchLog,
  type AiFetchDailyRecord,
} from "../scripts/ai-fetch-report.ts";
import { AI_FETCH_BOTS, aiFetchBotCounterKey, aiFetchReferrerCounterKey } from "../scripts/lib/shared/ai-fetch-counters.ts";
import { AI_REFERRER_HOSTS } from "../scripts/lib/shared/ai-referrer-log.ts";

describe("parseCounterValue", () => {
  test("null (miss/404) → 0, nunca NaN", () => {
    assert.equal(parseCounterValue(null), 0);
  });
  test("string numérica → o número", () => {
    assert.equal(parseCounterValue("42"), 42);
  });
  test("string corrompida (não-numérica) → 0", () => {
    assert.equal(parseCounterValue("lixo"), 0);
  });
  test("negativo → 0 (contador nunca decresce)", () => {
    assert.equal(parseCounterValue("-3"), 0);
  });
});

describe("todayUtc", () => {
  test("formata YYYY-MM-DD a partir do relógio injetado", () => {
    assert.equal(todayUtc(() => new Date("2026-08-11T23:59:00Z")), "2026-08-11");
  });
});

describe("listDatesBack", () => {
  test("days=1 → só a data pedida", () => {
    assert.deepEqual(listDatesBack("2026-08-11", 1), ["2026-08-11"]);
  });

  test("days=3 → 3 datas terminando em endDate, mais recente primeiro", () => {
    assert.deepEqual(listDatesBack("2026-08-11", 3), ["2026-08-11", "2026-08-10", "2026-08-09"]);
  });

  test("cruza fronteira de mês corretamente", () => {
    assert.deepEqual(listDatesBack("2026-08-01", 2), ["2026-08-01", "2026-07-31"]);
  });

  test("days < 1 vira 1 (sempre pelo menos a própria data)", () => {
    assert.deepEqual(listDatesBack("2026-08-11", 0), ["2026-08-11"]);
    assert.deepEqual(listDatesBack("2026-08-11", -5), ["2026-08-11"]);
  });

  test("endDate malformada lança erro explícito", () => {
    assert.throws(() => listDatesBack("11/08/2026", 1), /YYYY-MM-DD/);
    assert.throws(() => listDatesBack("", 1), /YYYY-MM-DD/);
  });
});

describe("fetchAiFetchCountersForDate", () => {
  test("chave ausente (404) devolve 0, nunca NaN, pra bot e pra referrer", async () => {
    const fetchImpl = async () => new Response(null, { status: 404 });
    const record = await fetchAiFetchCountersForDate("2026-08-11", "ns-id", { accountId: "acc", token: "tok" }, fetchImpl as typeof fetch);
    for (const bot of AI_FETCH_BOTS) assert.equal(record.byBot[bot], 0);
    for (const host of AI_REFERRER_HOSTS) assert.equal(record.byReferrerHost[host], 0);
    assert.equal(record.totalBotHits, 0);
    assert.equal(record.totalReferrerHits, 0);
    assert.equal(record.date, "2026-08-11");
  });

  test("lê o valor real de cada chave via fetchImpl injetado (sem rede real)", async () => {
    const values: Record<string, string> = {
      [aiFetchBotCounterKey("Googlebot", "2026-08-11")]: "5",
      [aiFetchBotCounterKey("bingbot", "2026-08-11")]: "2",
      [aiFetchReferrerCounterKey("claude.ai", "2026-08-11")]: "3",
    };
    const fetchImpl = async (url: string | URL) => {
      const u = String(url);
      for (const [key, val] of Object.entries(values)) {
        if (u.endsWith(`/values/${encodeURIComponent(key)}`)) return new Response(val, { status: 200 });
      }
      return new Response(null, { status: 404 });
    };
    const record = await fetchAiFetchCountersForDate(
      "2026-08-11",
      "ns-id",
      { accountId: "acc", token: "tok" },
      fetchImpl as typeof fetch,
      () => new Date("2026-08-11T12:00:00Z"),
    );
    assert.equal(record.byBot["Googlebot"], 5);
    assert.equal(record.byBot["bingbot"], 2);
    assert.equal(record.byBot["OAI-SearchBot"], 0);
    assert.equal(record.byReferrerHost["claude.ai"], 3);
    assert.equal(record.byReferrerHost["chatgpt.com"], 0);
    assert.equal(record.totalBotHits, 7);
    assert.equal(record.totalReferrerHits, 3);
    assert.equal(record.ts, "2026-08-11T12:00:00.000Z");
  });

  test("erro de rede real (credencial/DNS/etc) propaga — caller decide a política", async () => {
    const fetchImpl = async () => {
      throw new Error("network down");
    };
    await assert.rejects(
      fetchAiFetchCountersForDate("2026-08-11", "ns-id", { accountId: "acc", token: "tok" }, fetchImpl as typeof fetch),
      /network down/,
    );
  });
});

describe("appendAiFetchLog", () => {
  test("array vazio → não chama I/O nenhum", () => {
    let called = false;
    appendAiFetchLog([], "data/ai-fetch/history.jsonl", {
      mkdirSync: () => {
        called = true;
      },
      appendFileSync: () => {
        called = true;
      },
    });
    assert.equal(called, false);
  });

  test("anexa 1 linha JSON por registro, cria o diretório", () => {
    const mkdirCalls: string[] = [];
    const appended: string[] = [];
    const record: AiFetchDailyRecord = {
      date: "2026-08-11",
      ts: "2026-08-11T12:00:00.000Z",
      byBot: Object.fromEntries(AI_FETCH_BOTS.map((b) => [b, 0])) as AiFetchDailyRecord["byBot"],
      byReferrerHost: Object.fromEntries(AI_REFERRER_HOSTS.map((h) => [h, 0])) as AiFetchDailyRecord["byReferrerHost"],
      totalBotHits: 0,
      totalReferrerHits: 0,
    };
    appendAiFetchLog([record], "data/ai-fetch/history.jsonl", {
      mkdirSync: (p) => mkdirCalls.push(p),
      appendFileSync: (_p, d) => appended.push(d),
    });
    assert.equal(mkdirCalls.length, 1);
    assert.equal(appended.length, 1);
    const parsed = JSON.parse(appended[0].trim());
    assert.equal(parsed.date, "2026-08-11");
  });

  test("2 registros → 2 linhas JSON num único append", () => {
    const appended: string[] = [];
    const record = (date: string): AiFetchDailyRecord => ({
      date,
      ts: `${date}T00:00:00.000Z`,
      byBot: Object.fromEntries(AI_FETCH_BOTS.map((b) => [b, 0])) as AiFetchDailyRecord["byBot"],
      byReferrerHost: Object.fromEntries(AI_REFERRER_HOSTS.map((h) => [h, 0])) as AiFetchDailyRecord["byReferrerHost"],
      totalBotHits: 0,
      totalReferrerHits: 0,
    });
    appendAiFetchLog([record("2026-08-10"), record("2026-08-11")], "data/ai-fetch/history.jsonl", {
      mkdirSync: () => {},
      appendFileSync: (_p, d) => appended.push(d),
    });
    assert.equal(appended.length, 1);
    const lines = appended[0].trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).date, "2026-08-10");
    assert.equal(JSON.parse(lines[1]).date, "2026-08-11");
  });
});
