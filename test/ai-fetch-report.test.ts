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
      [aiFetchBotCounterKey("Googlebot", "2026-08-11", "arquivo")]: "5",
      [aiFetchBotCounterKey("bingbot", "2026-08-11", "arquivo")]: "2",
      [aiFetchReferrerCounterKey("claude.ai", "2026-08-11", "arquivo")]: "3",
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
    assert.equal(record.bySurface.arquivo.totalBotHits, 7);
    assert.equal(record.bySurface.arquivo.totalReferrerHits, 3);
    assert.equal(record.bySurface.site.totalBotHits, 0);
    assert.equal(record.bySurface.site.totalReferrerHits, 0);
  });

  test("#8062: contadores de arquivo e site somam em byBot/byReferrerHost mas ficam distintos em bySurface", async () => {
    const values: Record<string, string> = {
      [aiFetchBotCounterKey("Googlebot", "2026-08-11", "arquivo")]: "5",
      [aiFetchBotCounterKey("Googlebot", "2026-08-11", "site")]: "9",
      [aiFetchReferrerCounterKey("claude.ai", "2026-08-11", "site")]: "4",
    };
    const fetchImpl = async (url: string | URL) => {
      const u = String(url);
      for (const [key, val] of Object.entries(values)) {
        if (u.endsWith(`/values/${encodeURIComponent(key)}`)) return new Response(val, { status: 200 });
      }
      return new Response(null, { status: 404 });
    };
    const record = await fetchAiFetchCountersForDate("2026-08-11", "ns-id", { accountId: "acc", token: "tok" }, fetchImpl as typeof fetch);
    assert.equal(record.byBot["Googlebot"], 14);
    assert.equal(record.byReferrerHost["claude.ai"], 4);
    assert.equal(record.bySurface.arquivo.totalBotHits, 5);
    assert.equal(record.bySurface.site.totalBotHits, 9);
    assert.equal(record.bySurface.arquivo.totalReferrerHits, 0);
    assert.equal(record.bySurface.site.totalReferrerHits, 4);
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
  const record = (date: string, totalBotHits = 0): AiFetchDailyRecord => ({
    date,
    ts: `${date}T00:00:00.000Z`,
    byBot: Object.fromEntries(AI_FETCH_BOTS.map((b) => [b, 0])) as AiFetchDailyRecord["byBot"],
    byReferrerHost: Object.fromEntries(AI_REFERRER_HOSTS.map((h) => [h, 0])) as AiFetchDailyRecord["byReferrerHost"],
    bySurface: { arquivo: { totalBotHits: 0, totalReferrerHits: 0 }, site: { totalBotHits: 0, totalReferrerHits: 0 } },
    totalBotHits,
    totalReferrerHits: 0,
  });

  test("array vazio → não chama I/O nenhum", () => {
    let called = false;
    appendAiFetchLog([], "data/ai-fetch/history.jsonl", {
      mkdirSync: () => {
        called = true;
      },
      readFileIfExists: () => {
        called = true;
        return null;
      },
      writeFileSync: () => {
        called = true;
      },
    });
    assert.equal(called, false);
  });

  test("arquivo inexistente + 1 registro → escreve 1 linha JSON, cria o diretório", () => {
    const mkdirCalls: string[] = [];
    let written = "";
    appendAiFetchLog([record("2026-08-11")], "data/ai-fetch/history.jsonl", {
      mkdirSync: (p) => mkdirCalls.push(p),
      readFileIfExists: () => null,
      writeFileSync: (_p, d) => {
        written = d;
      },
    });
    assert.equal(mkdirCalls.length, 1);
    assert.notEqual(written, "");
    const parsed = JSON.parse(written.trim());
    assert.equal(parsed.date, "2026-08-11");
  });

  test("arquivo inexistente + 2 registros → 2 linhas JSON, ordem preservada", () => {
    let written = "";
    appendAiFetchLog([record("2026-08-10"), record("2026-08-11")], "data/ai-fetch/history.jsonl", {
      mkdirSync: () => {},
      readFileIfExists: () => null,
      writeFileSync: (_p, d) => {
        written = d;
      },
    });
    const lines = written.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).date, "2026-08-10");
    assert.equal(JSON.parse(lines[1]).date, "2026-08-11");
  });

  test("#8340: idempotente por date — reexecutar a mesma data substitui, nunca duplica", () => {
    // Simula o cenário real da task diária (`--days 2`): dia 2026-09-16 já
    // foi gravado numa rodada anterior; a rodada de hoje relê o mesmo dia
    // (overlap proposital) com um valor atualizado.
    const existing = [record("2026-09-15", 10), record("2026-09-16", 20)].map((r) => JSON.stringify(r) + "\n").join("");
    let written = "";
    appendAiFetchLog([record("2026-09-16", 99), record("2026-09-17", 5)], "data/ai-fetch/history.jsonl", {
      mkdirSync: () => {},
      readFileIfExists: () => existing,
      writeFileSync: (_p, d) => {
        written = d;
      },
    });
    const lines = written.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 3, "3 datas distintas — 09-16 duplicado deve ter sido descartado, não duplicado");
    const byDate = Object.fromEntries(lines.map((l: { date: string; totalBotHits: number }) => [l.date, l.totalBotHits]));
    assert.equal(byDate["2026-09-15"], 10, "data não re-lida fica intacta");
    assert.equal(byDate["2026-09-16"], 99, "valor da re-leitura vence o valor antigo (mais recente prevalece)");
    assert.equal(byDate["2026-09-17"], 5, "data nova é adicionada normalmente");
  });

  test("linha corrompida no arquivo existente é preservada, não descartada", () => {
    const existing = "not valid json\n" + JSON.stringify(record("2026-09-15", 1)) + "\n";
    let written = "";
    appendAiFetchLog([record("2026-09-16", 2)], "data/ai-fetch/history.jsonl", {
      mkdirSync: () => {},
      readFileIfExists: () => existing,
      writeFileSync: (_p, d) => {
        written = d;
      },
    });
    const lines = written.trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "not valid json");
  });
});
