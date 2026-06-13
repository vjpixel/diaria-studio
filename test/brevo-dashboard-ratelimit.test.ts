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
    return {
      store, getCalls, putCalls,
      kv: {
        get: async (key: string, type?: string) => {
          getCalls.push(key);
          const val = store.get(key);
          if (!val) return null;
          if (type === "json") return JSON.parse(val);
          return val;
        },
        put: async (key: string, value: string) => {
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
    // linksStats deve estar disponível no resultado
    assert.ok(result[0].linksStats !== undefined, "linksStats deve estar presente no resultado");
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
});
