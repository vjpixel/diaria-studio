/**
 * test/brevo-dashboard-lastgood-hash-gate-5216.test.ts (#5216)
 *
 * Regressão: `dash:lastgood:campaigns` (LASTGOOD_CAMPAIGNS_KEY) era gravado
 * INCONDICIONALMENTE a cada fetch bem-sucedido não-`fresh` da rota `/` — sem
 * TTL de escrita, sem hash de conteúdo, sem intervalo mínimo. O free tier da
 * Cloudflare tem teto de ~1.000 escritas de KV/dia POR CONTA, compartilhado
 * com o Worker `poll` — isso já quase estourou uma vez (#2282).
 *
 * O fix reintroduz o gate por hash (padrão já usado pré-#2739 para o HTML
 * lastgood, removido quando o modelo mudou de HTML pra campaigns-lastgood):
 * só grava quando o CONTEÚDO (campaigns + scheduled + campaignsLimit) mudou
 * desde o último write bem-sucedido, guardando um hash djb2 auxiliar em
 * `dash:lastgood:campaigns:hash`.
 *
 * Cobertura (os 3 cenários pedidos na issue):
 *   (a) payload idêntico ao anterior → nenhuma escrita.
 *   (b) payload diferente → escreve.
 *   (c) chave ausente (primeira execução) → escreve.
 *
 * Fixtures 100% sintéticas — nenhum id/email real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, {
  LASTGOOD_CAMPAIGNS_KEY,
  LASTGOOD_CAMPAIGNS_HASH_KEY,
  djb2Hash,
  CAMPAIGNS_FETCH_LIMIT,
} from "../workers/brevo-dashboard/src/index.ts";

// Cache API (usada por /) — mesmo polyfill de test/brevo-dashboard-request-refresh-3553.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).caches = {
  default: {
    match: async (_req: unknown) => null,
    put: async (_req: unknown, _res: unknown) => {},
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeKvMock(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const putCalls: Array<{ key: string; value: string }> = [];
  return {
    store,
    putCalls,
    kv: {
      get: async (key: string, type?: string) => {
        const v = store.get(key);
        if (v == null) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      put: async (key: string, value: string) => {
        putCalls.push({ key, value });
        store.set(key, value);
      },
      delete: async () => {},
      list: async () => ({ keys: [], cursor: "", list_complete: true }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const sentDateOld = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const fakeCampaign = {
  id: 1,
  name: "Camp Teste",
  subject: "Assunto",
  status: "sent",
  sentDate: sentDateOld,
  scheduledAt: null,
  createdAt: sentDateOld,
  recipients: { lists: [] as number[] },
};
const fakeGlobalStats = {
  sent: 100,
  delivered: 95,
  hardBounces: 1,
  softBounces: 1,
  uniqueViews: 40,
  viewed: 42,
  trackableViews: 35,
  uniqueClicks: 8,
  clickers: 7,
  unsubscriptions: 1,
  complaints: 0,
  appleMppOpens: 3,
};

function mockBrevoFetch() {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes("emailCampaigns?status=sent")) {
      return new Response(JSON.stringify({ campaigns: [fakeCampaign] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("emailCampaigns?status=queued")) {
      return new Response(JSON.stringify({ campaigns: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/v3/account")) {
      return new Response(JSON.stringify({ plan: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("emailCampaigns/1")) {
      return new Response(
        JSON.stringify({ ...fakeCampaign, statistics: { globalStats: fakeGlobalStats } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

const TOKEN = "lastgood-hash-gate-test-token";
const COOKIE = `cf-dash-auth=${TOKEN}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEnv(kv: any) {
  return { BREVO_API_KEY: "k", STATS_CACHE: kv, AUTH_TOKEN: TOKEN };
}

describe("djb2Hash (#5216)", () => {
  it("é determinístico para a mesma entrada", () => {
    assert.equal(djb2Hash("abc"), djb2Hash("abc"));
  });

  it("produz hashes diferentes para conteúdos diferentes (não garantido em teoria, mas verificado para estes fixtures)", () => {
    assert.notEqual(djb2Hash("abc"), djb2Hash("abd"));
  });
});

describe("rota / (#5216) — write-through de dash:lastgood:campaigns gated por hash", () => {
  it("(c) chave ausente (1ª execução) → escreve payload + hash", async () => {
    const { kv, store, putCalls } = makeKvMock();
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      assert.ok(store.get(LASTGOOD_CAMPAIGNS_KEY), "1ª execução deve gravar o payload");
      assert.ok(store.get(LASTGOOD_CAMPAIGNS_HASH_KEY), "1ª execução deve gravar o hash");
      assert.ok(
        putCalls.some((c) => c.key === LASTGOOD_CAMPAIGNS_KEY),
        "write do payload deve ter sido observado no mock",
      );
      assert.ok(
        putCalls.some((c) => c.key === LASTGOOD_CAMPAIGNS_HASH_KEY),
        "write do hash deve ter sido observado no mock",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("(a) payload idêntico ao anterior (mesmo conteúdo, hash já gravado) → NENHUMA escrita", async () => {
    // Pré-computa o hash exatamente como o worker computaria, pro cenário
    // "já rodou uma vez com este mesmo conteúdo".
    const stableContent = JSON.stringify({
      campaigns: [fakeCampaign].map((c) => ({ ...c, statistics: { globalStats: fakeGlobalStats } })),
      scheduled: [],
      campaignsLimit: CAMPAIGNS_FETCH_LIMIT,
    });
    const prevHash = djb2Hash(stableContent);
    const { kv, store, putCalls } = makeKvMock({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [fakeCampaign],
        scheduled: [],
        generatedAt: new Date(Date.now() - 3600_000).toISOString(),
        campaignsLimit: CAMPAIGNS_FETCH_LIMIT,
      }),
      [LASTGOOD_CAMPAIGNS_HASH_KEY]: prevHash,
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      assert.equal(
        putCalls.some((c) => c.key === LASTGOOD_CAMPAIGNS_KEY),
        false,
        "conteúdo idêntico ao hash gravado → NÃO deve reescrever o payload",
      );
      assert.equal(
        putCalls.some((c) => c.key === LASTGOOD_CAMPAIGNS_HASH_KEY),
        false,
        "conteúdo idêntico ao hash gravado → NÃO deve reescrever o hash",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("(b) payload diferente do hash gravado → escreve payload + hash novo", async () => {
    const { kv, store, putCalls } = makeKvMock({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [],
        scheduled: [],
        generatedAt: new Date(Date.now() - 3600_000).toISOString(),
        campaignsLimit: CAMPAIGNS_FETCH_LIMIT,
      }),
      [LASTGOOD_CAMPAIGNS_HASH_KEY]: "deadbeef", // hash de um conteúdo diferente (vazio)
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      assert.ok(
        putCalls.some((c) => c.key === LASTGOOD_CAMPAIGNS_KEY),
        "conteúdo mudou (agora tem 1 campanha) → deve reescrever o payload",
      );
      assert.ok(
        putCalls.some((c) => c.key === LASTGOOD_CAMPAIGNS_HASH_KEY),
        "conteúdo mudou → deve reescrever o hash",
      );
      const parsed = JSON.parse(store.get(LASTGOOD_CAMPAIGNS_KEY)!);
      assert.equal(parsed.campaigns.length, 1, "o payload novo deve refletir a campanha do fetch atual");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("hash gravado sobrevive a 2 requests idênticas consecutivas — só a 1ª escreve", async () => {
    const { kv, putCalls } = makeKvMock();
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const req1 = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      await worker.fetch(req1, makeEnv(kv));
      const writesAfterFirst = putCalls.filter((c) => c.key === LASTGOOD_CAMPAIGNS_KEY).length;
      assert.equal(writesAfterFirst, 1, "1ª request escreve");

      const req2 = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      await worker.fetch(req2, makeEnv(kv));
      const writesAfterSecond = putCalls.filter((c) => c.key === LASTGOOD_CAMPAIGNS_KEY).length;
      assert.equal(
        writesAfterSecond,
        1,
        "2ª request com o MESMO fetch mock (mesmo conteúdo) não deve reescrever — é o cerne do fix #5216",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
