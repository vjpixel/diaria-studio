/**
 * test/brevo-2324-2337-regression.test.ts
 *
 * Testes de regressão para:
 *   #2324 — parseRetryAfterMs compartilhado: exportado de brevo-client.ts,
 *            importado em clarice-build-waves.ts (eliminando cópia divergente).
 *   #2337 fix 1 — brevo-dashboard brevoFetch: literal retry-after:0 → 0ms;
 *                 elapsed epoch-reset → ≥250ms floor (não 0ms).
 *   #2337 fix 2 — brevo-dashboard KV-write churn: imutável com ls-fetch falho
 *                 grava lsPending:true; próximo render detecta e pula re-fetch.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── #2324: parseRetryAfterMs exportado de brevo-client.ts ───────────────────

describe("parseRetryAfterMs compartilhado (#2324)", async () => {
  const { parseRetryAfterMs } = await import("../scripts/lib/brevo-client.ts");

  test("retry-after delta → ms direto", () => {
    const h = new Headers({ "retry-after": "3" });
    assert.strictEqual(parseRetryAfterMs(h), 3000);
  });

  test("retry-after:0 → 0ms (RFC 7231 retry imediato)", () => {
    const h = new Headers({ "retry-after": "0" });
    assert.strictEqual(parseRetryAfterMs(h), 0,
      "retry-after:0 deve ser 0ms — RFC 7231 imediato, sem clamp inferior");
  });

  test("x-sib-ratelimit-reset delta (< 1e9) → ms direto", () => {
    const h = new Headers({ "x-sib-ratelimit-reset": "5" });
    assert.strictEqual(parseRetryAfterMs(h), 5000);
  });

  test("x-sib-ratelimit-reset epoch futuro → delta em ms", () => {
    const futureEpoch = Math.floor(Date.now() / 1000) + 4; // 4s no futuro
    const h = new Headers({ "x-sib-ratelimit-reset": String(futureEpoch) });
    const result = parseRetryAfterMs(h);
    // Deve ser entre 3s e 5s (tolerância de clock)
    assert.ok(result >= 3000 && result <= 5000,
      `epoch futuro deve retornar ~4000ms, foi ${result}ms`);
  });

  test("x-sib-ratelimit-reset epoch já expirado → 0ms (janela passou, brevo-client)", () => {
    const pastEpoch = Math.floor(Date.now() / 1000) - 10; // 10s no passado
    const h = new Headers({ "x-sib-ratelimit-reset": String(pastEpoch) });
    // brevo-client.ts: Math.max(0, Math.ceil(past - now)) = 0 → 0ms
    assert.strictEqual(parseRetryAfterMs(h), 0,
      "epoch expirado → 0ms em brevo-client (sem floor — worker aplica 250ms separadamente)");
  });

  test("sem headers → fallback 2000ms (default)", () => {
    const h = new Headers();
    assert.strictEqual(parseRetryAfterMs(h), 2000,
      "sem headers → fallback padrão 2s");
  });

  test("sem headers + fallbackMs=3000 → 3000ms", () => {
    const h = new Headers();
    assert.strictEqual(parseRetryAfterMs(h, 3000), 3000,
      "fallbackMs customizado deve ser honrado");
  });

  test("sem headers + fallbackMs=9000 → 9000ms (máx RETRY_MS[2] do clarice)", () => {
    const h = new Headers();
    assert.strictEqual(parseRetryAfterMs(h, 9000), 9000);
  });

  test("cap 30s honrado — retry-after:60 → 30000ms", () => {
    const h = new Headers({ "retry-after": "60" });
    assert.strictEqual(parseRetryAfterMs(h), 30_000,
      "retry-after acima do cap de 30s deve ser clampeado");
  });

  test("retry-after tem precedência sobre x-sib-ratelimit-reset", () => {
    const h = new Headers({
      "retry-after": "2",
      "x-sib-ratelimit-reset": "10",
    });
    assert.strictEqual(parseRetryAfterMs(h), 2000,
      "retry-after presente → ignorar x-sib-ratelimit-reset");
  });
});

// ─── #2337 fix 1: elapsed epoch-reset → ≥250ms floor no dashboard worker ────

describe("brevoFetch epoch-reset-elapsed vs retry-after:0 (#2337 fix 1)", async () => {
  const { computeRetryDelayMs, BrevoRateLimitError, withRateLimitRetry } =
    await import("../workers/brevo-dashboard/src/index.ts");

  // Testa via withRateLimitRetry + BrevoRateLimitError, pois brevoFetch não é
  // exportado. O fix é no campo retryAfterSecs do BrevoRateLimitError lançado
  // por brevoFetch: epoch-elapsed → retryAfterSecs=0.25 → computeRetryDelayMs(0.25) = 250ms.
  // Antes do fix: epoch-elapsed → retryAfterSecs=0 → computeRetryDelayMs(0) = 0ms.

  test("computeRetryDelayMs(0.25) → 250ms (representa floor do epoch-elapsed)", () => {
    assert.strictEqual(computeRetryDelayMs(0.25), 250,
      "0.25s (floor para epoch elapsed) deve resultar em 250ms");
  });

  test("retry-after:0 literal → computeRetryDelayMs(0) = 0ms (RFC 7231 imediato)", () => {
    assert.strictEqual(computeRetryDelayMs(0), 0,
      "literal retry-after:0 deve resultar em 0ms — RFC 7231 retry imediato, sem clamp inferior");
  });

  test("withRateLimitRetry com BrevoRateLimitError(0) → sleep(0ms)", async () => {
    let sleepMs: number | undefined;
    const fakeSleep = async (ms: number) => { sleepMs = ms; };
    let calls = 0;
    await withRateLimitRetry(async () => {
      calls++;
      if (calls === 1) throw new BrevoRateLimitError(0); // literal retry-after: 0
      return "ok";
    }, 3, fakeSleep);
    assert.strictEqual(sleepMs, 0,
      "BrevoRateLimitError(0) — retry-after:0 literal — deve chamar sleep(0ms)");
  });

  test("withRateLimitRetry com BrevoRateLimitError(0.25) → sleep(250ms) (epoch-elapsed)", async () => {
    // brevoFetch após o fix: epoch elapsed → retryAfterSecs=0.25
    let sleepMs: number | undefined;
    const fakeSleep = async (ms: number) => { sleepMs = ms; };
    let calls = 0;
    await withRateLimitRetry(async () => {
      calls++;
      if (calls === 1) throw new BrevoRateLimitError(0.25); // epoch elapsed → floor
      return "ok";
    }, 3, fakeSleep);
    assert.ok(sleepMs !== undefined && sleepMs >= 250,
      `epoch-elapsed (BrevoRateLimitError(0.25)) deve resultar em sleep ≥ 250ms, foi ${sleepMs}ms`);
  });

  test("epoch-elapsed floor não regride para caso > 0 (ex: reset em 3s)", () => {
    // BrevoRateLimitError(3) → computeRetryDelayMs(3) = 3000ms — sem alteração
    assert.strictEqual(computeRetryDelayMs(3), 3000,
      "epoch futuro (3s) não deve ser afetado pelo floor de elapsed");
  });
});

// ─── #2337 fix 2: lsPending:true — sem KV-write churn em ls-fetch falho ──────

describe("lsPending:true previne KV-write churn (#2337 fix 2)", async () => {
  const { fetchRecentCampaigns } = await import("../workers/brevo-dashboard/src/index.ts");

  function makeKVMock(initialData: Record<string, unknown> = {}) {
    const store = new Map(
      Object.entries(initialData).map(([k, v]) => [k, JSON.stringify(v)])
    );
    const putCalls: Array<{ key: string; value: string; opts: unknown }> = [];
    return {
      store,
      putCalls,
      kv: {
        get: async (key: string, type?: string) => {
          const val = store.get(key);
          if (!val) return null;
          if (type === "json") return JSON.parse(val);
          return val;
        },
        put: async (key: string, value: string, opts?: unknown) => {
          putCalls.push({ key, value, opts: opts ?? null });
          store.set(key, value);
        },
        delete: async () => {},
        list: async () => ({ keys: [], cursor: "", list_complete: true }),
        getWithMetadata: async () => ({ value: null, metadata: null }),
      } as unknown as KVNamespace,
    };
  }

  // Campanha imutável (>7 dias atrás)
  const sentDateOld = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const fakeGs = {
    sent: 100, delivered: 95, hardBounces: 2, softBounces: 1,
    uniqueViews: 40, viewed: 45, trackableViews: 35, uniqueClicks: 10,
    clickers: 9, unsubscriptions: 1, complaints: 0, appleMppOpens: 5,
  };
  const fakeList = { id: 5, name: "Lista Test 2337", totalSubscribers: 300 };
  const fakeCampaign = {
    id: 99, name: "Campaign 2337", subject: "2337", status: "sent",
    sentDate: sentDateOld, scheduledAt: null, createdAt: sentDateOld,
    recipients: { lists: [5] },
    statistics: { campaignStats: [] },
  };

  function makeMockFetch(lsFetchCount: { n: number }, lsFails = true) {
    return async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (/emailCampaigns\/99\?statistics=globalStats/.test(path)) {
        return { ...fakeCampaign, statistics: { globalStats: fakeGs } } as T;
      }
      if (/emailCampaigns\/99\?statistics=linksStats/.test(path)) {
        lsFetchCount.n++;
        if (lsFails) throw new Error("ls-fetch 429 simulado");
        return { ...fakeCampaign, statistics: { linksStats: { "https://diar.ia/test": 5 } } } as T;
      }
      if (/contacts\/lists\/5/.test(path)) return fakeList as T;
      throw new Error("path inesperado: " + path);
    };
  }

  test("1ª render: ls-fetch falha → stats:99 gravado com lsPending:true", async () => {
    const { kv, putCalls } = makeKVMock({ "list:5": fakeList });
    const lsFetchCount = { n: 0 };

    await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, makeMockFetch(lsFetchCount) as any,
    );

    assert.strictEqual(lsFetchCount.n, 1, "1ª render: ls-fetch deve ter sido tentado 1x");

    const statsPut = putCalls.find(p => p.key === "stats:99");
    assert.ok(statsPut, "deve ter gravado stats:99");
    const stored = JSON.parse(statsPut!.value);
    assert.strictEqual(stored.lsPending, true,
      "JSON gravado deve conter lsPending:true quando ls-fetch falha");
    assert.ok(!("ls" in stored),
      "JSON gravado NÃO deve conter campo ls quando ls-fetch falhou");
  });

  test("2ª render: lsPending:true no KV → ls-fetch NÃO tentado, 0 novos writes", async () => {
    const { kv, putCalls } = makeKVMock({ "list:5": fakeList });
    const lsFetchCount = { n: 0 };
    const mockFetch = makeMockFetch(lsFetchCount);

    // 1ª render: ls-fetch falha → grava lsPending:true
    await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, mockFetch as any,
    );
    assert.strictEqual(lsFetchCount.n, 1, "1ª render: ls-fetch tentado 1x");
    const writesAfter1st = putCalls.length;

    // 2ª render: KV contém lsPending:true → ls-fetch NÃO deve ocorrer; 0 writes
    await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, mockFetch as any,
    );
    assert.strictEqual(lsFetchCount.n, 1,
      "2ª render com lsPending:true → ls-fetch NÃO deve ser chamado (churn parado)");

    const newWrites = putCalls.slice(writesAfter1st).filter(p => p.key === "stats:99");
    assert.strictEqual(newWrites.length, 0,
      "2ª render com lsPending:true → NENHUM novo write de stats:99 (sem churn KV)");
  });

  test("lsPending expira (KV miss) → próxima render tenta ls-fetch novamente", async () => {
    const { kv, store, putCalls } = makeKVMock({ "list:5": fakeList });
    const lsFetchCount = { n: 0 };
    const mockFetch = makeMockFetch(lsFetchCount);

    // 1ª render: grava lsPending:true
    await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, mockFetch as any,
    );
    assert.strictEqual(lsFetchCount.n, 1);

    // Simula TTL expirado: remove stats:99 do KV
    store.delete("stats:99");

    // Render pós-TTL: KV miss → ls-fetch deve ser tentado novamente
    await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, mockFetch as any,
    );
    assert.strictEqual(lsFetchCount.n, 2,
      "após TTL expirar (KV miss), ls-fetch deve ser tentado novamente");
  });

  test("ls-fetch bem-sucedido → stats:99 gravado sem lsPending (normal)", async () => {
    const { kv, putCalls } = makeKVMock({ "list:5": fakeList });
    const lsFetchCount = { n: 0 };
    const mockFetch = makeMockFetch(lsFetchCount, false); // lsFails=false

    await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, mockFetch as any,
    );

    const statsPut = putCalls.find(p => p.key === "stats:99");
    assert.ok(statsPut, "deve ter gravado stats:99");
    const stored = JSON.parse(statsPut!.value);
    assert.ok(stored.lsPending !== true,
      "ls-fetch bem-sucedido: lsPending NÃO deve estar no JSON");
    assert.ok("ls" in stored,
      "ls-fetch bem-sucedido: campo ls deve estar presente no JSON");
  });
});

// ─── #2324: clarice-build-waves importa o helper compartilhado ───────────────
// Verificação de integração: brevoGet em clarice-build-waves usa parseRetryAfterMs
// importado de brevo-client. Comportamento esperado: retry-after:0 → wait 0ms.

describe("clarice-build-waves brevoGet usa parseRetryAfterMs compartilhado (#2324)", () => {
  test("brevoGet: retry-after:0 → retenta (importado de brevo-client)", async () => {
    const { brevoGet } = await import("../scripts/clarice-build-waves.ts");
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;

    const mockFetch = async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return new Response(null, {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ contacts: [], count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    try {
      await brevoGet("fake-key", "/contacts?limit=1&offset=0");
    } finally {
      globalThis.fetch = origFetch;
    }

    assert.strictEqual(fetchCalls, 2,
      "brevoGet deve retentar em 429 com retry-after:0 (via parseRetryAfterMs compartilhado)");
  });
});
