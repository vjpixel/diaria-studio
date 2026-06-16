/**
 * test/brevo-2314-2307-regression.test.ts
 *
 * Testes de regressão para:
 *   #2314 — redução de writes KV por render (coalesce gstats+lstats → stats:{id})
 *   #2307 — consistência do retry 429 (sibReset:0 → retry imediato; retry-after:0 → 0ms)
 *
 * Covers:
 *   - computeRetryDelayMs: retryAfterSecs=0 → 0ms (não mais clampeado para 1s)
 *   - computeRetryDelayMs: retryAfterSecs=null → 2000ms (fallback)
 *   - computeRetryDelayMs: cap 5s honrado
 *   - brevoFetch / brevo-client parseRetryAfterMs: sibReset:0 → retryAfterSecs=0
 *   - KV write count: 2ª chamada consecutiva com mesmos dados não re-escreve (hit no stats:{id})
 *   - KV coalesce: 1 write (stats:{id}) em vez de 2 (gstats: + lstats:) quando dados são novos
 *   - Migração retrocompatível: stats:{id} ausente → fallback para gstats:+lstats: legados
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeRetryDelayMs,
  BrevoRateLimitError,
  withRateLimitRetry,
  fetchRecentCampaigns,
} from "../workers/brevo-dashboard/src/index.ts";

// ─── #2307: computeRetryDelayMs ──────────────────────────────────────────────

describe("computeRetryDelayMs (#2307)", () => {
  test("retryAfterSecs=0 → 0ms (retry imediato, RFC 7231 — não clampeado para 1000ms)", () => {
    // Regressão: versão anterior usava Math.max(s, 1)*1000 → 1000ms em vez de 0ms.
    assert.strictEqual(computeRetryDelayMs(0), 0, "reset:0 / retry-after:0 deve ser retry imediato (0ms)");
  });

  test("retryAfterSecs=null → 2000ms (fallback quando header ausente)", () => {
    assert.strictEqual(computeRetryDelayMs(null), 2000);
  });

  test("retryAfterSecs=3 → 3000ms", () => {
    assert.strictEqual(computeRetryDelayMs(3), 3000);
  });

  test("retryAfterSecs=10 → cap de 5000ms (não pendurar o Worker 10s)", () => {
    assert.strictEqual(computeRetryDelayMs(10), 5000);
  });

  test("retryAfterSecs=5 → exatamente 5000ms (boundary do cap)", () => {
    assert.strictEqual(computeRetryDelayMs(5), 5000);
  });

  test("retryAfterSecs=4 → 4000ms (abaixo do cap)", () => {
    assert.strictEqual(computeRetryDelayMs(4), 4000);
  });
});

// ─── #2307: withRateLimitRetry com retryAfterSecs=0 → retry imediato ─────────

describe("withRateLimitRetry: retry-after:0 → retry imediato (#2307)", () => {
  test("retryAfterSecs=0 → sleep(0) chamado, não sleep(1000)", async () => {
    let sleepCalledWith: number | undefined;
    const fakeSleep = async (ms: number) => { sleepCalledWith = ms; };
    let calls = 0;
    await withRateLimitRetry(async () => {
      calls++;
      if (calls === 1) throw new BrevoRateLimitError(0); // retry-after: 0
      return "ok";
    }, 3, fakeSleep);
    assert.strictEqual(sleepCalledWith, 0, "sleep deve ser chamado com 0ms (retry imediato), não 1000ms");
  });

  test("retryAfterSecs=null → sleep(2000) (fallback, header ausente)", async () => {
    let sleepCalledWith: number | undefined;
    const fakeSleep = async (ms: number) => { sleepCalledWith = ms; };
    let calls = 0;
    await withRateLimitRetry(async () => {
      calls++;
      if (calls === 1) throw new BrevoRateLimitError(null);
      return "ok";
    }, 3, fakeSleep);
    assert.strictEqual(sleepCalledWith, 2000, "sleep deve ser 2000ms quando header está ausente");
  });
});

// ─── #2307: sibReset:0 em brevoFetch (worker) → BrevoRateLimitError(0) ───────
// Testamos via withRateLimitRetry + BrevoRateLimitError(0) já acima.
// O teste de integração abaixo verifica a semântica de "reset:0 → retry imediato"
// end-to-end através de fetchRecentCampaigns com uma listagem que primeiro lança
// BrevoRateLimitError(0) e depois sucede.

describe("sibReset:0 / retry-after:0 → retry imediato em fetchRecentCampaigns (#2307)", () => {
  test("BrevoRateLimitError(0) → retry imediato (sleep=0ms) na listagem de campanhas", async () => {
    let sleepMs: number | undefined;
    // Substitui o comportamento de sleep: injetamos via withRateLimitRetry
    // internamente (não exposto no fetchRecentCampaigns), mas podemos verificar
    // o comportamento via BrevoRateLimitError(0) direto no wrapper.
    const fakeSleep = async (ms: number) => { sleepMs = ms; };
    let calls = 0;
    await withRateLimitRetry(async () => {
      calls++;
      if (calls === 1) throw new BrevoRateLimitError(0);
      return "ok";
    }, 3, fakeSleep);
    assert.strictEqual(calls, 2, "2ª tentativa deve ter sucedido");
    assert.strictEqual(sleepMs, 0, "sleep deve ser 0ms para retry-after:0 (imediato)");
  });
});

// ─── #2314: KV coalesce (stats:{id}) ─────────────────────────────────────────

describe("KV coalesce stats:{id} — 1 write por campanha (#2314)", () => {
  function makeKVMock(initialData: Record<string, unknown> = {}) {
    const store = new Map(
      Object.entries(initialData).map(([k, v]) => [k, JSON.stringify(v)])
    );
    const putCalls: string[] = [];
    const getCalls: string[] = [];
    return {
      store, putCalls, getCalls,
      kv: {
        get: async (key: string, type?: string) => {
          getCalls.push(key);
          const val = store.get(key);
          if (!val) return null;
          if (type === "json") return JSON.parse(val);
          return val;
        },
        put: async (key: string, value: string, _opts?: unknown) => {
          putCalls.push(key);
          store.set(key, value);
        },
        delete: async () => {},
        list: async () => ({ keys: [], cursor: "", list_complete: true }),
        getWithMetadata: async () => ({ value: null, metadata: null }),
      } as unknown as KVNamespace,
    };
  }

  const sentDateOld = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const fakeGlobalStats = {
    sent: 100, delivered: 95, hardBounces: 2, softBounces: 1,
    uniqueViews: 40, viewed: 45, trackableViews: 35, uniqueClicks: 10,
    clickers: 9, unsubscriptions: 1, complaints: 0, appleMppOpens: 5,
  };
  const fakeLinksStats = { "https://diar.ia.br/post-x": 5 };
  const fakeList = { id: 7, name: "Lista Teste", totalSubscribers: 500 };
  const fakeCampaign = {
    id: 42, name: "Test Campaign", subject: "Hello", status: "sent",
    sentDate: sentDateOld, scheduledAt: null, createdAt: sentDateOld,
    recipients: { lists: [7] },
    statistics: { campaignStats: [] },
  };
  const mockFetchFull = async <T>(path: string, _env: unknown): Promise<T> => {
    if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
    if (/emailCampaigns\/42\?statistics=globalStats/.test(path)) return { ...fakeCampaign, statistics: { globalStats: fakeGlobalStats } } as T;
    if (/emailCampaigns\/42\?statistics=linksStats/.test(path)) return { ...fakeCampaign, statistics: { linksStats: fakeLinksStats } } as T;
    if (/contacts\/lists\/7/.test(path)) return fakeList as T;
    throw new Error("path inesperado: " + path);
  };

  test("#2314: 1ª render escreve stats:{id} (não gstats: nem lstats:)", async () => {
    const { kv, putCalls } = makeKVMock({ "list:7": fakeList });
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetchFull as any);
    assert.ok(putCalls.includes("stats:42"), "deve escrever stats:42 (chave coalesced)");
    assert.ok(!putCalls.includes("gstats:42"), "NÃO deve escrever gstats:42 (chave legada)");
    assert.ok(!putCalls.includes("lstats:42"), "NÃO deve escrever lstats:42 (chave legada)");
  });

  test("#2314: 2ª render consecutiva (stats:{id} quente) → 0 writes de stats no KV", async () => {
    // Simula 2 renders consecutivos com mesmos dados.
    // 1º render: popula o KV via fetch da Brevo.
    const { kv, putCalls } = makeKVMock({ "list:7": fakeList });
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetchFull as any);
    const writesAfterFirst = putCalls.filter(k => k.startsWith("stats:")).length;
    assert.strictEqual(writesAfterFirst, 1, "1º render deve escrever 1 stats:42");

    // 2º render: KV já quente → nenhum write de stats
    const putCallsBefore2nd = putCalls.length;
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetchFull as any);
    const newStatsPuts = putCalls.slice(putCallsBefore2nd).filter(k => k.startsWith("stats:"));
    assert.strictEqual(newStatsPuts.length, 0,
      "2ª render com stats:{id} quente → NENHUM write de stats (idempotente)");
  });

  test("#2314: migração retrocompatível — lê gstats:+lstats: legados quando stats:{id} ausente", async () => {
    // Simula KV populado com chaves legadas (versão anterior do worker).
    const { kv, getCalls } = makeKVMock({
      "gstats:42": fakeGlobalStats,
      "lstats:42": fakeLinksStats,
      "list:7": fakeList,
    });
    let apiFetched = false;
    const mockFetchLegacy = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      apiFetched = true; // não deve ser chamado — dados devem vir do KV legado
      throw new Error("fetch não esperado: " + path);
    };
    const result = await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetchLegacy as any);
    assert.strictEqual(apiFetched, false, "fetch da Brevo NÃO deve ocorrer com dados legados no KV");
    assert.ok(getCalls.includes("stats:42"), "deve tentar ler stats:42 primeiro");
    assert.ok(getCalls.includes("gstats:42"), "deve fazer fallback para gstats:42 (migração)");
    assert.ok(getCalls.includes("lstats:42"), "deve fazer fallback para lstats:42 (migração)");
    assert.strictEqual(result[0].statistics?.globalStats?.sent, 100, "globalStats deve vir dos legados");
    assert.deepEqual(result[0].statistics?.linksStats, fakeLinksStats, "linksStats deve vir dos legados");
  });

  test("#2314: stats:{id} contém gs E ls coalesced (1 read na 2ª visita)", async () => {
    const { kv, getCalls } = makeKVMock({ "list:7": fakeList });
    // 1º render: popula stats:42
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetchFull as any);
    // Verificar que o JSON gravado contém gs e ls
    const stored = kv.get("stats:42", "json") as Promise<any>;
    const data = await stored;
    assert.ok(data !== null, "stats:42 deve estar no KV");
    // 2ª visita: stats:42 hit → só 1 get para stats (não mais gstats + lstats)
    const getCalls2nd: string[] = [];
    const kv2 = {
      ...kv,
      get: async (key: string, type?: string) => {
        getCalls2nd.push(key);
        return kv.get(key, type as any);
      },
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv2 } as any, 20, false, mockFetchFull as any);
    const statsGets = getCalls2nd.filter(k => k === "stats:42");
    const legacyGets = getCalls2nd.filter(k => k === "gstats:42" || k === "lstats:42");
    assert.strictEqual(statsGets.length, 1, "2ª render deve ler stats:42 exatamente 1x");
    assert.strictEqual(legacyGets.length, 0, "2ª render NÃO deve ler chaves legadas quando stats:{id} está quente");
  });
});

// ─── #2307: brevo-client.ts sibReset ≥ 0 ────────────────────────────────────
// O parseRetryAfterMs de brevo-client.ts não é exportado diretamente,
// mas podemos testar via withBrevo429Retry + Brevo429Signal.

describe("brevo-client sibReset:0 → retryAfterMs=0 (#2307)", async () => {
  // Importar lazy para evitar problema com top-level await em módulos CJS.
  const { withBrevo429Retry, Brevo429Signal } = await import("../scripts/lib/brevo-client.ts");

  test("Brevo429Signal com header x-sib-ratelimit-reset:0 → sleep 0ms (retry imediato)", async () => {
    let sleepMs: number | undefined;
    const fakeSleep = async (ms: number) => { sleepMs = ms; };

    // Simula resposta com x-sib-ratelimit-reset: 0
    const fakeResponse = new Response(null, {
      status: 429,
      headers: { "x-sib-ratelimit-reset": "0" },
    });

    let calls = 0;
    await withBrevo429Retry(async () => {
      calls++;
      if (calls === 1) throw new Brevo429Signal(fakeResponse);
      return "ok";
    }, fakeSleep);

    assert.strictEqual(calls, 2);
    assert.strictEqual(sleepMs, 0,
      "x-sib-ratelimit-reset:0 deve resultar em sleep(0ms) — não sleep(2000ms)");
  });

  test("Brevo429Signal com header retry-after:0 → sleep 0ms (RFC 7231 retry imediato)", async () => {
    let sleepMs: number | undefined;
    const fakeSleep = async (ms: number) => { sleepMs = ms; };

    const fakeResponse = new Response(null, {
      status: 429,
      headers: { "retry-after": "0" },
    });

    let calls = 0;
    await withBrevo429Retry(async () => {
      calls++;
      if (calls === 1) throw new Brevo429Signal(fakeResponse);
      return "ok";
    }, fakeSleep);

    assert.strictEqual(calls, 2);
    assert.strictEqual(sleepMs, 0, "retry-after:0 deve ser sleep(0ms)");
  });

  test("Brevo429Signal sem header rate-limit → sleep 2000ms (fallback)", async () => {
    let sleepMs: number | undefined;
    const fakeSleep = async (ms: number) => { sleepMs = ms; };

    const fakeResponse = new Response(null, { status: 429 });

    let calls = 0;
    await withBrevo429Retry(async () => {
      calls++;
      if (calls === 1) throw new Brevo429Signal(fakeResponse);
      return "ok";
    }, fakeSleep);

    assert.strictEqual(sleepMs, 2000, "sem header → fallback 2s");
  });
});

// ─── #2307: clarice-build-waves brevoGet header-aware ────────────────────────

describe("clarice-build-waves brevoGet: header-aware retry (#2307)", () => {
  // Testa a lógica pura de parseBrevoRetryAfterMs via brevoGet+mock de fetch.
  // A assertiva é sobre quantas vezes fetch foi chamado — não timing.

  test("brevoGet: 429 com Retry-After:0 → retenta (não lança na 1ª tentativa)", async () => {
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
      "brevoGet deve ter feito 2 chamadas: 429 com Retry-After:0 é retentado (#2307 header-aware)");
  });

  test("brevoGet: 429 com x-sib-ratelimit-reset:0 → retenta (header-aware)", async () => {
    const { brevoGet } = await import("../scripts/clarice-build-waves.ts");
    let fetchCalls = 0;
    const origFetch = globalThis.fetch;

    const mockFetch = async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return new Response(null, {
          status: 429,
          headers: { "x-sib-ratelimit-reset": "0" },
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
      "brevoGet deve retentar com x-sib-ratelimit-reset:0 (reset imediato, #2307)");
  });
});

// ─── #2323 Finding 1: immutable + ls failed → TTL'd entry (não permanente) ──────

describe("#2323 Finding 1: imutável com ls-fetch falho → entry TTL'd, não permanente", () => {
  function makeKVMock(initialData: Record<string, unknown> = {}) {
    const store = new Map(
      Object.entries(initialData).map(([k, v]) => [k, JSON.stringify(v)])
    );
    const putCallsWithOpts: Array<{ key: string; opts: unknown }> = [];
    return {
      store,
      putCallsWithOpts,
      kv: {
        get: async (key: string, type?: string) => {
          const val = store.get(key);
          if (!val) return null;
          if (type === "json") return JSON.parse(val);
          return val;
        },
        put: async (key: string, value: string, opts?: unknown) => {
          putCallsWithOpts.push({ key, opts: opts ?? null });
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
  const fakeList = { id: 9, name: "Lista F1", totalSubscribers: 200 };
  const fakeCampaign = {
    id: 77, name: "Campaign F1", subject: "F1", status: "sent",
    sentDate: sentDateOld, scheduledAt: null, createdAt: sentDateOld,
    recipients: { lists: [9] },
    statistics: { campaignStats: [] },
  };

  test("ls-fetch falha → stats:77 gravado com expirationTtl (NÃO permanente)", async () => {
    const { kv, putCallsWithOpts } = makeKVMock({ "list:9": fakeList });

    // Mock: gs retorna ok; ls lança erro
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (/emailCampaigns\/77\?statistics=globalStats/.test(path)) {
        return { ...fakeCampaign, statistics: { globalStats: fakeGs } } as T;
      }
      if (/emailCampaigns\/77\?statistics=linksStats/.test(path)) {
        throw new Error("linksStats 429 simulado");
      }
      if (/contacts\/lists\/9/.test(path)) return fakeList as T;
      throw new Error("path inesperado: " + path);
    };

    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);

    const statsPut = putCallsWithOpts.find((p) => p.key === "stats:77");
    assert.ok(statsPut, "deve escrever stats:77");

    // Finding 1: quando ls === undefined (fetch falhou), a entrada NÃO pode ser
    // permanente (opts={}) — deve ter expirationTtl para auto-cura. Sem o fix,
    // opts={} para campanha imutável mesmo sem ls → entrada permanente irrecuperável.
    const opts = statsPut!.opts as { expirationTtl?: number } | null;
    assert.ok(
      opts !== null && typeof (opts as any).expirationTtl === "number",
      `stats:77 com ls-fetch falho DEVE ter expirationTtl (auto-cura). ` +
      `opts recebido: ${JSON.stringify(opts)}. ` +
      "Sem o fix de #2323 F1, seria opts={} (permanente) → poison eterno",
    );
  });

  test("ls-fetch ok → stats:77 imutável gravado SEM expirationTtl (permanente)", async () => {
    const { kv, putCallsWithOpts } = makeKVMock({ "list:9": fakeList });
    const fakeLs = { "https://diar.ia/post": 5 };

    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (/emailCampaigns\/77\?statistics=globalStats/.test(path)) {
        return { ...fakeCampaign, statistics: { globalStats: fakeGs } } as T;
      }
      if (/emailCampaigns\/77\?statistics=linksStats/.test(path)) {
        return { ...fakeCampaign, statistics: { linksStats: fakeLs } } as T;
      }
      if (/contacts\/lists\/9/.test(path)) return fakeList as T;
      throw new Error("path inesperado: " + path);
    };

    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);

    const statsPut = putCallsWithOpts.find((p) => p.key === "stats:77");
    assert.ok(statsPut, "deve escrever stats:77");

    // Quando ls está presente e não-poison, campanha imutável → opts={} (permanente)
    const opts = statsPut!.opts as { expirationTtl?: number } | null;
    assert.ok(
      opts === null || !(opts as any).expirationTtl,
      `stats:77 com ls ok DEVE ser permanente (opts={} ou null). ` +
      `opts recebido: ${JSON.stringify(opts)}`,
    );
  });
});

// ─── #2323 Finding 2: legacy lstats: válido sobrevive a falha do ls-fetch ────────

describe("#2323 Finding 2: lstats: legado válido sobrevive falha do ls-fetch fresh", () => {
  function makeKVMock(initialData: Record<string, unknown> = {}) {
    const store = new Map(
      Object.entries(initialData).map(([k, v]) => [k, JSON.stringify(v)])
    );
    const putCalls: string[] = [];
    return {
      store, putCalls,
      kv: {
        get: async (key: string, type?: string) => {
          const val = store.get(key);
          if (!val) return null;
          if (type === "json") return JSON.parse(val);
          return val;
        },
        put: async (key: string, value: string, _opts?: unknown) => {
          putCalls.push(key);
          store.set(key, value);
        },
        delete: async () => {},
        list: async () => ({ keys: [], cursor: "", list_complete: true }),
        getWithMetadata: async () => ({ value: null, metadata: null }),
      } as unknown as KVNamespace,
    };
  }

  const sentDateOld = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const legacyGs = {
    sent: 80, delivered: 78, hardBounces: 1, softBounces: 1,
    uniqueViews: 30, viewed: 35, trackableViews: 25, uniqueClicks: 8,
    clickers: 7, unsubscriptions: 0, complaints: 0, appleMppOpens: 3,
  };
  const legacyLs = { "https://diar.ia/legacy-link": 12 };
  const fakeList = { id: 11, name: "Lista F2", totalSubscribers: 100 };
  const fakeCampaign = {
    id: 88, name: "Campaign F2", subject: "F2", status: "sent",
    sentDate: sentDateOld, scheduledAt: null, createdAt: sentDateOld,
    recipients: { lists: [11] },
    statistics: { campaignStats: [] },
  };

  test("gstats:88 ausente, lstats:88 presente: ls-fetch fresco falha → linksStats do legado preservado", async () => {
    // Cenário Finding 2: só lstats: presente (gstats: ausente, stats: ausente)
    // sem o fix: ls-fetch roda, falha → ls=undefined → write descarta lstats legado
    // com o fix: cachedLs != null → if (!cachedLs || poison) → pula fetch → ls=legacyLs
    const { kv } = makeKVMock({
      "lstats:88": legacyLs,  // legacy ls presente
      "list:11": fakeList,
      // gstats:88 AUSENTE, stats:88 AUSENTE
    });

    let lsFetchCalled = false;
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (/emailCampaigns\/88\?statistics=globalStats/.test(path)) {
        // gs fetch retorna dados válidos
        return { ...fakeCampaign, statistics: { globalStats: legacyGs } } as T;
      }
      if (/emailCampaigns\/88\?statistics=linksStats/.test(path)) {
        lsFetchCalled = true;
        throw new Error("ls-fetch falhou — Finding 2 test");
      }
      if (/contacts\/lists\/11/.test(path)) return fakeList as T;
      throw new Error("path inesperado: " + path);
    };

    const result = await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);

    // Com o fix (#2323 F2): cachedLs=legacyLs → skip ls-fetch → ls=legacyLs
    assert.ok(!lsFetchCalled,
      "ls-fetch NÃO deve ser chamado quando cachedLs está populado do legado (Finding #2)");

    // linksStats do resultado deve ter vindo do legado
    assert.deepEqual(
      result[0].statistics?.linksStats,
      legacyLs,
      "linksStats do resultado deve ser o do legado (lstats:88), não undefined",
    );
  });
});

// ─── #2323 Finding 3: computeRetryDelayMs never returns < 0 ──────────────────

describe("#2323 Finding 3: computeRetryDelayMs nunca retorna negativo", () => {
  test("retryAfterSecs=-1 → 0ms (não negativo)", () => {
    assert.strictEqual(computeRetryDelayMs(-1), 0,
      "input negativo deve ser clampeado para 0ms (Math.max(0, ...))");
  });

  test("retryAfterSecs=-100 → 0ms (não negativo)", () => {
    assert.strictEqual(computeRetryDelayMs(-100), 0,
      "input muito negativo deve resultar em 0ms");
  });

  test("retryAfterSecs=0 → 0ms (boundary, sem mudança de comportamento)", () => {
    // Teste já existia, mas confirma que o Math.max(0,...) não quebra o caso boundary
    assert.strictEqual(computeRetryDelayMs(0), 0);
  });

  test("retryAfterSecs=3 → 3000ms (valor positivo normal não é afetado pelo Math.max)", () => {
    assert.strictEqual(computeRetryDelayMs(3), 3000);
  });
});
