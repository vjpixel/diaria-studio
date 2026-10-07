/**
 * test/brevo-campaigns-archive-index-read-9856.test.ts
 *
 * #9856 — falha de LEITURA do índice de arquivo (`dash:campaigns:archive-index`)
 * não pode ser tratada como índice vazio pelo backfill. Antes: o
 * `RemoteKvNamespace.get` devolvia `null` em qualquer falha (rede, 5xx,
 * timeout), `readCampaignsArchiveIndex` devolvia `[]`, e o backfill gravava
 * `[...[], ...lote]` — o índice inteiro trocado pelas ~20 entradas do lote,
 * com o cursor avançando e nunca relendo o que sumiu.
 *
 * Cenário reproduzido ponta a ponta com o adaptador REAL do backfill
 * (`RemoteKvNamespace` com `strictReads`, o mesmo que
 * `scripts/clarice-backfill-campaigns.ts` monta) sobre um fake da API HTTP do
 * Cloudflare KV: a leitura do índice responde 500 → a chamada aborta e
 * NENHUM PUT acontece (nem índice, nem cursor). Chave ausente (404) segue a
 * 1ª execução de sempre.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runCampaignsBackfillBatch,
  readCampaignsArchiveIndex,
  readCampaignsArchiveIndexStrict,
  CampaignsArchiveIndexReadError,
  CAMPAIGNS_ARCHIVE_INDEX_KV_KEY,
  CAMPAIGNS_BACKFILL_CURSOR_KV_KEY,
  CAMPAIGNS_BACKFILL_CURSOR_VERSION,
  CAMPAIGNS_FETCH_LIMIT,
} from "../workers/brevo-dashboard/src/brevo-api.ts";
import { RemoteKvNamespace } from "../scripts/lib/cloudflare-kv-upload.ts";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-10-07T12:00:00Z");

/** Fake da API HTTP do Cloudflare KV (`/values/{key}`): GET 200/404, PUT
 * grava. `failGet` faz o GET dessas chaves responder 500. */
function makeCloudflareKv(initial: Record<string, unknown>, failGet: ReadonlySet<string> = new Set()) {
  const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const puts: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const key = decodeURIComponent(String(url).split("/values/")[1].split("?")[0]);
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      puts.push(key);
      store.set(key, String(init?.body));
      return new Response("{}", { status: 200 });
    }
    if (failGet.has(key)) return new Response("upstream error", { status: 500 });
    const v = store.get(key);
    return v === undefined ? new Response("not found", { status: 404 }) : new Response(v, { status: 200 });
  }) as typeof fetch;
  const cfg = { accountId: "acc", token: "tok", kvNamespaceId: "ns" };
  return {
    store,
    puts,
    strict: new RemoteKvNamespace(cfg, fetchImpl, { strictReads: true }),
    lenient: new RemoteKvNamespace(cfg, fetchImpl),
  };
}

/** 130 campanhas imutáveis (mais recente primeiro) — 30 fora da janela ao vivo. */
function makeBrevo() {
  const campaigns = Array.from({ length: CAMPAIGNS_FETCH_LIMIT + 30 }, (_, i) => ({
    id: 1000 - i,
    name: `c${1000 - i}`,
    sentDate: new Date(NOW - 30 * DAY - i * DAY).toISOString(),
    recipients: { lists: [1] },
  }));
  return {
    campaigns,
    fetchFn: (async (path: string) => {
      if (/emailCampaigns\/\d+\?statistics=globalStats/.test(path)) {
        return { statistics: { globalStats: { sent: 10, delivered: 10 } } };
      }
      const limit = Number(path.match(/limit=(\d+)/)?.[1] ?? 50);
      const offset = Number(path.match(/offset=(\d+)/)?.[1] ?? 0);
      return { campaigns: campaigns.slice(offset, offset + limit), count: campaigns.length };
    }) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/** Estado de produção: índice com 147 entradas antigas + cursor no meio. */
function productionState() {
  const archive = Array.from({ length: 147 }, (_, i) => ({ id: i + 1, name: `old${i + 1}`, sentDate: "2026-01-01T00:00:00Z", listIds: [1] }));
  return {
    archive,
    state: {
      [CAMPAIGNS_ARCHIVE_INDEX_KV_KEY]: archive,
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: {
        offset: CAMPAIGNS_FETCH_LIMIT, totalCount: CAMPAIGNS_FETCH_LIMIT + 30, done: false,
        gaps: [{ start: CAMPAIGNS_FETCH_LIMIT, end: CAMPAIGNS_FETCH_LIMIT + 30 }],
        version: CAMPAIGNS_BACKFILL_CURSOR_VERSION, updatedAt: new Date(NOW - DAY).toISOString(),
      },
    } as Record<string, unknown>,
  };
}

describe("#9856 — falha de leitura do índice não apaga o histórico", () => {
  test("leitura do índice falhando (500) → backfill aborta sem gravar índice nem cursor", async () => {
    const { archive, state } = productionState();
    const kv = makeCloudflareKv(state, new Set([CAMPAIGNS_ARCHIVE_INDEX_KV_KEY]));
    const cursorBefore = kv.store.get(CAMPAIGNS_BACKFILL_CURSOR_KV_KEY);
    const brevo = makeBrevo();
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv.strict } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    await assert.rejects(
      runCampaignsBackfillBatch(env, { batchSize: 20, _fetchFn: brevo.fetchFn, nowMs: NOW }),
      CampaignsArchiveIndexReadError,
    );
    assert.deepEqual(kv.puts, [], "nenhuma gravação no KV (nem stats, nem índice, nem cursor)");
    assert.deepEqual(JSON.parse(kv.store.get(CAMPAIGNS_ARCHIVE_INDEX_KV_KEY)!), archive, "índice intacto");
    assert.equal(kv.store.get(CAMPAIGNS_BACKFILL_CURSOR_KV_KEY), cursorBefore, "cursor intacto");
  });

  test("a próxima rodada (KV de volta) recomeça do mesmo ponto e ANEXA ao índice", async () => {
    const { archive, state } = productionState();
    const kv = makeCloudflareKv(state);
    const brevo = makeBrevo();
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv.strict } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    await runCampaignsBackfillBatch(env, { batchSize: 20, _fetchFn: brevo.fetchFn, nowMs: NOW });
    const after = JSON.parse(kv.store.get(CAMPAIGNS_ARCHIVE_INDEX_KV_KEY)!) as Array<{ id: number }>;
    assert.equal(after.length, archive.length + 20, "147 antigas preservadas + 20 do lote");
    assert.deepEqual(after.slice(0, archive.length), archive);
  });

  test("valor de shape inválido no índice → aborta sem sobrescrever", async () => {
    const { state } = productionState();
    state[CAMPAIGNS_ARCHIVE_INDEX_KV_KEY] = { not: "an array" };
    const kv = makeCloudflareKv(state);
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv.strict } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    await assert.rejects(
      runCampaignsBackfillBatch(env, { batchSize: 20, _fetchFn: makeBrevo().fetchFn, nowMs: NOW }),
      CampaignsArchiveIndexReadError,
    );
    assert.deepEqual(kv.puts, []);
  });

  test("KV nativo do Worker que LANÇA na leitura → mesma recusa (sem gravação)", async () => {
    const puts: string[] = [];
    const kv = {
      get: async (key: string) => {
        if (key === CAMPAIGNS_ARCHIVE_INDEX_KV_KEY) throw new Error("KV GET failed: 503");
        return null;
      },
      put: async (key: string) => { puts.push(key); },
      delete: async () => {},
    };
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    await assert.rejects(
      runCampaignsBackfillBatch(env, { batchSize: 20, _fetchFn: makeBrevo().fetchFn, nowMs: NOW }),
      CampaignsArchiveIndexReadError,
    );
    assert.deepEqual(puts, []);
  });

  test("chave ausente (404) → 1ª execução inalterada: índice criado com o lote, cursor gravado", async () => {
    const kv = makeCloudflareKv({});
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv.strict } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    const result = await runCampaignsBackfillBatch(env, { batchSize: 20, _fetchFn: makeBrevo().fetchFn, nowMs: NOW });
    const index = JSON.parse(kv.store.get(CAMPAIGNS_ARCHIVE_INDEX_KV_KEY)!) as unknown[];
    assert.equal(index.length, 20);
    assert.ok(kv.puts.includes(CAMPAIGNS_BACKFILL_CURSOR_KV_KEY));
    assert.equal(result.cursor.done, false);
  });
});

describe("#9856 — contratos de leitura", () => {
  test("readCampaignsArchiveIndexStrict: ausente → [], falha → lança", async () => {
    const kv = makeCloudflareKv({}, new Set());
    assert.deepEqual(await readCampaignsArchiveIndexStrict({ STATS_CACHE: kv.strict as any }), []); // eslint-disable-line @typescript-eslint/no-explicit-any
    const failing = makeCloudflareKv({}, new Set([CAMPAIGNS_ARCHIVE_INDEX_KV_KEY]));
    await assert.rejects(
      readCampaignsArchiveIndexStrict({ STATS_CACHE: failing.strict as any }), // eslint-disable-line @typescript-eslint/no-explicit-any
      CampaignsArchiveIndexReadError,
    );
  });

  test("render segue fail-soft: readCampaignsArchiveIndex com falha → []", async () => {
    const failing = makeCloudflareKv({}, new Set([CAMPAIGNS_ARCHIVE_INDEX_KV_KEY]));
    assert.deepEqual(await readCampaignsArchiveIndex({ STATS_CACHE: failing.lenient as any }), []); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(await readCampaignsArchiveIndex({ STATS_CACHE: failing.strict as any }), []); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  test("RemoteKvNamespace: default fail-soft inalterado; strictReads lança em 5xx e JSON inválido, 404 segue null", async () => {
    const kv = makeCloudflareKv({ bad: "{not json", ok: { a: 1 } }, new Set(["boom"]));
    assert.equal(await kv.lenient.get("boom", "json"), null);
    assert.equal(await kv.lenient.get("bad", "json"), null);
    await assert.rejects(kv.strict.get("boom", "json"), /falhou \(500\)/);
    await assert.rejects(kv.strict.get("bad", "json"), SyntaxError);
    assert.equal(await kv.strict.get("missing", "json"), null);
    assert.deepEqual(await kv.strict.get("ok", "json"), { a: 1 });
  });
});
