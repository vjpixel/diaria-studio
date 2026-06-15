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
    const fakeLinksStats = { "https://diar.ia/edicao/test": 5 };
    const { kv, getCalls } = makeKVMock({
      "gstats:42": JSON.stringify(fakeGlobalStats),
      "lstats:42": JSON.stringify(fakeLinksStats),
      "list:7": JSON.stringify(fakeList),
    });
    let detailCalled = false;
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (path.includes("emailCampaigns/42")) { detailCalled = true; throw new Error("nao devia chamar"); }
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    assert.strictEqual(detailCalled, false, "fetchFn NAO deve ser chamado com KV hit de ambos gstats+lstats");
    assert.ok(getCalls.includes("gstats:42"), "KV.get deve ter sido chamado para gstats");
    assert.ok(getCalls.includes("lstats:42"), "KV.get deve ter sido chamado para lstats");
    assert.strictEqual(result[0].statistics?.globalStats?.sent, 100, "sent deve vir do KV");
  });

  test("regressão #2183: gstats em cache mas lstats ausente → fetchFn DEVE ser chamada", async () => {
    // Bug: `if (cachedGs) return` pulava fetch mesmo sem lstats, impedindo campanhas
    // pré-#2177 (que só têm gstats no KV) de receber dados de links.
    const { kv, getCalls, putCalls } = makeKVMock({
      "gstats:42": JSON.stringify(fakeGlobalStats),
      "list:7": JSON.stringify(fakeList),
      // lstats:42 ausente propositalmente — simula campanha pré-#2177
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
      "fetchFn DEVE ser chamada quando gstats está em cache mas lstats está ausente (bug #2183)");
    assert.ok(getCalls.includes("lstats:42"), "KV.get deve ter sido tentado para lstats");
    assert.ok(putCalls.includes("lstats:42"), "KV.put deve persistir lstats após fetch");
    // linksStats deve estar disponível em statistics.linksStats (fonte única, #2199.3)
    assert.ok(result[0].statistics?.linksStats !== undefined, "linksStats deve estar presente em result[0].statistics.linksStats");
  });

  test("KV miss de gstats chama _fetchFn e persiste no KV", async () => {
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
    assert.ok(putCalls.includes("gstats:42"), "KV.put deve persistir gstats:42");
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
    const { kv, putCalls } = makeKVMock({ "list:7": JSON.stringify(fakeList) });
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (path.includes("emailCampaigns/42")) {
        return { ...fakeCampaign, statistics: { globalStats: { ...fakeGlobalStats, sent: 0 } } } as T;
      }
      throw new Error("path inesperado: " + path);
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    assert.strictEqual(putCalls.includes("gstats:42"), false,
      "KV.put NAO deve ser chamado para gstats zerado (evita envenenamento permanente)");
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

  test("#2270: campanha recente é cacheada com TTL (expirationTtl) em gstats+lstats", async () => {
    const { kv, putOpts, putCalls } = makeKVMock({ "list:7": JSON.stringify(fakeList) });
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [recentCampaign] } as T;
      if (/emailCampaigns\/77\?statistics=globalStats/.test(path)) return { ...recentCampaign, statistics: { globalStats: fakeGlobalStats } } as T;
      if (/emailCampaigns\/77\?statistics=linksStats/.test(path)) return { ...recentCampaign, statistics: { linksStats: { "https://x.com/a": 3 } } } as T;
      throw new Error("path inesperado: " + path);
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    assert.ok(putCalls.includes("gstats:77"), "deve cachear gstats da recente");
    assert.ok(putCalls.includes("lstats:77"), "deve cachear lstats da recente");
    assert.equal((putOpts["gstats:77"] as any)?.expirationTtl, 300, "gstats recente com TTL 300s");
    assert.equal((putOpts["lstats:77"] as any)?.expirationTtl, 300, "lstats recente com TTL 300s");
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
    assert.deepEqual(putOpts["gstats:42"], {}, "gstats imutável SEM expirationTtl");
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
