/**
 * test/brevo-campaigns-backfill-8115.test.ts
 *
 * Cobertura da Fatia B do #6720 (issue #8115) — paginação por offset e
 * backfill throttled/retomável de campanhas Brevo além da janela ao vivo de
 * `CAMPAIGNS_FETCH_LIMIT` (100 mais recentes).
 *
 * Cobre:
 *   (A) `parseCampaignsCount`/`fetchCampaignsCount` — medição barata (1 GET,
 *       limit=1) do total de campanhas `sent` na conta.
 *   (B) `fetchCampaignsListPage` — paginação por offset, sem enriquecimento
 *       de stats (distinto de `fetchRecentCampaigns`).
 *   (C) `normalizeCampaignsBackfillCursor` — parsing defensivo do cursor.
 *   (D) `runCampaignsBackfillBatch` — o núcleo retomável/throttled:
 *       - mede `totalCount` só na 1ª chamada (cursor sem totalCount ainda);
 *       - avança o offset e persiste o cursor entre chamadas;
 *       - grava `stats:{id}` (permanente, sem TTL) só para campanhas
 *         IMUTÁVEIS (>7d) ainda não cacheadas — idempotente: uma 2ª chamada
 *         sobre a mesma janela não refaz o GET de stats;
 *       - pula (mas registra no índice de arquivo) campanhas mutáveis;
 *       - marca `done: true` quando o offset alcança o total.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCampaignsCount,
  fetchCampaignsCount,
  fetchCampaignsListPage,
  normalizeCampaignsBackfillCursor,
  readCampaignsBackfillCursor,
  readCampaignsArchiveIndex,
  runCampaignsBackfillBatch,
  BrevoRateLimitError,
  CAMPAIGNS_ARCHIVE_INDEX_KV_KEY,
  CAMPAIGNS_BACKFILL_CURSOR_KV_KEY,
  CAMPAIGNS_FETCH_LIMIT,
} from "../workers/brevo-dashboard/src/index.ts";
import type { BrevoGlobalStats } from "../workers/brevo-dashboard/src/types.ts";

// ─── helpers ──────────────────────────────────────────────────────────────

function makeKvMock(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const putCalls: Array<{ key: string; value: unknown }> = [];
  return {
    store,
    putCalls,
    kv: {
      get: async (key: string, type?: string) => {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      put: async (key: string, value: string) => {
        putCalls.push({ key, value: JSON.parse(value) });
        store.set(key, value);
      },
      delete: async () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-14T12:00:00Z");

function makeCampaign(id: number, ageMs: number) {
  const sentDate = new Date(NOW - ageMs).toISOString();
  return {
    id,
    name: `Campanha ${id}`,
    subject: "s",
    status: "sent",
    sentDate,
    scheduledAt: null,
    createdAt: sentDate,
    recipients: { lists: [9] },
    statistics: { campaignStats: [] },
  };
}

const fakeGs: BrevoGlobalStats = {
  sent: 200,
  delivered: 190,
  hardBounces: 3,
  softBounces: 1,
  uniqueViews: 60,
  viewed: 65,
  trackableViews: 50,
  uniqueClicks: 12,
  clickers: 10,
  unsubscriptions: 1,
  complaints: 0,
  appleMppOpens: 4,
};

function makeFakeFetch(opts: {
  countResponse?: number;
  campaignsByOffset: Record<number, ReturnType<typeof makeCampaign>[]>;
  totalCount?: number;
}) {
  const calls: string[] = [];
  const fetchFn = async (path: string) => {
    calls.push(path);
    if (path.includes("limit=1&sort=desc") && !path.includes("offset")) {
      return { campaigns: [], count: opts.countResponse ?? opts.totalCount ?? 0 };
    }
    const offsetMatch = path.match(/offset=(\d+)/);
    if (offsetMatch) {
      const offset = Number(offsetMatch[1]);
      const campaigns = opts.campaignsByOffset[offset] ?? [];
      return { campaigns, count: opts.totalCount ?? 0 };
    }
    const statsMatch = path.match(/emailCampaigns\/(\d+)\?statistics=globalStats/);
    if (statsMatch) {
      return { statistics: { globalStats: fakeGs } };
    }
    throw new Error(`unexpected path in test fetchFn: ${path}`);
  };
  return { fetchFn, calls };
}

describe("#8115 — parseCampaignsCount / fetchCampaignsCount", () => {
  test("parseCampaignsCount extrai count válido", () => {
    assert.equal(parseCampaignsCount({ count: 342 }), 342);
  });

  test("parseCampaignsCount devolve null quando ausente/inválido", () => {
    assert.equal(parseCampaignsCount({}), null);
    assert.equal(parseCampaignsCount({ count: "342" }), null);
    assert.equal(parseCampaignsCount({ count: -1 }), null);
    assert.equal(parseCampaignsCount(null), null);
  });

  test("fetchCampaignsCount faz 1 GET com limit=1 e devolve o count", async () => {
    const { fetchFn, calls } = makeFakeFetch({ campaignsByOffset: {}, totalCount: 342 });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: undefined } as any;
    const count = await fetchCampaignsCount(env, fetchFn as any);
    assert.equal(count, 342);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /limit=1/);
  });
});

describe("#8115 — fetchCampaignsListPage (paginação por offset)", () => {
  test("busca a página no offset pedido, sem enriquecer com stats", async () => {
    const c1 = makeCampaign(101, 10 * DAY);
    const c2 = makeCampaign(102, 11 * DAY);
    const { fetchFn, calls } = makeFakeFetch({
      campaignsByOffset: { [CAMPAIGNS_FETCH_LIMIT]: [c1, c2] },
      totalCount: 150,
    });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: undefined } as any;
    const page = await fetchCampaignsListPage(
      env,
      { limit: 20, offset: CAMPAIGNS_FETCH_LIMIT },
      fetchFn as any,
    );
    assert.deepEqual(page.campaigns.map((c) => c.id), [101, 102]);
    assert.equal(page.count, 150);
    assert.equal(calls.length, 1);
    assert.match(calls[0], new RegExp(`offset=${CAMPAIGNS_FETCH_LIMIT}`));
    // Não enriquece com stats — sem GET individual por campanha.
    assert.ok(!calls.some((c) => c.includes("statistics=globalStats")));
  });
});

describe("#8115 — normalizeCampaignsBackfillCursor", () => {
  test("aceita shape válido", () => {
    const cursor = normalizeCampaignsBackfillCursor({
      offset: 120,
      totalCount: 300,
      done: false,
      updatedAt: "2026-09-14T00:00:00Z",
    });
    assert.deepEqual(cursor, { offset: 120, totalCount: 300, done: false, updatedAt: "2026-09-14T00:00:00Z" });
  });

  test("totalCount ausente vira null (ainda não medido)", () => {
    const cursor = normalizeCampaignsBackfillCursor({ offset: 100, done: false, updatedAt: "x" });
    assert.equal(cursor?.totalCount, null);
  });

  test("shape inválido/ausente devolve null", () => {
    assert.equal(normalizeCampaignsBackfillCursor(null), null);
    assert.equal(normalizeCampaignsBackfillCursor({}), null);
    assert.equal(normalizeCampaignsBackfillCursor({ offset: "100", done: false, updatedAt: "x" }), null);
  });
});

describe("#8115 — readCampaignsBackfillCursor (default)", () => {
  test("KV vazio devolve cursor default (offset = CAMPAIGNS_FETCH_LIMIT, não medido)", async () => {
    const { kv } = makeKvMock();
    const cursor = await readCampaignsBackfillCursor({ STATS_CACHE: kv as any }, NOW);
    assert.equal(cursor.offset, CAMPAIGNS_FETCH_LIMIT);
    assert.equal(cursor.totalCount, null);
    assert.equal(cursor.done, false);
  });

  test("STATS_CACHE ausente (dev local) também devolve o default — nunca lança", async () => {
    const cursor = await readCampaignsBackfillCursor({ STATS_CACHE: undefined as any }, NOW);
    assert.equal(cursor.offset, CAMPAIGNS_FETCH_LIMIT);
  });
});

describe("#8115 — runCampaignsBackfillBatch", () => {
  test("1ª chamada mede totalCount, busca 1 página, grava stats só das imutáveis", async () => {
    const c1 = makeCampaign(101, 10 * DAY); // imutável
    const c2 = makeCampaign(102, 2 * DAY); // mutável — pulada
    const c3 = makeCampaign(103, 30 * DAY); // imutável
    const { fetchFn, calls } = makeFakeFetch({
      campaignsByOffset: { [CAMPAIGNS_FETCH_LIMIT]: [c1, c2, c3] },
      totalCount: 103,
    });
    const { kv, putCalls } = makeKvMock();
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any;

    const result = await runCampaignsBackfillBatch(env, { batchSize: 20, _fetchFn: fetchFn as any, nowMs: NOW });

    assert.equal(result.scanned, 3);
    assert.equal(result.statsFetched, 2); // c1 + c3 (imutáveis, sem cache prévio)
    assert.equal(result.alreadyCached, 0);
    assert.equal(result.skippedMutable, 1); // c2
    assert.equal(result.cursor.offset, CAMPAIGNS_FETCH_LIMIT + 3);
    assert.equal(result.cursor.totalCount, 103);
    assert.equal(result.cursor.done, true); // offset (103) >= totalCount (103)

    // stats:{id} gravado (sem TTL) só pras imutáveis.
    const statsWrites = putCalls.filter((p) => p.key.startsWith("stats:"));
    assert.deepEqual(
      statsWrites.map((w) => w.key).sort(),
      ["stats:101", "stats:103"],
    );

    // índice de arquivo inclui as 2 imutáveis, não a mutável.
    const archive = await readCampaignsArchiveIndex({ STATS_CACHE: kv as any });
    assert.deepEqual(archive.map((a) => a.id).sort(), [101, 103]);

    // 1 GET de count + 1 GET de listagem + 2 GETs de stats = 4.
    assert.equal(result.requestsUsed, 4);
    assert.equal(calls.length, 4);
  });

  test("2ª chamada não refaz GET de stats pra campanha já cacheada (idempotente)", async () => {
    const c1 = makeCampaign(101, 10 * DAY);
    const { fetchFn, calls } = makeFakeFetch({
      campaignsByOffset: { [CAMPAIGNS_FETCH_LIMIT]: [c1] },
      totalCount: 101,
    });
    const { kv } = makeKvMock({
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: {
        offset: CAMPAIGNS_FETCH_LIMIT,
        totalCount: 101,
        done: false,
        updatedAt: new Date(NOW).toISOString(),
      },
      "stats:101": { gs: fakeGs }, // já cacheado por uma chamada anterior
    });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any;

    const result = await runCampaignsBackfillBatch(env, { batchSize: 20, _fetchFn: fetchFn as any, nowMs: NOW });

    assert.equal(result.statsFetched, 0);
    assert.equal(result.alreadyCached, 1);
    // totalCount já conhecido no cursor — não re-mede (sem GET limit=1).
    assert.ok(!calls.some((c) => c.includes("limit=1") && !c.includes("offset")));
    // Só o GET de listagem — nenhum GET de stats (já cacheado).
    assert.equal(calls.length, 1);
  });

  test("cursor já done não gasta nenhuma request nova", async () => {
    const { fetchFn, calls } = makeFakeFetch({ campaignsByOffset: {}, totalCount: 100 });
    const { kv } = makeKvMock({
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: {
        offset: 100,
        totalCount: 100,
        done: true,
        updatedAt: new Date(NOW).toISOString(),
      },
    });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any;

    const result = await runCampaignsBackfillBatch(env, { _fetchFn: fetchFn as any, nowMs: NOW });

    assert.equal(result.scanned, 0);
    assert.equal(result.requestsUsed, 0);
    assert.equal(calls.length, 0);
    assert.equal(result.cursor.done, true);
  });

  test("página vazia (offset além do fim) marca done mesmo sem totalCount bater exato", async () => {
    const { fetchFn } = makeFakeFetch({
      campaignsByOffset: { [CAMPAIGNS_FETCH_LIMIT]: [] },
      totalCount: 90, // já era < offset (100) — cenário de contagem defasada
    });
    const { kv } = makeKvMock();
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any;

    const result = await runCampaignsBackfillBatch(env, { _fetchFn: fetchFn as any, nowMs: NOW });

    assert.equal(result.scanned, 0);
    assert.equal(result.cursor.done, true);
  });

  test("globalStats zerado (sent=0) não é persistido — evita entrada permanente errada", async () => {
    const c1 = makeCampaign(201, 10 * DAY);
    const calls: string[] = [];
    const fetchFn = async (path: string) => {
      calls.push(path);
      if (path.includes("offset=")) return { campaigns: [c1], count: 201 };
      if (path.includes("statistics=globalStats")) {
        return { statistics: { globalStats: { ...fakeGs, sent: 0 } } };
      }
      return { campaigns: [], count: 201 };
    };
    const { kv, putCalls } = makeKvMock();
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any;

    const result = await runCampaignsBackfillBatch(env, { _fetchFn: fetchFn as any, nowMs: NOW });

    assert.equal(result.statsFetched, 0);
    assert.ok(!putCalls.some((p) => p.key === "stats:201"));
  });

  test("rate-limit REAL esgotado no meio do batch: para o loop e NÃO pula campanhas nunca examinadas (achado de self-review)", async () => {
    // 3 campanhas imutáveis na página; a 2ª esgota o retry de rate-limit
    // (BrevoRateLimitError(0) — retryAfterSecs=0 evita qualquer sleep real
    // no teste, ver computeRetryDelayMs). Sem o guard de `break`, o loop
    // tentaria (e provavelmente falharia de novo) a 3ª campanha também,
    // e o offset avançaria por cima das 3 mesmo que só a 1ª tenha sido
    // gravada com sucesso — perdendo a 3ª PARA SEMPRE (o cursor só anda
    // pra frente).
    const c1 = makeCampaign(301, 10 * DAY);
    const c2 = makeCampaign(302, 11 * DAY);
    const c3 = makeCampaign(303, 12 * DAY);
    const calls: string[] = [];
    const fetchFn = async (path: string) => {
      calls.push(path);
      if (path.includes("offset=")) return { campaigns: [c1, c2, c3], count: 303 };
      if (path.includes("emailCampaigns/302")) throw new BrevoRateLimitError(0);
      if (path.includes("statistics=globalStats")) return { statistics: { globalStats: fakeGs } };
      return { campaigns: [], count: 303 };
    };
    const { kv, putCalls } = makeKvMock({
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: {
        offset: CAMPAIGNS_FETCH_LIMIT,
        totalCount: 303,
        done: false,
        updatedAt: new Date(NOW).toISOString(),
      },
    });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any;

    const result = await runCampaignsBackfillBatch(env, { batchSize: 20, _fetchFn: fetchFn as any, nowMs: NOW });

    // c1 gravado; c2 tentou e esgotou o retry (break); c3 NUNCA examinada.
    assert.equal(result.statsFetched, 1);
    assert.ok(putCalls.some((p) => p.key === "stats:301"));
    assert.ok(!putCalls.some((p) => p.key === "stats:303"));
    // Offset avança só até a campanha que causou o break (2 processadas:
    // c1 + c2) — NUNCA até 3, que pularia c3 permanentemente.
    assert.equal(result.scanned, 2);
    assert.equal(result.cursor.offset, CAMPAIGNS_FETCH_LIMIT + 2);
    assert.equal(result.cursor.done, false); // ainda falta c3 — não é o fim do total
    // c3 nem entrou no índice de arquivo ainda (nunca foi examinada).
    const archive = await readCampaignsArchiveIndex({ STATS_CACHE: kv as any });
    assert.deepEqual(archive.map((a) => a.id).sort(), [301, 302]);
  });
});
