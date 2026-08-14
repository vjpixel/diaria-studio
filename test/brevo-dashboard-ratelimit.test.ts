/**
 * test/brevo-dashboard-ratelimit.test.ts (#2144)
 *
 * Testes de regressão para o fix de rate-limit da Brevo:
 *  - mapLimit: concorrência máxima ≤ n, ordem preservada
 *  - isImmutableCampaign: boundary 7d (clock mockado)
 *  - KV hit → fetchFn não é chamada (imutável)
 *  - KV erro → fallback para fetch Brevo (nunca bloqueia)
 *  - listing 429 → resposta 503 amigável com Retry-After
 *
 * Todos os helpers são funções puras exportadas de workers/brevo-dashboard/src/index.ts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mapLimit,
  isImmutableCampaign,
  BrevoRateLimitError,
  fetchRecentCampaigns,
  fetchScheduledCampaigns,
  withRateLimitRetry,
  injectStaleBanner,
  buildStaleResponse,
  RECENT_STATS_TTL,
  // #5215/#5218/#5219
  computeRateLimitResetAt,
  rateLimitResponse,
  injectUpstreamErrorBanner,
  fmtClockBRT,
  parseRateLimitRemaining,
  shouldWarnLowRateLimitRemaining,
  buildRefreshPendingRecord,
  isRefreshPendingDue,
  readRefreshPending,
  writeRefreshPending,
  clearRefreshPending,
  REFRESH_PENDING_KV_KEY,
} from "../workers/brevo-dashboard/src/index.ts";

// ─── mapLimit ────────────────────────────────────────────────────────────────

describe("mapLimit", () => {
  test("preserva ordem do resultado independente de timing", async () => {
    // Items com delays invertidos: item 0 demora 20ms, item 1 demora 10ms.
    // Com Promise.all puro, o resultado ainda seria ordenado — aqui garantimos
    // o mesmo comportamento com concorrência limitada.
    const delays = [20, 10, 15, 5];
    const result = await mapLimit(delays, 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    assert.deepStrictEqual(result, delays, "resultado deve ser na mesma ordem do input");
  });

  test("concorrência máxima observada nunca ultrapassa n", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (item) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      return item;
    });

    assert.ok(
      maxConcurrent <= 3,
      `concorrência máxima deve ser ≤ 3, foi ${maxConcurrent}`,
    );
  });

  test("funciona com array vazio", async () => {
    const result = await mapLimit([], 5, async (x: number) => x * 2);
    assert.deepStrictEqual(result, []);
  });

  test("funciona com n maior que o array", async () => {
    const result = await mapLimit([1, 2], 10, async (x) => x * 2);
    assert.deepStrictEqual(result, [2, 4]);
  });

  test("propaga erros do fn (não silencia)", async () => {
    await assert.rejects(
      () => mapLimit([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("erro intencional");
        return x;
      }),
      /erro intencional/,
    );
  });
});

// ─── isImmutableCampaign ─────────────────────────────────────────────────────

describe("isImmutableCampaign", () => {
  const sevenDaysMs = 7 * 24 * 3600 * 1000;

  test("campanha com sentDate > 7d atrás → imutável", () => {
    const now = Date.now();
    const sentDate = new Date(now - sevenDaysMs - 1).toISOString();
    assert.strictEqual(isImmutableCampaign(sentDate, now), true);
  });

  test("campanha com sentDate exatamente 7d atrás → NÃO imutável (boundary exclusivo)", () => {
    const now = Date.now();
    const sentDate = new Date(now - sevenDaysMs).toISOString();
    assert.strictEqual(isImmutableCampaign(sentDate, now), false);
  });

  test("campanha com sentDate < 7d atrás → NÃO imutável", () => {
    const now = Date.now();
    const sentDate = new Date(now - sevenDaysMs + 1000).toISOString();
    assert.strictEqual(isImmutableCampaign(sentDate, now), false);
  });

  test("sentDate null → NÃO imutável (campanha sem data de envio)", () => {
    assert.strictEqual(isImmutableCampaign(null), false);
  });

  test("sentDate inválida → NÃO imutável (defensivo)", () => {
    assert.strictEqual(isImmutableCampaign("not-a-date"), false);
  });

  test("campanha de 30 dias atrás → imutável", () => {
    const now = Date.now();
    const sentDate = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
    assert.strictEqual(isImmutableCampaign(sentDate, now), true);
  });
});

// ─── BrevoRateLimitError ─────────────────────────────────────────────────────

describe("BrevoRateLimitError", () => {
  test("carrega retryAfterSecs corretamente", () => {
    const err = new BrevoRateLimitError(42);
    assert.strictEqual(err.retryAfterSecs, 42);
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, "BrevoRateLimitError");
    assert.ok(err.message.includes("42"));
  });

  test("aceita retryAfterSecs null (header ausente)", () => {
    const err = new BrevoRateLimitError(null);
    assert.strictEqual(err.retryAfterSecs, null);
    assert.ok(err.message.includes("?"));
  });
});

// ─── KV cache: hit → fetchFn não chamada, erro → fallback ───────────────────
//
// Testamos a lógica de KV diretamente em unidade via simulação do comportamento
// que fetchRecentCampaigns exerce. O fluxo de KV no worker é:
//   imutável + KV hit → retorna cached, não chama Brevo
//   imutável + KV miss → chama Brevo, grava KV
//   KV erro → fallback para fetch Brevo (nunca lança)
//
// Como fetchRecentCampaigns é async e depende de `env` com KV + BREVO_API_KEY,
// testamos a lógica de KV isolando a decisão de imutabilidade + a lógica de
// cache-aside, que é o que pode regredir. O integration path (resposta 503) é
// coberto pelo teste de BrevoRateLimitError acima.

describe("lógica de KV cache (simulação)", () => {
  test("KV hit → fetchFn não é chamada", async () => {
    let fetchCalled = false;

    // Simula a lógica de cache-aside do fetchRecentCampaigns
    async function fetchWithKV(
      kvStore: Map<string, string>,
      key: string,
      isImmutable: boolean,
      fetchFn: () => Promise<string>,
    ): Promise<string> {
      if (isImmutable) {
        const cached = kvStore.get(key);
        if (cached) return cached;
      }
      const result = await fetchFn();
      if (isImmutable) kvStore.set(key, result);
      return result;
    }

    const kv = new Map<string, string>();
    kv.set("gstats:42", JSON.stringify({ sent: 100 }));

    const result = await fetchWithKV(kv, "gstats:42", true, async () => {
      fetchCalled = true;
      return JSON.stringify({ sent: 999 });
    });

    assert.strictEqual(fetchCalled, false, "fetchFn não deve ser chamada quando KV tem hit");
    assert.ok(result.includes("100"), "deve retornar o valor do KV");
  });

  test("KV miss → fetchFn é chamada e resultado é gravado no KV", async () => {
    let fetchCalled = false;

    async function fetchWithKV(
      kvStore: Map<string, string>,
      key: string,
      isImmutable: boolean,
      fetchFn: () => Promise<string>,
    ): Promise<string> {
      if (isImmutable) {
        const cached = kvStore.get(key);
        if (cached) return cached;
      }
      const result = await fetchFn();
      if (isImmutable) kvStore.set(key, result);
      return result;
    }

    const kv = new Map<string, string>();

    const result = await fetchWithKV(kv, "gstats:42", true, async () => {
      fetchCalled = true;
      return JSON.stringify({ sent: 100 });
    });

    assert.strictEqual(fetchCalled, true, "fetchFn deve ser chamada em cache miss");
    assert.ok(result.includes("100"), "deve retornar o valor do fetch");
    assert.ok(kv.has("gstats:42"), "deve gravar no KV após cache miss");
  });

  test("KV erro → fallback para fetch Brevo (nunca lança)", async () => {
    let fetchCalled = false;

    async function fetchWithKVFallback(
      isImmutable: boolean,
      fetchFn: () => Promise<string>,
    ): Promise<string | null> {
      if (isImmutable) {
        try {
          // Simula KV.get() que lança
          await Promise.reject(new Error("KV indisponível"));
        } catch {
          // KV erro → segue para fetch (nunca bloqueia)
        }
      }
      try {
        const result = await fetchFn();
        return result;
      } catch {
        return null;
      }
    }

    const result = await fetchWithKVFallback(true, async () => {
      fetchCalled = true;
      return JSON.stringify({ sent: 100 });
    });

    assert.strictEqual(fetchCalled, true, "fetchFn deve ser chamada mesmo com KV erro");
    assert.ok(result?.includes("100"), "deve retornar o resultado do fetch como fallback");
  });

  test("campanha recente (não imutável) → KV nunca consultado", async () => {
    let kvAccessed = false;

    async function fetchWithKV(
      kvStore: { get: (k: string) => string | undefined },
      key: string,
      isImmutable: boolean,
      fetchFn: () => Promise<string>,
    ): Promise<string> {
      if (isImmutable) {
        kvAccessed = true; // só seria true se isImmutable=true
        const cached = kvStore.get(key);
        if (cached) return cached;
      }
      return fetchFn();
    }

    const kv = { get: (_k: string) => undefined };
    await fetchWithKV(kv, "gstats:99", false /* não imutável */, async () => "data");

    assert.strictEqual(kvAccessed, false, "KV não deve ser acessado para campanhas recentes");
  });
});

// --- Integration: fetchRecentCampaigns com KV mock + fetchFn mock (#2146 finding #9) --------
//
// Exercita o caminho real de fetchRecentCampaigns (nao uma simulacao) com:
//   - mock KVNamespace que registra gets e puts
//   - mock _fetchFn que retorna dados canned
// Verifica que KV hit evita chamada ao Brevo, que KV miss persiste, e que
// isFresh=true bypassa o KV.

describe("fetchRecentCampaigns (integration com KV mock)", () => {
  function makeKVMock(initialData: Record<string, string> = {}) {
    const store = new Map(Object.entries(initialData));
    const getCalls: string[] = [];
    const putCalls: string[] = [];
    const putOpts: Record<string, unknown> = {}; // #2270: captura options (TTL) por key
    return {
      store, getCalls, putCalls, putOpts,
      kv: {
        get: async (key: string, type?: string) => {
          getCalls.push(key);
          const val = store.get(key);
          if (!val) return null;
          if (type === "json") return JSON.parse(val);
          return val;
        },
        put: async (key: string, value: string, opts?: unknown) => {
          putCalls.push(key);
          putOpts[key] = opts;
          store.set(key, value);
        },
        delete: async () => {},
        list: async () => ({ keys: [], cursor: "", list_complete: true }),
        getWithMetadata: async () => ({ value: null, metadata: null }),
      } as unknown as KVNamespace,
    };
  }

  const sentDateOld = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const fakeList = { id: 7, name: "Lista Teste", totalSubscribers: 500 };
  const fakeGlobalStats = {
    sent: 100, delivered: 95, hardBounces: 2, softBounces: 1,
    uniqueViews: 40, viewed: 45, trackableViews: 35, uniqueClicks: 10,
    clickers: 9, unsubscriptions: 1, complaints: 0, appleMppOpens: 5,
  };
  const fakeCampaign = {
    id: 42, name: "Test Campaign", subject: "Hello", status: "sent",
    sentDate: sentDateOld, scheduledAt: null, createdAt: sentDateOld,
    recipients: { lists: [7] },
    statistics: { campaignStats: [{ listId: 7, sent: 100, delivered: 95, hardBounces: 2,
      softBounces: 1, deferred: 0, uniqueViews: 40, viewed: 45, trackableViews: 35,
      uniqueClicks: 10, clickers: 9, unsubscriptions: 1, complaints: 0 }] },
  };

  test("KV hit de gstats+lstats imutavel evita chamada ao _fetchFn por campanha", async () => {
    // Regressão #2183: apenas quando AMBOS gstats e lstats estão em cache o fetch é pulado.
    // #2314: chave unificada `stats:{id}` — hit nesta chave evita o fetch.
    const fakeLinksStats = { "https://diar.ia/edicao/test": 5 };
    const { kv, getCalls } = makeKVMock({
      // #2314: chave unificada (nova) — quando presente, é suficiente para o hit.
      "stats:42": JSON.stringify({ gs: fakeGlobalStats, ls: fakeLinksStats }),
      "list:7": JSON.stringify(fakeList),
    });
    let detailCalled = false;
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (path.includes("emailCampaigns/42")) { detailCalled = true; throw new Error("nao devia chamar"); }
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    assert.strictEqual(detailCalled, false, "fetchFn NAO deve ser chamado com KV hit de stats:{id}");
    assert.ok(getCalls.includes("stats:42"), "KV.get deve ter sido chamado para stats:42 (chave unificada)");
    assert.strictEqual(result[0].statistics?.globalStats?.sent, 100, "sent deve vir do KV");
  });

  test("regressão #2183: gstats em cache (legado) mas lstats ausente → fetchFn DEVE ser chamada", async () => {
    // Bug: `if (cachedGs) return` pulava fetch mesmo sem lstats, impedindo campanhas
    // pré-#2177 (que só têm gstats no KV) de receber dados de links.
    // #2314: com chave unificada stats:{id} ausente E gstats:42 presente (legado),
    // o código faz fallback para os legados. Como gstats está mas lstats não está
    // (nem no legado), o fetch DEVE ocorrer para buscar linksStats.
    const { kv, getCalls, putCalls } = makeKVMock({
      "gstats:42": JSON.stringify(fakeGlobalStats),
      "list:7": JSON.stringify(fakeList),
      // lstats:42 ausente propositalmente — simula campanha pré-#2177 sem lstats
      // stats:42 também ausente — cai no fallback legado
    });
    let detailCalled = false;
    const fakeLinksStats = { "https://diar.ia/edicao/test": 10 };
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (path.includes("emailCampaigns/42")) {
        detailCalled = true;
        return { ...fakeCampaign, statistics: { globalStats: fakeGlobalStats, linksStats: fakeLinksStats } } as T;
      }
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    assert.strictEqual(detailCalled, true,
      "fetchFn DEVE ser chamada quando gstats legado está em cache mas lstats está ausente (bug #2183)");
    assert.ok(getCalls.includes("gstats:42"), "KV.get deve ter lido gstats:42 (fallback legado)");
    assert.ok(getCalls.includes("lstats:42"), "KV.get deve ter tentado lstats:42 (fallback legado)");
    // Após fetch, deve gravar na chave UNIFICADA (não mais nas legadas separadas)
    assert.ok(putCalls.includes("stats:42"), "KV.put deve persistir na chave unificada stats:42 (#2314)");
    // linksStats deve estar disponível em statistics.linksStats (fonte única, #2199.3)
    assert.ok(result[0].statistics?.linksStats !== undefined, "linksStats deve estar presente em result[0].statistics.linksStats");
  });

  test("KV miss de stats:{id} chama _fetchFn e persiste no KV (chave unificada)", async () => {
    // #2314: em vez de gstats:42 + lstats:42, persiste stats:42 (1 write).
    const { kv, putCalls } = makeKVMock({ "list:7": JSON.stringify(fakeList) });
    let detailCalled = false;
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (path.includes("emailCampaigns/42")) {
        detailCalled = true;
        return { ...fakeCampaign, statistics: { globalStats: fakeGlobalStats } } as T;
      }
      throw new Error("path inesperado: " + path);
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    assert.strictEqual(detailCalled, true, "fetchFn DEVE ser chamado em KV miss");
    assert.ok(putCalls.includes("stats:42"), "KV.put deve persistir stats:42 (chave unificada, #2314)");
    assert.ok(!putCalls.includes("gstats:42"), "NÃO deve persistir na chave legada gstats:42");
  });

  test("isFresh=true bypassa KV e chama _fetchFn mesmo com KV populado", async () => {
    const { kv } = makeKVMock({
      "gstats:42": JSON.stringify({ ...fakeGlobalStats, sent: 999 }),
      "list:7": JSON.stringify(fakeList),
    });
    let detailCalled = false;
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (path.includes("emailCampaigns/42")) { detailCalled = true; return { ...fakeCampaign, statistics: { globalStats: fakeGlobalStats } } as T; }
      if (path.includes("contacts/lists/7")) return fakeList as T;
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, true, mockFetch as any);
    assert.strictEqual(detailCalled, true, "fetchFn DEVE ser chamado com isFresh=true mesmo com KV hit");
    assert.strictEqual(result[0].statistics?.globalStats?.sent, 100, "sent deve vir da Brevo (100), nao do KV (999)");
  });

  test("gstats zerado (sent=0) nao e persistido no KV", async () => {
    // #2314: a guarda gs.sent>0 se aplica à chave unificada stats:{id} também.
    const { kv, putCalls } = makeKVMock({ "list:7": JSON.stringify(fakeList) });
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (path.includes("emailCampaigns/42")) {
        return { ...fakeCampaign, statistics: { globalStats: { ...fakeGlobalStats, sent: 0 } } } as T;
      }
      throw new Error("path inesperado: " + path);
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    assert.strictEqual(putCalls.includes("stats:42"), false,
      "KV.put NAO deve ser chamado para gstats zerado (evita envenenamento permanente) — chave unificada stats:{id}");
    assert.strictEqual(putCalls.includes("gstats:42"), false,
      "KV.put NAO deve ser chamado na chave legada gstats:42 (não é mais gravada)");
  });

  test("#2249: linksStats é buscado via param ÚNICO (?statistics=linksStats), não combinado", async () => {
    // Bug Brevo (verificado 2026-06-14): `?statistics=globalStats,linksStats`
    // retorna linksStats ZERADO; `?statistics=linksStats` retorna clicks reais.
    // O mock emula isso: combinado → todos 0; single → reais. Se o worker pedisse
    // o combinado, linksStats viria zerado e a seção de links agregados ficaria vazia.
    const { kv } = makeKVMock({ "list:7": JSON.stringify(fakeList) });
    const realLinks = { "https://diar.ia.br/post-x": 8, "https://exame.com/y": 3 };
    const requested: string[] = [];
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      requested.push(path);
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (path.includes("emailCampaigns/42")) {
        if (/statistics=globalStats,linksStats/.test(path)) {
          // combinado: Brevo zera os links
          return { ...fakeCampaign, statistics: { globalStats: fakeGlobalStats, linksStats: { "https://diar.ia.br/post-x": 0, "https://exame.com/y": 0 } } } as T;
        }
        if (/statistics=linksStats/.test(path)) {
          return { ...fakeCampaign, statistics: { linksStats: realLinks } } as T;
        }
        if (/statistics=globalStats/.test(path)) {
          return { ...fakeCampaign, statistics: { globalStats: fakeGlobalStats } } as T;
        }
      }
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, true, mockFetch as any);
    // Nunca deve pedir o combinado (que zeraria os links)
    assert.ok(!requested.some((p) => /statistics=globalStats,linksStats/.test(p)),
      "NÃO deve usar o param combinado globalStats,linksStats");
    assert.ok(requested.some((p) => /emailCampaigns\/42\?statistics=linksStats/.test(p)),
      "DEVE buscar linksStats via param único");
    // linksStats no resultado deve ter os clicks REAIS (não zerados)
    assert.deepEqual(result[0].statistics?.linksStats, realLinks,
      "linksStats deve conter os clicks reais do GET single, não os zeros do combinado");
  });

  test("#2249: 429 no GET de linksStats NÃO descarta o globalStats já obtido", async () => {
    // Regressão da divisão em 2 GETs: se o 2º GET (linksStats) lança, o
    // globalStats do 1º GET tem que persistir mesmo assim (try/catch próprio).
    const { kv } = makeKVMock({ "list:7": JSON.stringify(fakeList) });
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (/emailCampaigns\/42\?statistics=globalStats$/.test(path)) {
        return { ...fakeCampaign, statistics: { globalStats: fakeGlobalStats } } as T;
      }
      if (/emailCampaigns\/42\?statistics=linksStats/.test(path)) {
        throw new Error("429"); // linksStats indisponível
      }
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, true, mockFetch as any);
    assert.strictEqual(result[0].statistics?.globalStats?.sent, 100,
      "globalStats deve persistir mesmo com 429 no GET de linksStats");
    assert.strictEqual(result[0].statistics?.linksStats, undefined,
      "linksStats fica undefined quando seu GET falha (degrada graceful)");
  });

  // #2270: campanha RECENTE (<7d) agora é cacheada com TTL curto → 2º render
  // bate no KV (0 GETs à Brevo). Antes só imutáveis eram cacheadas → todo render
  // fresco fazia 2 GETs/campanha → 503/flicker por rate-limit.
  const sentDateRecent = new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString(); // 1d atrás
  const recentCampaign = { ...fakeCampaign, id: 77, sentDate: sentDateRecent, createdAt: sentDateRecent };

  test("#2270/#2314: campanha recente é cacheada com TTL (expirationTtl) na chave unificada stats:{id}", async () => {
    // #2314: chave coalesced stats:{id} substitui gstats:+lstats: separados.
    // #2282: TTL é RECENT_STATS_TTL (agora 1800s), não hardcoded 300.
    const { kv, putOpts, putCalls } = makeKVMock({ "list:7": JSON.stringify(fakeList) });
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [recentCampaign] } as T;
      if (/emailCampaigns\/77\?statistics=globalStats/.test(path)) return { ...recentCampaign, statistics: { globalStats: fakeGlobalStats } } as T;
      if (/emailCampaigns\/77\?statistics=linksStats/.test(path)) return { ...recentCampaign, statistics: { linksStats: { "https://x.com/a": 3 } } } as T;
      throw new Error("path inesperado: " + path);
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    assert.ok(putCalls.includes("stats:77"), "deve cachear stats:77 (chave unificada, #2314)");
    assert.ok(!putCalls.includes("gstats:77"), "NÃO deve cachear na chave legada gstats:77");
    assert.ok(!putCalls.includes("lstats:77"), "NÃO deve cachear na chave legada lstats:77");
    assert.equal((putOpts["stats:77"] as any)?.expirationTtl, RECENT_STATS_TTL, `stats:{id} recente com TTL ${RECENT_STATS_TTL}s`);
  });

  test("#2270: imutável continua sem TTL (cache permanente)", async () => {
    const { kv, putOpts } = makeKVMock({ "list:7": JSON.stringify(fakeList) });
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T; // sentDateOld = imutável
      if (/emailCampaigns\/42\?statistics=globalStats/.test(path)) return { ...fakeCampaign, statistics: { globalStats: fakeGlobalStats } } as T;
      if (/emailCampaigns\/42\?statistics=linksStats/.test(path)) return { ...fakeCampaign, statistics: { linksStats: {} } } as T;
      throw new Error("path inesperado: " + path);
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    // #2314: chave unificada stats:{id}. Imutável sem TTL → options objeto vazio {}.
    assert.deepEqual(putOpts["stats:42"], {}, "stats:{id} imutável SEM expirationTtl (#2314 coalesce)");
  });

  test("#2270: 2º render de campanha recente cacheada → 0 GETs de stats à Brevo", async () => {
    const { kv } = makeKVMock({
      "list:7": JSON.stringify(fakeList),
      "gstats:77": JSON.stringify(fakeGlobalStats),
      "lstats:77": JSON.stringify({ "https://x.com/a": 3 }),
    });
    let statGets = 0;
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [recentCampaign] } as T;
      if (/emailCampaigns\/77\?statistics=/.test(path)) { statGets++; return { ...recentCampaign, statistics: { globalStats: fakeGlobalStats } } as T; }
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    assert.equal(statGets, 0, "recente cacheada (gs+ls) → NENHUM GET de stats à Brevo no 2º render");
    assert.equal(result[0].statistics?.globalStats?.sent, fakeGlobalStats.sent);
  });
});

// ─── #2268: resiliência da seção de campanhas agendadas ──────────────────────

describe("withRateLimitRetry (#2268)", () => {
  const noSleep = async () => {};

  test("retenta em BrevoRateLimitError e sucede na 2ª tentativa", async () => {
    let calls = 0;
    const out = await withRateLimitRetry(async () => {
      calls++;
      if (calls === 1) throw new BrevoRateLimitError(1);
      return "ok";
    }, 3, noSleep);
    assert.strictEqual(out, "ok");
    assert.strictEqual(calls, 2, "1 falha + 1 sucesso");
  });

  test("propaga após esgotar as tentativas (sempre 429)", async () => {
    let calls = 0;
    await assert.rejects(
      () => withRateLimitRetry(async () => { calls++; throw new BrevoRateLimitError(1); }, 3, noSleep),
      (e: unknown) => e instanceof BrevoRateLimitError,
    );
    assert.strictEqual(calls, 3, "tenta `attempts` vezes");
  });

  test("NÃO retenta erro que não é rate-limit (propaga na hora)", async () => {
    let calls = 0;
    await assert.rejects(
      () => withRateLimitRetry(async () => { calls++; throw new Error("boom"); }, 3, noSleep),
      /boom/,
    );
    assert.strictEqual(calls, 1, "erro não-429 não retenta");
  });
});

describe("fetchScheduledCampaigns retenta a listagem em 429 (#2268)", () => {
  test("429 na 1ª chamada da listagem queued → retry → retorna as campanhas", async () => {
    let listCalls = 0;
    const queued = {
      id: 57, name: "Clarice News 2605 d07-B (ter)", subject: "s", status: "queued",
      sentDate: null, scheduledAt: "2026-06-16T09:05:00Z", createdAt: "x", recipients: { lists: [56] },
    };
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=queued")) {
        listCalls++;
        if (listCalls === 1) throw new BrevoRateLimitError(1); // 1º 429
        return { campaigns: [queued] } as T;
      }
      if (path.includes("contacts/lists/")) throw new Error("404"); // sem nome de lista — tolerado
      throw new Error("path inesperado: " + path);
    };
    // sem KV (env mínimo) — força fetch da lista (que 404a, tolerado no try/catch interno)
    const result = await fetchScheduledCampaigns({ BREVO_API_KEY: "t" } as any, 50, true, mockFetch as any);
    assert.strictEqual(listCalls, 2, "listagem retentada após 429");
    assert.strictEqual(result.length, 1, "retorna a campanha agendada após o retry");
    assert.strictEqual(result[0].id, 57);
  });
});

describe("fetchRecentCampaigns retenta a listagem em 429 (#2280)", () => {
  test("429 na 1ª listagem sent → retry → não derruba a página", async () => {
    // Regressão #2280: antes, um único 429 na listagem fazia fetchRecentCampaigns
    // lançar → rota / retornava 503. Agora a listagem é re-tentada (withRateLimitRetry).
    const sentDateOld = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const fakeCampaign = {
      id: 42, name: "Test", subject: "s", status: "sent",
      sentDate: sentDateOld, scheduledAt: null, createdAt: sentDateOld, recipients: { lists: [7] },
    };
    let listCalls = 0;
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) {
        listCalls++;
        if (listCalls === 1) throw new BrevoRateLimitError(1); // 1º 429 transitório
        return { campaigns: [fakeCampaign] } as T;
      }
      throw new Error("path inesperado (KV deveria cobrir stats): " + path);
    };
    // KV cobre stats da campanha → só a listagem passa pelo _fetchFn.
    // Mock fiel: honra o 2º arg "json" (produção chama .get(key, "json") → objeto
    // parseado; sem "json" → string), pra não mascarar bugs de tipo no consumidor.
    const data: Record<string, unknown> = {
      "gstats:42": { sent: 100, delivered: 95 },
      "lstats:42": { "https://diar.ia/x": 3 },
      "list:7": { id: 7, name: "L", totalSubscribers: 100 },
    };
    const kv = {
      get: async (k: string, type?: string) => {
        if (!(k in data)) return null;
        return type === "json" ? data[k] : JSON.stringify(data[k]);
      },
      put: async () => {},
    };
    const result = await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 50, false, mockFetch as any);
    assert.strictEqual(listCalls, 2, "listagem sent retentada após 429");
    assert.strictEqual(result.length, 1, "retorna campanhas após retry (não lança → não vira 503)");
  });
});

describe("injectStaleBanner — fallback último render bom (#2280, horário BRT #5218)", () => {
  // Instante fixo pra determinismo: 2026-08-14T14:00:00Z (11:00 BRT, UTC-3).
  const NOW_MS = Date.parse("2026-08-14T14:00:00.000Z");

  test("insere banner logo após <body> preservando o resto", () => {
    const html = `<!DOCTYPE html><html><body class="x"><h1>Dash</h1></body></html>`;
    const out = injectStaleBanner(html, 120, NOW_MS); // 120s → 11:02 BRT
    assert.ok(out.includes("rate-limit"), "banner presente");
    assert.ok(out.includes("11:02"), "mostra o horário de relógio BRT, não o delta");
    assert.ok(!out.includes("~120s"), "não mostra mais o delta relativo (#5218)");
    assert.ok(/<body class="x">.*rate-limit/s.test(out), "banner vem logo após <body>");
    assert.ok(out.includes("<h1>Dash</h1>"), "conteúdo original preservado");
  });

  test("retryAfter null → mensagem genérica, sem CTA de fila", () => {
    const out = injectStaleBanner("<body></body>", null, NOW_MS);
    assert.ok(out.includes("alguns minutos"), "fallback de mensagem sem retry-after");
    assert.ok(!out.includes("queueRefresh"), "sem ETA conhecida não há horário-alvo pra enfileirar");
  });

  test("sem <body> → prepend (nunca perde o conteúdo)", () => {
    const out = injectStaleBanner("<div>conteudo</div>", 60, NOW_MS);
    assert.ok(out.startsWith("<div style="), "banner prepended quando não há <body>");
    assert.ok(out.includes("<div>conteudo</div>"), "conteúdo original preservado");
  });

  test("com retryAfter conhecido, inclui CTA 'Avisar quando atualizar' com resetAt correto", () => {
    const out = injectStaleBanner("<body></body>", 300, NOW_MS); // 300s → NOW_MS + 300000
    const expectedResetAt = NOW_MS + 300_000;
    assert.ok(out.includes("Avisar quando atualizar"), "CTA da fila presente");
    assert.ok(out.includes(`queueRefresh=1&amp;resetAt=${expectedResetAt}`), "link carrega o resetAt calculado");
  });

  test("buildStaleResponse: 200 + banner + X-Dashboard-Stale + Retry-After", async () => {
    // Regressão da ROTA: em 429 com lastGood no KV, a resposta é 200 (não 503),
    // com banner, marcador de staleness pra monitoria, e Retry-After.
    const resp = buildStaleResponse(`<!DOCTYPE html><html><body><h1>D</h1></body></html>`, 90, NOW_MS);
    assert.strictEqual(resp.status, 200, "fallback é 200, não 503");
    assert.strictEqual(resp.headers.get("X-Dashboard-Stale"), "rate-limit", "marcador p/ monitoria");
    assert.strictEqual(resp.headers.get("Retry-After"), "90");
    assert.strictEqual(resp.headers.get("Cache-Control"), "no-store", "não cacheia o stale");
    const body = await resp.text();
    assert.ok(body.includes("rate-limit") && body.includes("<h1>D</h1>"), "banner + conteúdo");
  });

  test("buildStaleResponse: sem retryAfter → sem header Retry-After", () => {
    const resp = buildStaleResponse("<body></body>", null, NOW_MS);
    assert.strictEqual(resp.headers.get("Retry-After"), null);
    assert.strictEqual(resp.status, 200);
  });
});

describe("rateLimitResponse — horário de relógio BRT (#5218)", () => {
  const NOW_MS = Date.parse("2026-08-14T14:00:00.000Z"); // 11:00 BRT

  test("HTML: mostra horário de relógio, não delta relativo", async () => {
    const resp = rateLimitResponse(120, true, NOW_MS); // → 11:02 BRT
    const body = await resp.text();
    assert.ok(body.includes("11:02"), "mostra o horário BRT");
    assert.ok(!body.includes("120s"), "não mostra mais o delta em segundos no corpo HTML");
    assert.strictEqual(resp.status, 503);
    assert.strictEqual(resp.headers.get("Retry-After"), "120", "header HTTP continua em segundos (RFC 7231)");
  });

  test("JSON: retryAfterSecs continua numérico (não vira string de horário)", async () => {
    const resp = rateLimitResponse(120, false, NOW_MS);
    const body = await resp.json() as { retryAfterSecs: number };
    assert.strictEqual(body.retryAfterSecs, 120, "corpo JSON não muda de forma — só a mensagem do HTML");
  });

  test("retryAfterSecs null → mensagem genérica", async () => {
    const resp = rateLimitResponse(null, true, NOW_MS);
    const body = await resp.text();
    assert.ok(body.includes("alguns minutos"));
  });
});

describe("computeRateLimitResetAt (#5218)", () => {
  const NOW_MS = Date.parse("2026-08-14T14:00:00.000Z"); // 11:00 BRT

  test("retryAfterSecs conhecido → resetAtMs e clockBRT corretos", () => {
    const out = computeRateLimitResetAt(90, NOW_MS); // +90s = 11:01:30 → arredonda pra 11:01
    assert.ok(out != null);
    assert.strictEqual(out!.resetAtMs, NOW_MS + 90_000);
    assert.strictEqual(out!.clockBRT, "11:01");
  });

  test("retryAfterSecs null → null (sem ETA)", () => {
    assert.strictEqual(computeRateLimitResetAt(null, NOW_MS), null);
  });

  test("retryAfterSecs 0 → resetAt é o próprio instante atual", () => {
    const out = computeRateLimitResetAt(0, NOW_MS);
    assert.strictEqual(out!.resetAtMs, NOW_MS);
  });
});

describe("fmtClockBRT (#5218)", () => {
  test("formata só HH:MM, sem data", () => {
    const ms = Date.parse("2026-08-14T14:37:00.000Z"); // 11:37 BRT
    assert.strictEqual(fmtClockBRT(ms), "11:37");
  });

  test("epoch inválido → travessão", () => {
    assert.strictEqual(fmtClockBRT(NaN), "—");
  });
});

describe("injectUpstreamErrorBanner — NÃO ganha horário inventado (#5218 guard)", () => {
  // Guard de regressão explícito: #5218 pede pra NÃO tocar este banner (403/5xx
  // não tem ETA real da Brevo, diferente de rate-limit que tem retryAfterSecs).
  test("mensagem não contém nenhum padrão de horário HH:MM nem 'volta a atualizar sozinho'", () => {
    const out = injectUpstreamErrorBanner("<body><h1>D</h1></body>", 503, null);
    assert.ok(out.includes("Brevo indisponível"), "banner de indisponibilidade presente");
    assert.ok(!out.includes("volta a atualizar sozinho"), "não inventa a mensagem de horário do banner de rate-limit");
    assert.ok(!/\b\d{2}:\d{2}\s*BRT\b/.test(out), "não injeta nenhum horário de relógio (sem ETA real da Brevo)");
  });

  test("com generatedAt, continua usando 'defasado desde' (fmtTimeBRT, com data) — comportamento pré-#5218 preservado", () => {
    const out = injectUpstreamErrorBanner("<body></body>", 500, "2026-08-14T10:00:00.000Z");
    assert.ok(out.includes("defasado desde"), "mensagem de defasagem com timestamp real preservada");
  });
});

describe("parseRateLimitRemaining / shouldWarnLowRateLimitRemaining (#5215 item 4)", () => {
  test("header numérico válido → número", () => {
    assert.strictEqual(parseRateLimitRemaining("42"), 42);
  });

  test("header ausente → null", () => {
    assert.strictEqual(parseRateLimitRemaining(null), null);
  });

  test("header não-numérico → null", () => {
    assert.strictEqual(parseRateLimitRemaining("not-a-number"), null);
  });

  test("header negativo → null (defensivo)", () => {
    assert.strictEqual(parseRateLimitRemaining("-5"), null);
  });

  test("shouldWarn: remaining no threshold (10) → true", () => {
    assert.strictEqual(shouldWarnLowRateLimitRemaining(10), true);
  });

  test("shouldWarn: remaining acima do threshold → false", () => {
    assert.strictEqual(shouldWarnLowRateLimitRemaining(50), false);
  });

  test("shouldWarn: remaining null (header ausente) → false, nunca alarma por ausência de dado", () => {
    assert.strictEqual(shouldWarnLowRateLimitRemaining(null), false);
  });

  test("shouldWarn: threshold customizado", () => {
    assert.strictEqual(shouldWarnLowRateLimitRemaining(20, 25), true);
    assert.strictEqual(shouldWarnLowRateLimitRemaining(30, 25), false);
  });
});

describe("fila 'avisar quando atualizar' — dash:refresh:pending (#5218 Peça 2)", () => {
  function makePendingKvMock(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    const putCalls: Array<{ key: string; value: string; opts?: unknown }> = [];
    const deleteCalls: string[] = [];
    return {
      store, putCalls, deleteCalls,
      kv: {
        get: async (key: string, type?: string) => {
          const v = store.get(key);
          if (v == null) return null;
          return type === "json" ? JSON.parse(v) : v;
        },
        put: async (key: string, value: string, opts?: unknown) => {
          putCalls.push({ key, value, opts });
          store.set(key, value);
        },
        delete: async (key: string) => {
          deleteCalls.push(key);
          store.delete(key);
        },
        list: async () => ({ keys: [], cursor: "", list_complete: true }),
        getWithMetadata: async () => ({ value: null, metadata: null }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    };
  }

  test("buildRefreshPendingRecord: monta {requestedAt, resetAt} a partir de resetAtMs pronto", () => {
    const rec = buildRefreshPendingRecord(5000, 1000);
    assert.deepStrictEqual(rec, { requestedAt: 1000, resetAt: 5000 });
  });

  test("isRefreshPendingDue: now < resetAt → false", () => {
    assert.strictEqual(isRefreshPendingDue({ requestedAt: 0, resetAt: 5000 }, 4999), false);
  });

  test("isRefreshPendingDue: now === resetAt → true (limite inclusivo)", () => {
    assert.strictEqual(isRefreshPendingDue({ requestedAt: 0, resetAt: 5000 }, 5000), true);
  });

  test("isRefreshPendingDue: now > resetAt → true", () => {
    assert.strictEqual(isRefreshPendingDue({ requestedAt: 0, resetAt: 5000 }, 6000), true);
  });

  test("isRefreshPendingDue: registro null → false (fail-closed, sem registro não força fresh)", () => {
    assert.strictEqual(isRefreshPendingDue(null, 999999), false);
  });

  test("readRefreshPending: KV vazio → null", async () => {
    const { kv } = makePendingKvMock();
    const result = await readRefreshPending({ STATS_CACHE: kv } as any);
    assert.strictEqual(result, null);
  });

  test("readRefreshPending: KV populado → registro tipado", async () => {
    const { kv } = makePendingKvMock({ [REFRESH_PENDING_KV_KEY]: JSON.stringify({ requestedAt: 1, resetAt: 2 }) });
    const result = await readRefreshPending({ STATS_CACHE: kv } as any);
    assert.deepStrictEqual(result, { requestedAt: 1, resetAt: 2 });
  });

  test("readRefreshPending: KV malformado (sem os campos certos) → null (fail-closed)", async () => {
    const { kv } = makePendingKvMock({ [REFRESH_PENDING_KV_KEY]: JSON.stringify({ foo: "bar" }) });
    const result = await readRefreshPending({ STATS_CACHE: kv } as any);
    assert.strictEqual(result, null);
  });

  test("readRefreshPending: sem STATS_CACHE → null (nunca lança)", async () => {
    const result = await readRefreshPending({ STATS_CACHE: undefined } as any);
    assert.strictEqual(result, null);
  });

  test("writeRefreshPending: grava com TTL = secsUntilReset + 120", async () => {
    const { kv, putCalls } = makePendingKvMock();
    const nowMs = 1_000_000;
    const resetAtMs = nowMs + 90_000; // 90s no futuro
    await writeRefreshPending({ STATS_CACHE: kv } as any, resetAtMs, nowMs);
    assert.strictEqual(putCalls.length, 1);
    assert.strictEqual(putCalls[0].key, REFRESH_PENDING_KV_KEY);
    assert.deepStrictEqual(JSON.parse(putCalls[0].value), { requestedAt: nowMs, resetAt: resetAtMs });
    assert.deepStrictEqual(putCalls[0].opts, { expirationTtl: 90 + 120 });
  });

  test("writeRefreshPending: resetAt no passado → secsUntilReset clampado a 0, TTL = 0 + 120", async () => {
    const { kv, putCalls } = makePendingKvMock();
    const nowMs = 1_000_000;
    await writeRefreshPending({ STATS_CACHE: kv } as any, nowMs - 5000, nowMs); // resetAt já passou
    // secsUntilReset nunca fica negativo (Math.max(0, ...)) -- daí TTL = 120,
    // sempre >= o piso de 60s exigido pelo KV (120 domina o Math.max(60, ...)
    // nesta função pra QUALQUER resetAtMs >= nowMs - 120000; o piso de 60s é
    // rede de segurança pro caso extremo, não o caminho comum).
    assert.strictEqual((putCalls[0].opts as { expirationTtl: number }).expirationTtl, 120);
  });

  test("clearRefreshPending: remove a chave", async () => {
    const { kv, deleteCalls } = makePendingKvMock({ [REFRESH_PENDING_KV_KEY]: "{}" });
    await clearRefreshPending({ STATS_CACHE: kv } as any);
    assert.ok(deleteCalls.includes(REFRESH_PENDING_KV_KEY));
  });

  test("clearRefreshPending: sem STATS_CACHE → no-op, nunca lança", async () => {
    await assert.doesNotReject(() => clearRefreshPending({ STATS_CACHE: undefined } as any));
  });

  // Regressão real, achada rodando a suíte completa (#3653 achado 2 já tinha
  // documentado esta MESMA classe de bug pro lock KV — .catch() encadeado só
  // intercepta rejection de Promise, não uma exceção SÍNCRONA lançada antes
  // da Promise sequer existir). `readRefreshPending` é chamado
  // INCONDICIONALMENTE em toda request `/` (handleFetch) -- um mock/binding
  // que lance síncrono aqui derrubava a rota inteira pro catch de última
  // instância (#4187, 500) em vez de simplesmente tratar como "sem fila".
  describe("kv.get/put/delete lançando SINCRONAMENTE (não Promise rejeitada) -- nunca escapa", () => {
    function makeSyncThrowingKv() {
      return {
        get: (): never => { throw new Error("sync KV crash"); },
        put: (): never => { throw new Error("sync KV crash"); },
        delete: (): never => { throw new Error("sync KV crash"); },
        list: async () => ({ keys: [], cursor: "", list_complete: true }),
        getWithMetadata: async () => ({ value: null, metadata: null }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    }

    test("readRefreshPending: get síncrono lançando → null, não propaga", async () => {
      const result = await readRefreshPending({ STATS_CACHE: makeSyncThrowingKv() } as any);
      assert.strictEqual(result, null);
    });

    test("writeRefreshPending: put síncrono lançando → resolve normalmente (fail-soft)", async () => {
      await assert.doesNotReject(() => writeRefreshPending({ STATS_CACHE: makeSyncThrowingKv() } as any, Date.now() + 1000));
    });

    test("clearRefreshPending: delete síncrono lançando → resolve normalmente (fail-soft)", async () => {
      await assert.doesNotReject(() => clearRefreshPending({ STATS_CACHE: makeSyncThrowingKv() } as any));
    });
  });
});
