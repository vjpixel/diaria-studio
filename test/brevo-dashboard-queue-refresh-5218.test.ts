/**
 * test/brevo-dashboard-queue-refresh-5218.test.ts (#5218 Peça 2)
 *
 * Integração da rota `/` com a fila "avisar quando atualizar"
 * (`dash:refresh:pending`, brevo-api.ts): o clique em "Avisar quando
 * atualizar" no banner de rate-limit grava um horário-alvo; a PRIMEIRA
 * request orgânica que chega igual-ou-depois desse horário é tratada como
 * fresh (bypassa cache) e a flag é limpa nesse mesmo request.
 *
 * Fixtures 100% sintéticas — nenhum id/email real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { REFRESH_PENDING_KV_KEY } from "../workers/brevo-dashboard/src/index.ts";

// Cache API (usada por /) -- sempre cache-miss, mesmo polyfill das outras
// suítes de brevo-dashboard (thundering-herd-3644, 3653). Setado no módulo
// (não por teste) porque `handleFetch` acessa `caches.default` ANTES de
// chegar em qualquer branch específica de rota, inclusive `?queueRefresh=1`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).caches = {
  default: { match: async () => null, put: async () => {} },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeKvMock(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
  const putCalls: string[] = [];
  const deleteCalls: string[] = [];
  return {
    store, putCalls, deleteCalls,
    kv: {
      get: async (key: string, type?: string) => {
        const v = store.get(key);
        if (v == null) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      put: async (key: string, value: string) => { putCalls.push(key); store.set(key, value); },
      delete: async (key: string) => { deleteCalls.push(key); store.delete(key); },
      list: async () => ({ keys: [], cursor: "", list_complete: true }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const sentDateOld = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const fakeCampaign = {
  id: 5218, name: "Camp Teste 5218", subject: "s", status: "sent",
  sentDate: sentDateOld, scheduledAt: null, createdAt: sentDateOld, recipients: { lists: [] as number[] },
};

function mockBrevoFetch() {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes("emailCampaigns?status=sent")) {
      return new Response(JSON.stringify({ campaigns: [fakeCampaign] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("emailCampaigns?status=queued")) {
      return new Response(JSON.stringify({ campaigns: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/v3/account")) {
      return new Response(JSON.stringify({ plan: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

const TOKEN = "queue-refresh-test-token";
const COOKIE = `cf-dash-auth=${TOKEN}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEnv(kv: any) {
  return { BREVO_API_KEY: "k", STATS_CACHE: kv, AUTH_TOKEN: TOKEN };
}

describe("GET /?queueRefresh=1 (#5218 Peça 2)", () => {
  it("resetAt no futuro -> grava dash:refresh:pending e redireciona pra /", async () => {
    const { kv, store, putCalls } = makeKvMock();
    const resetAt = Date.now() + 300_000;
    const req = new Request(`http://localhost/?queueRefresh=1&resetAt=${resetAt}`, { headers: { Cookie: COOKIE } });
    const res = await worker.fetch(req, makeEnv(kv));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), "/");
    assert.ok(putCalls.includes(REFRESH_PENDING_KV_KEY), "deveria ter gravado a fila");
    const stored = JSON.parse(store.get(REFRESH_PENDING_KV_KEY)!);
    assert.equal(stored.resetAt, resetAt);
  });

  it("resetAt ausente -> NÃO grava, redireciona pra /?fresh=1 (trata como pedido de fresh imediato)", async () => {
    const { kv, putCalls } = makeKvMock();
    const req = new Request("http://localhost/?queueRefresh=1", { headers: { Cookie: COOKIE } });
    const res = await worker.fetch(req, makeEnv(kv));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), "/?fresh=1");
    assert.equal(putCalls.length, 0, "sem resetAt válido, não deveria escrever nada no KV");
  });

  it("resetAt no passado -> NÃO grava, redireciona pra /?fresh=1", async () => {
    const { kv, putCalls } = makeKvMock();
    const req = new Request(`http://localhost/?queueRefresh=1&resetAt=${Date.now() - 5000}`, { headers: { Cookie: COOKIE } });
    const res = await worker.fetch(req, makeEnv(kv));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), "/?fresh=1");
    assert.equal(putCalls.length, 0);
  });
});

describe("GET / com dash:refresh:pending já maduro (#5218 Peça 2)", () => {
  it("pending com resetAt no PASSADO -> request tratada como fresh (Cache-Control: no-store) e a fila é limpa", async () => {
    const { kv, deleteCalls } = makeKvMock({
      [REFRESH_PENDING_KV_KEY]: { requestedAt: Date.now() - 400_000, resetAt: Date.now() - 1000 },
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-store", "auto-fresh devido -- não deve cachear como o render normal");
      assert.ok(deleteCalls.includes(REFRESH_PENDING_KV_KEY), "a fila deveria ter sido limpa após o consumo (sucesso)");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("pending com resetAt no FUTURO -> NÃO força fresh (render cacheável normal), fila NÃO é limpa", async () => {
    const futureResetAt = Date.now() + 300_000;
    const { kv, deleteCalls } = makeKvMock({
      [REFRESH_PENDING_KV_KEY]: { requestedAt: Date.now(), resetAt: futureResetAt },
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      assert.notEqual(res.headers.get("Cache-Control"), "no-store", "fila ainda não madura -- render normal, cacheável");
      // #3644 já deleta a própria chave do LOCK cross-colo em fluxo normal
      // (releaseRefreshLock) -- checar a chave ESPECÍFICA da fila, não
      // deleteCalls.length, pra não confundir os dois mecanismos.
      assert.ok(!deleteCalls.includes(REFRESH_PENDING_KV_KEY), "fila não deveria ser tocada antes de amadurecer");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("sem nenhuma fila pendente -> comportamento idêntico ao pré-#5218 (render normal cacheável)", async () => {
    const { kv, deleteCalls } = makeKvMock();
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      assert.notEqual(res.headers.get("Cache-Control"), "no-store");
      assert.ok(!deleteCalls.includes(REFRESH_PENDING_KV_KEY));
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
