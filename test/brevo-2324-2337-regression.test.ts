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
  const { computeRetryDelayMs, BrevoRateLimitError, withRateLimitRetry, buildStaleResponse, brevoFetch } =
    await import("../workers/brevo-dashboard/src/index.ts");

  // ── brevoFetch header-parse direto (cobre o branch alterado, não só o downstream) ──

  async function captureBrevoFetchError(headers: Record<string, string>): Promise<InstanceType<typeof BrevoRateLimitError>> {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 429, headers })) as unknown as typeof globalThis.fetch;
    try {
      await brevoFetch("/v3/test", { BREVO_API_KEY: "k" } as any);
      throw new Error("brevoFetch deveria ter lançado BrevoRateLimitError");
    } catch (e) {
      if (e instanceof BrevoRateLimitError) return e;
      throw e;
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  test("brevoFetch: x-sib-ratelimit-reset epoch JÁ EXPIRADO → retryAfterSecs=0 (int) + floorMs=250", async () => {
    const pastEpoch = Math.floor(Date.now() / 1000) - 30; // 30s no passado
    const e = await captureBrevoFetchError({ "x-sib-ratelimit-reset": String(pastEpoch) });
    assert.strictEqual(e.retryAfterSecs, 0, "epoch expirado → retryAfterSecs 0 (inteiro p/ header)");
    assert.strictEqual(e.floorMs, 250, "epoch expirado → floorMs 250 (piso no backoff)");
  });

  test("brevoFetch: retry-after:0 literal → retryAfterSecs=0 + floorMs=0 (sem piso, RFC 7231)", async () => {
    const e = await captureBrevoFetchError({ "retry-after": "0" });
    assert.strictEqual(e.retryAfterSecs, 0, "retry-after:0 → retryAfterSecs 0");
    assert.strictEqual(e.floorMs, 0, "retry-after:0 literal NÃO recebe floor (retry imediato)");
  });

  test("brevoFetch: x-sib-ratelimit-reset epoch FUTURO → delta inteiro positivo, sem floor", async () => {
    const futureEpoch = Math.floor(Date.now() / 1000) + 10; // 10s futuro
    const e = await captureBrevoFetchError({ "x-sib-ratelimit-reset": String(futureEpoch) });
    assert.ok(e.retryAfterSecs !== null && e.retryAfterSecs >= 9 && e.retryAfterSecs <= 11,
      `epoch futuro → ~10s, foi ${e.retryAfterSecs}`);
    assert.strictEqual(e.floorMs, 0, "epoch futuro não recebe floor");
  });

  test("brevoFetch: x-sib-ratelimit-reset delta direto (256s) → 256, sem floor", async () => {
    const e = await captureBrevoFetchError({ "x-sib-ratelimit-reset": "256" });
    assert.strictEqual(e.retryAfterSecs, 256, "delta direto < 1e9 → valor cru");
    assert.strictEqual(e.floorMs, 0, "delta direto não recebe floor");
  });

  // O fix distingue, no backoff INTERNO, dois casos que ambos mapeiam a
  // retryAfterSecs=0: (a) `retry-after: 0` literal (RFC 7231 retry imediato → 0ms,
  // floorMs=0); (b) `x-sib-ratelimit-reset` epoch já expirado (janela esgotou →
  // floorMs=250 aplicado SÓ ao sleep). O header HTTP Retry-After permanece inteiro
  // (0s) em ambos — o piso fracionário nunca vaza pro header.

  test("computeRetryDelayMs(0) sem floor → 0ms (retry-after:0 literal, RFC 7231)", () => {
    assert.strictEqual(computeRetryDelayMs(0), 0,
      "literal retry-after:0 deve resultar em 0ms — RFC 7231 retry imediato, sem clamp inferior");
  });

  test("computeRetryDelayMs(0, 250) → 250ms (epoch-elapsed floor no backoff)", () => {
    assert.strictEqual(computeRetryDelayMs(0, 250), 250,
      "floor 250ms deve elevar o backoff de epoch-elapsed, mantendo retryAfterSecs=0");
  });

  test("computeRetryDelayMs floor não rebaixa um delay maior (3s vs floor 250ms)", () => {
    assert.strictEqual(computeRetryDelayMs(3, 250), 3000,
      "floor é um piso (Math.max), não um cap — 3s domina os 250ms");
  });

  test("BrevoRateLimitError.floorMs default = 0 (retry-after:0 literal não recebe piso)", () => {
    const e = new BrevoRateLimitError(0);
    assert.strictEqual(e.floorMs, 0, "default floorMs deve ser 0 (sem piso)");
    assert.strictEqual(e.retryAfterSecs, 0, "retryAfterSecs preservado");
  });

  test("BrevoRateLimitError(0, 250): retryAfterSecs INTEIRO 0 (header válido) + floorMs 250 (backoff)", () => {
    const e = new BrevoRateLimitError(0, 250);
    assert.strictEqual(e.retryAfterSecs, 0,
      "retryAfterSecs deve ser 0 inteiro — vai pro header HTTP Retry-After (RFC 7231 exige inteiro)");
    assert.strictEqual(e.floorMs, 250, "floorMs carrega o piso do backoff interno");
  });

  test("withRateLimitRetry: BrevoRateLimitError(0) (literal) → sleep(0ms)", async () => {
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

  test("withRateLimitRetry: BrevoRateLimitError(0, 250) (epoch-elapsed) → sleep(250ms)", async () => {
    let sleepMs: number | undefined;
    const fakeSleep = async (ms: number) => { sleepMs = ms; };
    let calls = 0;
    await withRateLimitRetry(async () => {
      calls++;
      if (calls === 1) throw new BrevoRateLimitError(0, 250); // epoch elapsed → floor
      return "ok";
    }, 3, fakeSleep);
    assert.strictEqual(sleepMs, 250,
      "epoch-elapsed (floorMs=250) deve resultar em sleep(250ms), não 0ms");
  });

  test("epoch-elapsed floor não regride para caso > 0 (ex: reset em 3s)", () => {
    assert.strictEqual(computeRetryDelayMs(3), 3000,
      "epoch futuro (3s) não deve ser afetado pelo floor de elapsed");
  });

  test("REGRESSÃO: header HTTP Retry-After de epoch-elapsed é inteiro (não 0.25)", () => {
    // O bug do design anterior: retryAfter=0.25 (fracionário) vazava para o header
    // Retry-After via buildStaleResponse/rateLimitResponse → "Retry-After: 0.25"
    // (inválido RFC 7231). Agora retryAfterSecs é sempre inteiro; o piso vive em floorMs.
    const e = new BrevoRateLimitError(0, 250); // epoch-elapsed como brevoFetch o constrói
    const resp = buildStaleResponse("<html><body>x</body></html>", e.retryAfterSecs);
    const header = resp.headers.get("Retry-After");
    assert.strictEqual(header, "0",
      "header Retry-After deve ser '0' (inteiro), nunca '0.25' (fracionário, inválido RFC 7231)");
    assert.ok(!header!.includes("."),
      "header Retry-After nunca deve conter ponto decimal");
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
    const result = await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, mockFetch as any,
    );
    assert.strictEqual(lsFetchCount.n, 1,
      "2ª render com lsPending:true → ls-fetch NÃO deve ser chamado (churn parado)");

    const newWrites = putCalls.slice(writesAfter1st).filter(p => p.key === "stats:99");
    assert.strictEqual(newWrites.length, 0,
      "2ª render com lsPending:true → NENHUM novo write de stats:99 (sem churn KV)");

    // gs DEVE continuar acessível no resultado (early-return ocorre APÓS globalStatsMap.set).
    const campaign = result.find((c: any) => c.id === 99);
    assert.ok(campaign?.statistics?.globalStats,
      "gs deve estar presente no resultado mesmo com lsPending (early-return preserva gs)");
    assert.strictEqual(campaign!.statistics!.globalStats!.sent, 100,
      "gs.sent deve refletir os dados cacheados (não zerado)");
    assert.ok(campaign?.statistics?.linksStats === undefined,
      "linksStats ausente do resultado (ls-fetch falhou, lsPending suprime re-fetch)");
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
