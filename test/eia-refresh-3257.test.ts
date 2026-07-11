/**
 * test/eia-refresh-3257.test.ts (#3257)
 *
 * Regressão (#633) para workers/brevo-dashboard/src/eia-refresh.ts — o botão
 * "Atualizar" da aba Engajamento (É IA?), que reimplementa DENTRO do worker
 * o mesmo pipeline mensal de `scripts/build-poll-eia-data.ts --push`, mas
 * descobrindo os ciclos via `GET /editions?brand=clarice` (endpoint novo do
 * worker poll, #3257 — ver test/poll-editions-endpoint-3257.test.ts) em vez
 * de `data/monthly/` local (inacessível a um Worker).
 *
 * Cobertura:
 *  - fetchClariceEditions: consome /editions, filtra só formato YYMM-MM.
 *  - fetchCycleStats: consome /stats?edition=X&brand=clarice; null em
 *    404/erro/total=0 (mesmo fail-soft do script original).
 *  - buildEiaEngagementFromPoll: agrega em EiaEngagementSummary, ordenado
 *    desc, truncado a 20.
 *  - refreshEiaEngagement: grava no KV STATS_CACHE (mock); nunca lança —
 *    falha de rede/binding ausente vira {ok:false, error}.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchClariceEditions,
  fetchCycleStats,
  buildEiaEngagementFromPoll,
  refreshEiaEngagement,
} from "../workers/brevo-dashboard/src/eia-refresh.ts";
import { EIA_ENGAGEMENT_KV_KEY, type Env } from "../workers/brevo-dashboard/src/types.ts";
import worker from "../workers/brevo-dashboard/src/index.ts";

// Cache API polyfill (usada incondicionalmente por index.ts::fetch antes do
// roteamento por path) — mesmo padrão de test/dashboard-auth.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).caches = {
  default: {
    match: async (_req: unknown) => null,
    put: async (_req: unknown, _res: unknown) => {},
  },
};

const WORKER_URL = "https://poll.test";

function installFetchStub(editionsPayload: unknown, statsMap: Record<string, unknown>): () => void {
  const orig = globalThis.fetch;
  // @ts-ignore substituição de global.fetch em Node 18+ (mesmo padrão de build-poll-eia-data.test.ts)
  globalThis.fetch = async (url: string | URL) => {
    const urlStr = String(url);
    if (urlStr.includes("/editions")) {
      return { ok: true, status: 200, json: async () => editionsPayload };
    }
    const m = urlStr.match(/edition=([^&]+)/);
    const edition = m ? decodeURIComponent(m[1]) : "";
    if (edition in statsMap) {
      const val = statsMap[edition];
      if (val === null) return { ok: false, status: 404, text: async () => "Not Found" };
      return { ok: true, status: 200, json: async () => val };
    }
    return { ok: false, status: 404, text: async () => "Not Found" };
  };
  return () => {
    globalThis.fetch = orig;
  };
}

function makeStatsCacheKv(): Env["STATS_CACHE"] {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const v = store.get(key) ?? null;
      if (v === null) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true, cursor: undefined };
    },
    _store: store,
  } as unknown as Env["STATS_CACHE"] & { _store: Map<string, string> };
}

describe("fetchClariceEditions (#3257)", () => {
  test("filtra só ciclos YYMM-MM — descarta AAMMDD/lixo que /editions poderia devolver", async () => {
    const restore = installFetchStub(
      { brand: "clarice", editions: ["2606-07", "260601", "2605-06", "lixo"] },
      {},
    );
    try {
      const cycles = await fetchClariceEditions(WORKER_URL);
      assert.deepEqual(cycles, ["2606-07", "2605-06"]);
    } finally {
      restore();
    }
  });

  test("HTTP não-ok → lança (caller decide o fallback)", async () => {
    const orig = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
    try {
      await assert.rejects(() => fetchClariceEditions(WORKER_URL));
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("payload sem array 'editions' → lança (shape inesperado)", async () => {
    const orig = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ brand: "clarice" }) });
    try {
      await assert.rejects(() => fetchClariceEditions(WORKER_URL));
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("fetchCycleStats (#3257)", () => {
  test("total=0 → null (edição sem votos, mesmo fail-soft do script original)", async () => {
    const restore = installFetchStub({ editions: [] }, { "2606-07": { total: 0 } });
    try {
      const stats = await fetchCycleStats(WORKER_URL, "2606-07");
      assert.equal(stats, null);
    } finally {
      restore();
    }
  });

  test("404 → null", async () => {
    const restore = installFetchStub({ editions: [] }, { "2606-07": null });
    try {
      const stats = await fetchCycleStats(WORKER_URL, "2606-07");
      assert.equal(stats, null);
    } finally {
      restore();
    }
  });

  test("erro de rede → null (nunca lança)", async () => {
    const orig = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    try {
      const stats = await fetchCycleStats(WORKER_URL, "2606-07");
      assert.equal(stats, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("sucesso → retorna o payload de stats", async () => {
    const restore = installFetchStub(
      { editions: [] },
      { "2606-07": { total: 100, voted_a: 60, voted_b: 40, correct_answer: "A", correct_count: 60, correct_pct: 60 } },
    );
    try {
      const stats = await fetchCycleStats(WORKER_URL, "2606-07");
      assert.deepEqual(stats, { total: 100, voted_a: 60, voted_b: 40, correct_answer: "A", correct_count: 60, correct_pct: 60 });
    } finally {
      restore();
    }
  });
});

describe("buildEiaEngagementFromPoll (#3257)", () => {
  test("agrega ciclos com dado, pula os sem dado, ordena desc", async () => {
    const restore = installFetchStub(
      { brand: "clarice", editions: ["2605-06", "2606-07", "2604-05"] },
      {
        "2605-06": { total: 50, voted_a: 30, voted_b: 20, correct_answer: "B", correct_count: 20, correct_pct: 40 },
        "2606-07": { total: 80, voted_a: 50, voted_b: 30, correct_answer: "A", correct_count: 50, correct_pct: 63 },
        "2604-05": { total: 0 }, // sem votos → excluído
      },
    );
    try {
      const summary = await buildEiaEngagementFromPoll(WORKER_URL);
      assert.equal(summary.editions.length, 2, "2604-05 (total=0) não deve aparecer");
      assert.deepEqual(
        summary.editions.map((e) => e.edition),
        ["2606-07", "2605-06"],
        "mais recente primeiro",
      );
      assert.equal(summary.editions[0].total_votes, 80);
      assert.ok(summary.updated_at, "updated_at deve estar presente");
    } finally {
      restore();
    }
  });

  test("nenhum ciclo com dado → editions vazio, sem lançar", async () => {
    const restore = installFetchStub({ brand: "clarice", editions: [] }, {});
    try {
      const summary = await buildEiaEngagementFromPoll(WORKER_URL);
      assert.deepEqual(summary.editions, []);
    } finally {
      restore();
    }
  });
});

describe("refreshEiaEngagement (#3257)", () => {
  test("sucesso: grava EiaEngagementSummary em STATS_CACHE sob EIA_ENGAGEMENT_KV_KEY", async () => {
    const restore = installFetchStub(
      { brand: "clarice", editions: ["2606-07"] },
      { "2606-07": { total: 10, voted_a: 6, voted_b: 4, correct_answer: "A", correct_count: 6, correct_pct: 60 } },
    );
    const kv = makeStatsCacheKv();
    const env = { STATS_CACHE: kv } as unknown as Env;
    try {
      const result = await refreshEiaEngagement(env, WORKER_URL);
      assert.deepEqual(result, { ok: true, editionsCount: 1 });
      const raw = await kv.get(EIA_ENGAGEMENT_KV_KEY, "json");
      assert.ok(raw, "deve ter gravado no KV");
      const parsed = raw as { editions: Array<{ edition: string }> };
      assert.equal(parsed.editions[0].edition, "2606-07");
    } finally {
      restore();
    }
  });

  test("STATS_CACHE ausente → {ok:false} sem lançar", async () => {
    const env = { STATS_CACHE: undefined } as unknown as Env;
    const result = await refreshEiaEngagement(env, WORKER_URL);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /STATS_CACHE/);
  });

  test("falha de rede no /editions → {ok:false} com a mensagem de erro, KV não é tocado", async () => {
    const orig = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
    const kv = makeStatsCacheKv();
    const env = { STATS_CACHE: kv } as unknown as Env;
    try {
      const result = await refreshEiaEngagement(env, WORKER_URL);
      assert.equal(result.ok, false);
      assert.equal(await kv.get(EIA_ENGAGEMENT_KV_KEY), null, "não deve ter gravado nada no KV em caso de falha");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

// ── POST /api/eia/refresh — integração via router (#3257) ───────────────────
//
// #eia-refresh-route: usa DEFAULT_POLL_WORKER_URL hardcoded (poll.diaria.workers.dev)
// dentro do worker, então o stub de fetch aqui precisa reconhecer essa URL real
// (diferente dos testes acima, que passam WORKER_URL explícito pras funções puras).

const AUTH_COOKIE_NAME = "cf-dash-auth";
const TOKEN = "test-token-eia-refresh";

describe("POST /api/eia/refresh — integração via router (#3257)", () => {
  test("sem cookie de auth → loginPage (401/200 com form), não executa o refresh", async () => {
    const orig = globalThis.fetch;
    let fetchCalled = false;
    // @ts-ignore
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => ({ editions: [] }) };
    };
    const kv = makeStatsCacheKv();
    const env = { STATS_CACHE: kv, AUTH_TOKEN: TOKEN, BREVO_API_KEY: "x" } as unknown as Env;
    try {
      const req = new Request("https://dash.test/api/eia/refresh", { method: "POST" });
      const res = await worker.fetch(req, env);
      const text = await res.text();
      assert.match(text, /clarice dashboard — login|token/i, "sem cookie deve cair na loginPage");
      assert.equal(fetchCalled, false, "não deve ter chamado o worker poll sem autenticar");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("com cookie válido: sucesso → 302 redirect pra /?fresh=1#panel-engajamento, KV atualizado", async () => {
    const orig = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/editions")) {
        return { ok: true, status: 200, json: async () => ({ brand: "clarice", editions: ["2606-07"] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ total: 10, voted_a: 6, voted_b: 4, correct_answer: "A", correct_count: 6, correct_pct: 60 }),
      };
    };
    const kv = makeStatsCacheKv();
    const env = { STATS_CACHE: kv, AUTH_TOKEN: TOKEN, BREVO_API_KEY: "x" } as unknown as Env;
    try {
      const req = new Request("https://dash.test/api/eia/refresh", {
        method: "POST",
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${TOKEN}` },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("Location"), "/?fresh=1#panel-engajamento");
      const raw = await kv.get(EIA_ENGAGEMENT_KV_KEY, "json");
      assert.ok(raw, "KV deve ter sido atualizado");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("com cookie válido: falha no worker poll → 502 com link de volta, sem redirect", async () => {
    const orig = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "poll down" });
    const kv = makeStatsCacheKv();
    const env = { STATS_CACHE: kv, AUTH_TOKEN: TOKEN, BREVO_API_KEY: "x" } as unknown as Env;
    try {
      const req = new Request("https://dash.test/api/eia/refresh", {
        method: "POST",
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${TOKEN}` },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 502);
      const text = await res.text();
      assert.match(text, /Refresh do É IA\? falhou/);
      assert.match(text, /panel-engajamento/, "deve linkar de volta pro dashboard");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("GET /api/eia/refresh (método errado) → não executa o refresh (só POST está roteado)", async () => {
    const orig = globalThis.fetch;
    let fetchCalled = false;
    // @ts-ignore
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => ({ editions: [] }) };
    };
    const kv = makeStatsCacheKv();
    const env = { STATS_CACHE: kv, AUTH_TOKEN: TOKEN, BREVO_API_KEY: "x" } as unknown as Env;
    try {
      const req = new Request("https://dash.test/api/eia/refresh", {
        method: "GET",
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${TOKEN}` },
      });
      const res = await worker.fetch(req, env);
      assert.notEqual(res.status, 302, "GET não deve disparar o refresh/redirect");
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
