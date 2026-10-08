/**
 * test/brevo-campaigns-backfill-kv-failures-9857.test.ts
 *
 * Regressões do lote clarice-backfill (achados de review das PRs #9854/#9860):
 *
 *   - #9857: falha de escrita de `stats:{id}` não conta como stats obtidos — a
 *     posição volta às lacunas e a próxima rodada grava.
 *   - #9861: falha de escrita do índice de arquivo aborta a rodada SEM gravar o
 *     cursor (antes: índice perdido + cursor avançado = lote fora pra sempre).
 *   - #9863: falha de LEITURA do cursor aborta sem gravar nada (antes: cursor
 *     padrão gravado por cima do salvo, perdendo `gaps`/`done`).
 *   - #9859: `count` ausente na medição inicial não grava `done: true`; e um
 *     cursor `done` já gravado assim com `totalCount: null` volta a varrer.
 *   - #9858: 403/5xx persistente no GET de stats de UMA campanha tem teto de
 *     tentativas; rede/timeout não conta tentativa.
 *
 * KV de verdade do backfill: `RemoteKvNamespace` com `strictReads`+
 * `strictWrites` sobre um fake da API HTTP do Cloudflare KV. Nenhuma rede.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runCampaignsBackfillBatch,
  normalizeCampaignsBackfillCursor,
  readCampaignsBackfillCursor,
  BrevoUpstreamError,
  CampaignsArchiveIndexWriteError,
  CampaignsBackfillCursorReadError,
  CAMPAIGNS_ARCHIVE_INDEX_KV_KEY,
  CAMPAIGNS_BACKFILL_CURSOR_KV_KEY,
  CAMPAIGNS_BACKFILL_CURSOR_VERSION,
  CAMPAIGNS_FETCH_LIMIT,
  BACKFILL_MAX_STATS_ATTEMPTS,
} from "../workers/brevo-dashboard/src/brevo-api.ts";
import { RemoteKvNamespace } from "../scripts/lib/cloudflare-kv-upload.ts";
import { BACKFILL_KV_OPTS } from "../scripts/clarice-backfill-campaigns.ts";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-10-08T12:00:00Z");
const EXTRA = 30;
const TOTAL = CAMPAIGNS_FETCH_LIMIT + EXTRA;

/** Fake da API HTTP do Cloudflare KV. `failGet`/`failPut`: chaves (ou
 * predicado) cujo GET/PUT responde 500. */
function makeKv(
  initial: Record<string, unknown> = {},
  opts: { failGet?: (key: string) => boolean; failPut?: (key: string) => boolean } = {},
) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
  const puts: string[] = [];
  const failGet = { fn: opts.failGet ?? (() => false) };
  const failPut = { fn: opts.failPut ?? (() => false) };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const key = decodeURIComponent(String(url).split("/values/")[1].split("?")[0]);
    if ((init?.method ?? "GET") === "PUT") {
      if (failPut.fn(key)) return new Response("upstream error", { status: 500 });
      puts.push(key);
      store.set(key, String(init?.body));
      return new Response("{}", { status: 200 });
    }
    if (failGet.fn(key)) return new Response("upstream error", { status: 500 });
    const v = store.get(key);
    return v === undefined ? new Response("not found", { status: 404 }) : new Response(v, { status: 200 });
  }) as typeof fetch;
  const kv = new RemoteKvNamespace({ accountId: "acc", token: "tok", kvNamespaceId: "ns" }, fetchImpl, BACKFILL_KV_OPTS);
  return {
    store,
    puts,
    failGet,
    failPut,
    env: { BREVO_API_KEY: "x", STATS_CACHE: kv } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    json: (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : undefined),
  };
}

/** Brevo fake: `TOTAL` campanhas imutáveis, mais recente primeiro.
 * `statsError(id)` devolve um erro a lançar no GET de stats (ou undefined). */
function makeBrevo(opts: { count?: number | null; statsError?: (id: number) => Error | undefined } = {}) {
  const campaigns = Array.from({ length: TOTAL }, (_, i) => ({
    id: 1000 - i,
    name: `c${1000 - i}`,
    sentDate: new Date(NOW - 30 * DAY - i * DAY).toISOString(),
    recipients: { lists: [1] },
  }));
  const statsGets: number[] = [];
  const fetchFn = (async (path: string) => {
    const m = path.match(/emailCampaigns\/(\d+)\?statistics=globalStats/);
    if (m) {
      const id = Number(m[1]);
      statsGets.push(id);
      const err = opts.statsError?.(id);
      if (err) throw err;
      return { statistics: { globalStats: { sent: 10, delivered: 10 } } };
    }
    const limit = Number(path.match(/limit=(\d+)/)?.[1] ?? 50);
    const offset = Number(path.match(/offset=(\d+)/)?.[1] ?? 0);
    const count = opts.count === undefined ? campaigns.length : opts.count;
    return { campaigns: campaigns.slice(offset, offset + limit), ...(count == null ? {} : { count }) };
  }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { campaigns, statsGets, fetchFn };
}

const run = (env: unknown, fetchFn: unknown, batchSize = EXTRA) =>
  runCampaignsBackfillBatch(env as any, { batchSize, _fetchFn: fetchFn as any, nowMs: NOW }); // eslint-disable-line @typescript-eslint/no-explicit-any

describe("#9857 — falha de escrita de stats:{id} não fecha a lacuna", () => {
  test("PUT de stats falhando → não conta statsFetched, posição volta às lacunas; rodada seguinte grava", async () => {
    const failingId = 1000 - CAMPAIGNS_FETCH_LIMIT - 3; // 4ª campanha fora da janela
    const kv = makeKv({}, { failPut: (k) => k === `stats:${failingId}` });
    const brevo = makeBrevo();

    const r1 = await run(kv.env, brevo.fetchFn);
    assert.equal(r1.statsFetched, EXTRA - 1);
    assert.equal(r1.cursor.done, false, "a campanha sem stats gravados mantém o cursor aberto");
    assert.deepEqual(r1.cursor.gaps, [{ start: CAMPAIGNS_FETCH_LIMIT + 3, end: CAMPAIGNS_FETCH_LIMIT + 4 }]);
    assert.equal(kv.store.has(`stats:${failingId}`), false);
    assert.ok(kv.json(CAMPAIGNS_ARCHIVE_INDEX_KV_KEY).some((e: { id: number }) => e.id === failingId), "segue no índice");

    kv.failPut.fn = () => false;
    const r2 = await run(kv.env, brevo.fetchFn);
    assert.equal(r2.statsFetched, 1);
    assert.equal(r2.cursor.done, true);
    assert.ok(kv.store.has(`stats:${failingId}`));
  });
});

describe("#9861 — falha de escrita do índice não avança o cursor", () => {
  test("PUT do índice falhando → lança CampaignsArchiveIndexWriteError e o cursor salvo fica intacto", async () => {
    const savedCursor = {
      offset: CAMPAIGNS_FETCH_LIMIT, totalCount: TOTAL, done: false,
      gaps: [{ start: CAMPAIGNS_FETCH_LIMIT, end: TOTAL }],
      version: CAMPAIGNS_BACKFILL_CURSOR_VERSION, updatedAt: new Date(NOW - DAY).toISOString(),
    };
    const kv = makeKv({ [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: savedCursor }, { failPut: (k) => k === CAMPAIGNS_ARCHIVE_INDEX_KV_KEY });
    const brevo = makeBrevo();

    await assert.rejects(run(kv.env, brevo.fetchFn), CampaignsArchiveIndexWriteError);
    assert.ok(!kv.puts.includes(CAMPAIGNS_BACKFILL_CURSOR_KV_KEY), "cursor não regravado");
    assert.deepEqual(kv.json(CAMPAIGNS_BACKFILL_CURSOR_KV_KEY), savedCursor);

    // KV de volta: a mesma faixa é relida, o lote entra no índice e os stats
    // já gravados na rodada que falhou não geram GET de novo.
    kv.failPut.fn = () => false;
    const getsBefore = brevo.statsGets.length;
    const r = await run(kv.env, brevo.fetchFn);
    assert.equal(r.cursor.done, true);
    assert.equal(kv.json(CAMPAIGNS_ARCHIVE_INDEX_KV_KEY).length, EXTRA);
    assert.equal(brevo.statsGets.length, getsBefore, "stats já cacheados não refazem GET");
  });

  test("KV nativo do Worker que lança no PUT do índice → mesma recusa", async () => {
    const store = new Map<string, unknown>();
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, v: string) => {
        if (key === CAMPAIGNS_ARCHIVE_INDEX_KV_KEY) throw new Error("KV PUT failed: 503");
        store.set(key, JSON.parse(v));
      },
      delete: async () => {},
    };
    await assert.rejects(run({ BREVO_API_KEY: "x", STATS_CACHE: kv }, makeBrevo().fetchFn), CampaignsArchiveIndexWriteError);
    assert.equal(store.has(CAMPAIGNS_BACKFILL_CURSOR_KV_KEY), false);
  });
});

describe("#9863 — falha de leitura do cursor não refaz a varredura", () => {
  test("GET do cursor falhando (500) → lança, nenhuma request Brevo, nenhuma gravação", async () => {
    const savedCursor = {
      offset: CAMPAIGNS_FETCH_LIMIT, totalCount: TOTAL, done: true,
      version: CAMPAIGNS_BACKFILL_CURSOR_VERSION, updatedAt: new Date(NOW - DAY).toISOString(),
    };
    const kv = makeKv({ [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: savedCursor }, { failGet: (k) => k === CAMPAIGNS_BACKFILL_CURSOR_KV_KEY });
    let brevoCalls = 0;
    const brevo = makeBrevo();
    const counting = (async (...args: unknown[]) => { brevoCalls++; return brevo.fetchFn(...args); }) as unknown;

    await assert.rejects(run(kv.env, counting), CampaignsBackfillCursorReadError);
    assert.equal(brevoCalls, 0);
    assert.deepEqual(kv.puts, []);
    assert.deepEqual(kv.json(CAMPAIGNS_BACKFILL_CURSOR_KV_KEY), savedCursor);
  });

  test("cursor ausente (404) segue sendo a 1ª execução", async () => {
    const kv = makeKv();
    const r = await run(kv.env, makeBrevo().fetchFn);
    assert.equal(r.scanned, EXTRA);
    assert.equal(r.cursor.done, true);
  });

  test("a variante fail-soft (fora do backfill) continua devolvendo o cursor padrão", async () => {
    const kv = makeKv({}, { failGet: () => true });
    const c = await readCampaignsBackfillCursor(kv.env, NOW);
    assert.equal(c.totalCount, null);
    assert.equal(c.done, false);
  });
});

describe("#9859 — contagem null não marca o cursor como concluído", () => {
  test("1ª execução com `count` ausente → nenhuma gravação; rodada seguinte varre tudo", async () => {
    const kv = makeKv();
    const r1 = await run(kv.env, makeBrevo({ count: null }).fetchFn);
    assert.equal(r1.cursor.done, false);
    assert.equal(r1.scanned, 0);
    assert.deepEqual(kv.puts, [], "nem cursor `done`, nem nada");

    const r2 = await run(kv.env, makeBrevo().fetchFn);
    assert.equal(r2.scanned, EXTRA);
    assert.equal(kv.json(CAMPAIGNS_ARCHIVE_INDEX_KV_KEY).length, EXTRA);
  });

  test("cursor já gravado pelo bug (`done: true`, `totalCount: null`, version 2) volta a varrer [LIMIT, total)", async () => {
    const stuck = {
      offset: CAMPAIGNS_FETCH_LIMIT, totalCount: null, done: true,
      version: CAMPAIGNS_BACKFILL_CURSOR_VERSION, updatedAt: new Date(NOW - DAY).toISOString(),
    };
    const kv = makeKv({ [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: stuck });
    const r = await run(kv.env, makeBrevo().fetchFn);
    assert.equal(r.scanned, EXTRA);
    assert.equal(r.cursor.totalCount, TOTAL);
    assert.equal(kv.json(CAMPAIGNS_ARCHIVE_INDEX_KV_KEY).length, EXTRA);
  });
});

describe("#9858 — 403/5xx persistente numa campanha tem teto de tentativas", () => {
  const failingId = 1000 - CAMPAIGNS_FETCH_LIMIT; // 1ª fora da janela

  test(`500 sempre na mesma campanha → desiste na ${BACKFILL_MAX_STATS_ATTEMPTS}ª rodada e o cursor fecha`, async () => {
    const kv = makeKv();
    const brevo = makeBrevo({ statsError: (id) => (id === failingId ? new BrevoUpstreamError(500, "boom") : undefined) });

    for (let round = 1; round < BACKFILL_MAX_STATS_ATTEMPTS; round++) {
      const r = await run(kv.env, brevo.fetchFn);
      assert.equal(r.cursor.done, false, `rodada ${round}: ainda pendente`);
      assert.equal(r.cursor.statsAttempts?.[String(failingId)], round);
      assert.equal(r.statsGivenUp, 0);
    }
    const last = await run(kv.env, brevo.fetchFn);
    assert.equal(last.statsGivenUp, 1);
    assert.equal(last.cursor.done, true, "não fica `done=false` pra sempre");
    assert.equal(last.cursor.statsAttempts, undefined, "registro auxiliar limpo");
    assert.ok(kv.json(CAMPAIGNS_ARCHIVE_INDEX_KV_KEY).some((e: { id: number }) => e.id === failingId), "fica no índice sem stats");
    assert.equal(kv.store.has(`stats:${failingId}`), false);

    const after = await run(kv.env, brevo.fetchFn);
    const getsOnFailing = brevo.statsGets.filter((id) => id === failingId).length;
    assert.equal(getsOnFailing, BACKFILL_MAX_STATS_ATTEMPTS, "nenhum GET depois de desistir");
    assert.equal(after.scanned, 0);
  });

  test("sucesso depois de falhas limpa a contagem", async () => {
    let failing = true;
    const kv = makeKv();
    const brevo = makeBrevo({ statsError: (id) => (failing && id === failingId ? new BrevoUpstreamError(503, "down") : undefined) });
    await run(kv.env, brevo.fetchFn);
    await run(kv.env, brevo.fetchFn);
    failing = false;
    const r = await run(kv.env, brevo.fetchFn);
    assert.equal(r.cursor.done, true);
    assert.equal(r.cursor.statsAttempts, undefined);
    assert.ok(kv.store.has(`stats:${failingId}`));
  });

  test("erro de rede/timeout não conta tentativa", async () => {
    const kv = makeKv();
    const brevo = makeBrevo({ statsError: (id) => (id === failingId ? new TypeError("fetch failed") : undefined) });
    for (let round = 0; round < BACKFILL_MAX_STATS_ATTEMPTS + 1; round++) {
      const r = await run(kv.env, brevo.fetchFn);
      assert.equal(r.cursor.done, false);
      assert.equal(r.cursor.statsAttempts, undefined);
    }
  });

  test("normalizeCampaignsBackfillCursor preserva statsAttempts válidos e descarta lixo", () => {
    const base = { offset: 100, totalCount: 130, done: false, updatedAt: "2026-10-08T00:00:00Z" };
    assert.deepEqual(normalizeCampaignsBackfillCursor({ ...base, statsAttempts: { "7": 2, "8": "x", "9": -1 } })?.statsAttempts, { "7": 2 });
    assert.equal(normalizeCampaignsBackfillCursor({ ...base, statsAttempts: [1, 2] })?.statsAttempts, undefined);
    assert.equal(normalizeCampaignsBackfillCursor(base)?.statsAttempts, undefined);
  });
});

describe("RemoteKvNamespace — strictWrites", () => {
  test("default segue no-op em falha de PUT; strictWrites lança", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const cfg = { accountId: "acc", token: "tok", kvNamespaceId: "ns" };
    await new RemoteKvNamespace(cfg, fetchImpl).put("k", "v");
    await new RemoteKvNamespace(cfg, fetchImpl, { strictReads: true }).put("k", "v");
    await assert.rejects(new RemoteKvNamespace(cfg, fetchImpl, { strictWrites: true }).put("k", "v"), /falhou \(500\)/);
  });
});
