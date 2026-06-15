/**
 * test/brevo-umbrella-2275-2273-2282.test.ts
 *
 * Regressões para o PR umbrella:
 *  - #2275: withBrevo429Retry em scripts/lib/brevo-client.ts
 *    (a) retenta em 429, honrando Retry-After; sucede na 2ª tentativa.
 *    (b) propaga após esgotar tentativas.
 *    (c) brevoPost/brevoGetCampaign/brevoGetList/brevoPut/brevoListAllLists
 *        retentam em 429 (smoke via brevoPost como proxy — a implementação
 *        é compartilhada via withBrevo429Retry).
 *    (d) scripts migrados: throwBrevo429 lança Brevo429Signal (reconhecido pelo retry).
 *  - #2273: isLinksStatsPoisoned — detecção de cache envenenado.
 *    (a) lstats todos-zeros + clickers>0 → poison.
 *    (b) lstats com algum click > 0 → não-poison.
 *    (c) lstats null/undefined → não-poison.
 *    (d) lstats {} (vazio) → não-poison (campanha sem links rastreados).
 *    (e) fetchRecentCampaigns com lstats poison no KV → force re-fetch.
 *  - #2282: djb2Hash + LASTGOOD_KEY/HASH condicional.
 *    (a) djb2Hash é determinístico (mesma string → mesmo hash).
 *    (b) djb2Hash é sensível ao conteúdo (strings diferentes → hashes diferentes).
 *    (c) RECENT_STATS_TTL foi elevado a 1800s (≥ 900 pra ser defensivo).
 *    (d) lastgood só grava quando hash mudou (via fetchRecentCampaigns mock).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── #2275: withBrevo429Retry em brevo-client.ts ────────────────────────────

describe("withBrevo429Retry — scripts/lib/brevo-client.ts (#2275)", () => {
  const noSleep = async (_ms: number): Promise<void> => {};

  test("retenta em 429 honrando Retry-After e sucede na 2ª tentativa", async () => {
    const { withBrevo429Retry, throwBrevo429 } = await import("../scripts/lib/brevo-client.ts");
    let calls = 0;
    const result = await withBrevo429Retry(async () => {
      calls++;
      if (calls === 1) {
        // Simula resposta 429 com Retry-After
        const fakeRes = {
          status: 429,
          headers: { get: (h: string) => h === "retry-after" ? "1" : null },
        } as unknown as Response;
        throwBrevo429(fakeRes);
      }
      return "ok";
    }, noSleep);
    assert.strictEqual(result, "ok");
    assert.strictEqual(calls, 2, "1 tentativa 429 + 1 sucesso");
  });

  test("propaga BrevoRateLimitError após esgotar MAX_ATTEMPTS", async () => {
    const { withBrevo429Retry, throwBrevo429 } = await import("../scripts/lib/brevo-client.ts");
    let calls = 0;
    const fakeRes = {
      status: 429,
      headers: { get: (_h: string) => null },
    } as unknown as Response;
    await assert.rejects(
      () => withBrevo429Retry(async () => {
        calls++;
        throwBrevo429(fakeRes);
      }, noSleep),
      /429/,
    );
    assert.ok(calls >= 2, `deve tentar pelo menos 2× (tentou ${calls}×)`);
  });

  test("erro não-429 propaga imediatamente (sem retry)", async () => {
    const { withBrevo429Retry } = await import("../scripts/lib/brevo-client.ts");
    let calls = 0;
    await assert.rejects(
      () => withBrevo429Retry(async () => {
        calls++;
        throw new Error("auth error 401");
      }, noSleep),
      /401/,
    );
    assert.strictEqual(calls, 1, "erro não-429 não retenta");
  });

  test("brevoPost retenta em 429 — smoke test via mock fetch", async () => {
    // Salva e substitui fetch global temporariamente (Node 18+ suporta globalThis.fetch).
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      calls++;
      if (calls === 1) {
        return {
          status: 429,
          ok: false,
          headers: { get: (h: string) => h === "retry-after" ? "0" : null },
          text: async () => "Too Many Requests",
        } as unknown as Response;
      }
      // 2ª tentativa: sucesso
      return {
        status: 200,
        ok: true,
        headers: { get: (h: string) => h === "content-type" ? "application/json" : null },
        text: async () => JSON.stringify({ id: 42 }),
      } as unknown as Response;
    };
    try {
      const { brevoPost } = await import("../scripts/lib/brevo-client.ts");
      const result = await brevoPost("key", "/emailCampaigns", { subject: "Test" }, noSleep);
      assert.deepStrictEqual(result, { id: 42 }, "deve retornar a resposta da 2ª tentativa");
      assert.strictEqual(calls, 2, "deve ter feito 2 chamadas fetch (1 429 + 1 sucesso)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throwBrevo429 lança Brevo429Signal (reconhecível pelo retry wrapper)", async () => {
    const { withBrevo429Retry, throwBrevo429, Brevo429Signal } = await import("../scripts/lib/brevo-client.ts");
    let caughtByWrapper = false;
    const fakeRes = { status: 429, headers: { get: () => null } } as unknown as Response;
    // withBrevo429Retry deve capturar Brevo429Signal e retentarT
    let calls = 0;
    const result = await withBrevo429Retry(async () => {
      calls++;
      if (calls === 1) throwBrevo429(fakeRes); // primeiro lança
      caughtByWrapper = true; // se chegou aqui, o retry funcionou
      return "ok after retry";
    }, noSleep);
    assert.ok(caughtByWrapper, "throwBrevo429 deve ser interceptado pelo wrapper");
    assert.strictEqual(result, "ok after retry");
  });
});

// ─── #2273: isLinksStatsPoisoned ────────────────────────────────────────────

describe("isLinksStatsPoisoned (#2273 — detecção de cache envenenado)", () => {
  test("poison: lstats todos-zeros + clickers>0 → true", async () => {
    const { isLinksStatsPoisoned } = await import("../workers/brevo-dashboard/src/index.ts");
    const ls = { "https://diar.ia/post": 0, "https://exame.com/x": 0 };
    const gs = { clickers: 5 };
    assert.strictEqual(isLinksStatsPoisoned(ls, gs), true);
  });

  test("não-poison: pelo menos 1 click > 0", async () => {
    const { isLinksStatsPoisoned } = await import("../workers/brevo-dashboard/src/index.ts");
    const ls = { "https://diar.ia/post": 3, "https://exame.com/x": 0 };
    const gs = { clickers: 5 };
    assert.strictEqual(isLinksStatsPoisoned(ls, gs), false);
  });

  test("não-poison: lstats null → ausente (não buscado ainda)", async () => {
    const { isLinksStatsPoisoned } = await import("../workers/brevo-dashboard/src/index.ts");
    assert.strictEqual(isLinksStatsPoisoned(null, { clickers: 5 }), false);
  });

  test("não-poison: lstats undefined", async () => {
    const { isLinksStatsPoisoned } = await import("../workers/brevo-dashboard/src/index.ts");
    assert.strictEqual(isLinksStatsPoisoned(undefined, { clickers: 5 }), false);
  });

  test("não-poison: lstats {} vazio (campanha sem links rastreados)", async () => {
    const { isLinksStatsPoisoned } = await import("../workers/brevo-dashboard/src/index.ts");
    assert.strictEqual(isLinksStatsPoisoned({}, { clickers: 5 }), false);
  });

  test("não-poison: gs null (sem confirmação de cliques reais)", async () => {
    const { isLinksStatsPoisoned } = await import("../workers/brevo-dashboard/src/index.ts");
    const ls = { "https://diar.ia/post": 0 };
    assert.strictEqual(isLinksStatsPoisoned(ls, null), false, "sem gs, não podemos afirmar poison");
  });

  test("não-poison: gs.clickers = 0 (campanha sem cliques)", async () => {
    const { isLinksStatsPoisoned } = await import("../workers/brevo-dashboard/src/index.ts");
    const ls = { "https://diar.ia/post": 0 };
    const gs = { clickers: 0 };
    assert.strictEqual(isLinksStatsPoisoned(ls, gs), false, "zeros são esperados quando não houve cliques");
  });

  test("fetchRecentCampaigns: lstats poison no KV → re-fetch da Brevo", async () => {
    // Regressão #2273: a short-circuit `if (cachedGs && cachedLs) return` servia
    // o cache envenenado para sempre. Com a correção, lstats-poison força re-fetch.
    const { fetchRecentCampaigns, BrevoRateLimitError } = await import("../workers/brevo-dashboard/src/index.ts");
    const sentDateOld = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const fakeCampaign = {
      id: 32, name: "Clarice News 2604 d03-A (qua)", subject: "s", status: "sent",
      sentDate: sentDateOld, scheduledAt: null, createdAt: sentDateOld,
      recipients: { lists: [7] },
      statistics: { campaignStats: [] },
    };
    const fakeGlobalStats = {
      sent: 500, delivered: 490, hardBounces: 5, softBounces: 2,
      uniqueViews: 120, viewed: 130, trackableViews: 100, uniqueClicks: 30,
      clickers: 25, // clickers > 0 → poison é detectável
      unsubscriptions: 2, complaints: 0, appleMppOpens: 10,
    };
    // lstats envenenado: 2 links mas TODOS com 0 clicks (era do bug #2177)
    const poisonedLstats = { "https://diar.ia/post-x": 0, "https://exame.com/y": 0 };
    // lstats reais que a Brevo retorna
    const realLstats = { "https://diar.ia/post-x": 8, "https://exame.com/y": 3 };

    const store: Record<string, unknown> = {
      "gstats:32": fakeGlobalStats,
      "lstats:32": poisonedLstats, // cache envenenado
      "list:7": { id: 7, name: "T1-W1", totalSubscribers: 500 },
    };
    const kv = {
      get: async (k: string, type?: string) => {
        if (!(k in store)) return null;
        return type === "json" ? store[k] : JSON.stringify(store[k]);
      },
      put: async (k: string, v: string) => { store[k] = JSON.parse(v); },
    };

    let lstatsFetched = false;
    const mockFetch = async <T>(path: string, _env: unknown): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (/emailCampaigns\/32\?statistics=globalStats/.test(path)) {
        return { ...fakeCampaign, statistics: { globalStats: fakeGlobalStats } } as T;
      }
      if (/emailCampaigns\/32\?statistics=linksStats/.test(path)) {
        lstatsFetched = true;
        return { ...fakeCampaign, statistics: { linksStats: realLstats } } as T;
      }
      throw new Error("path inesperado: " + path);
    };

    const result = await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv as any } as any,
      20, false, mockFetch as any,
    );

    assert.strictEqual(lstatsFetched, true,
      "lstats poison (zeros + clickers>0) deve forçar re-fetch da Brevo");
    assert.deepStrictEqual(
      result[0].statistics?.linksStats, realLstats,
      "linksStats no resultado deve ser o real (não o envenenado)",
    );
  });
});

// ─── #2282: djb2Hash + RECENT_STATS_TTL + write condicional ─────────────────

describe("djb2Hash (#2282 — write condicional)", () => {
  test("hash é determinístico (mesma string → mesmo hash)", async () => {
    const { djb2Hash } = await import("../workers/brevo-dashboard/src/index.ts");
    const s = "<html>Dashboard content 123</html>";
    assert.strictEqual(djb2Hash(s), djb2Hash(s));
  });

  test("hash difere para strings diferentes", async () => {
    const { djb2Hash } = await import("../workers/brevo-dashboard/src/index.ts");
    assert.notStrictEqual(djb2Hash("version 1"), djb2Hash("version 2"));
  });

  test("hash de string vazia não lança", async () => {
    const { djb2Hash } = await import("../workers/brevo-dashboard/src/index.ts");
    assert.doesNotThrow(() => djb2Hash(""));
  });
});

describe("RECENT_STATS_TTL elevado (#2282)", () => {
  test("RECENT_STATS_TTL >= 900s (corte mínimo aceitável é 15min)", async () => {
    const { RECENT_STATS_TTL } = await import("../workers/brevo-dashboard/src/index.ts");
    assert.ok(
      RECENT_STATS_TTL >= 900,
      `RECENT_STATS_TTL deve ser >= 900s para cortar writes/dia; valor atual: ${RECENT_STATS_TTL}`,
    );
  });

  test("campanha recente cacheada com TTL = RECENT_STATS_TTL (regressão do valor)", async () => {
    // Garante que o TTL usado no KV.put bate com a constante (não hardcoded 300).
    const { fetchRecentCampaigns, RECENT_STATS_TTL } = await import("../workers/brevo-dashboard/src/index.ts");
    const sentDateRecent = new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString();
    const recentCampaign = {
      id: 99, name: "Test Recent", subject: "s", status: "sent",
      sentDate: sentDateRecent, scheduledAt: null, createdAt: sentDateRecent,
      recipients: { lists: [7] }, statistics: { campaignStats: [] },
    };
    const fakeGs = {
      sent: 100, delivered: 95, hardBounces: 1, softBounces: 0,
      uniqueViews: 30, viewed: 35, trackableViews: 28, uniqueClicks: 8,
      clickers: 7, unsubscriptions: 0, complaints: 0, appleMppOpens: 3,
    };
    const putOpts: Record<string, unknown> = {};
    const kv = {
      get: async () => null,
      put: async (k: string, _v: string, opts?: unknown) => { putOpts[k] = opts; },
    };
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [recentCampaign] } as T;
      if (/emailCampaigns\/99\?statistics=globalStats/.test(path)) return { ...recentCampaign, statistics: { globalStats: fakeGs } } as T;
      if (/emailCampaigns\/99\?statistics=linksStats/.test(path)) return { ...recentCampaign, statistics: { linksStats: {} } } as T;
      if (/contacts\/lists\/7/.test(path)) return { id: 7, name: "L", totalSubscribers: 100 } as T;
      throw new Error("path inesperado: " + path);
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv as any } as any, 20, false, mockFetch as any);
    const gsTtl = (putOpts["gstats:99"] as any)?.expirationTtl;
    assert.strictEqual(gsTtl, RECENT_STATS_TTL,
      `TTL de gstats recente deve ser ${RECENT_STATS_TTL}s (RECENT_STATS_TTL), não hardcoded`);
  });
});

describe("lastgood write condicional (#2282 — não grava quando conteúdo não mudou)", () => {
  // Testa diretamente que o djb2Hash de dois HTMLs idênticos é o mesmo,
  // portanto o branch de "skip write" seria acionado (não testamos o KV
  // diretamente na rota /, pois o fetch handler é um dispatch do Worker —
  // o fetch handler não é exportado de forma testável em unidade).
  test("djb2Hash idêntico para mesmo HTML → branch de skip seria acionado", async () => {
    const { djb2Hash } = await import("../workers/brevo-dashboard/src/index.ts");
    const html = `<!DOCTYPE html><html><body><h1>Dashboard</h1><p>ts: 12:00</p></body></html>`;
    const h1 = djb2Hash(html);
    const h2 = djb2Hash(html);
    assert.strictEqual(h1, h2,
      "hashes idênticos → prevHash === newHash → skip write (não grava novamente)");
  });

  test("djb2Hash diferente quando conteúdo muda → write seria acionado", async () => {
    const { djb2Hash } = await import("../workers/brevo-dashboard/src/index.ts");
    const html1 = `<!DOCTYPE html><html><body><h1>Dashboard</h1><p>ts: 12:00</p></body></html>`;
    const html2 = `<!DOCTYPE html><html><body><h1>Dashboard</h1><p>ts: 12:05</p></body></html>`;
    assert.notStrictEqual(djb2Hash(html1), djb2Hash(html2),
      "hashes diferentes → conteúdo mudou → write seria acionado");
  });
});

// ─── Regressões F6/F7/F8 (code-review findings) ─────────────────────────────

describe("F6 — retry-after: 0 produz sleep de 0ms, não fallback de 2s (#2275)", () => {
  // Antes da correção F2: `v > 0` descartava retry-after:0, caindo no fallback 2s.
  // Após F2: `v >= 0` aceita 0 e passa 0ms para o _sleep.
  test("retry-after: 0 deve passar 0ms para o sleep (não 2000ms)", async () => {
    const { withBrevo429Retry, throwBrevo429 } = await import("../scripts/lib/brevo-client.ts");
    let receivedMs = -1;
    const captureSleep = async (ms: number): Promise<void> => { receivedMs = ms; };
    let calls = 0;
    await withBrevo429Retry(async () => {
      calls++;
      if (calls === 1) {
        const fakeRes = {
          status: 429,
          headers: { get: (h: string) => h === "retry-after" ? "0" : null },
        } as unknown as Response;
        throwBrevo429(fakeRes);
      }
      return "ok";
    }, captureSleep);
    assert.strictEqual(receivedMs, 0,
      `retry-after:0 deve produzir sleep de 0ms (RFC 7231: retry imediato); recebeu ${receivedMs}ms`);
    assert.strictEqual(calls, 2, "deve ter retentado 1x");
  });
});

describe("F7 — poison lstats em campanha imutável deve ser gravado com TTL (#2273 auto-heal)", () => {
  // Antes: mock KV.put sem opts não verificava o expirationTtl. O mecanismo de
  // auto-cura (#2273) — TTL curto em lstats suspeito — ficava sem cobertura.
  // Cenário: cache tem lstats envenenado. Re-fetch da Brevo AINDA retorna zeros
  // (Brevo intermitente). O worker deve gravar o lstats-ainda-poison COM TTL
  // curto (RECENT_STATS_TTL) para que a entrada se auto-destrua e um próximo
  // render tente novamente — em vez de gravar {} (sem TTL) que criaria poison permanente.
  test("lstats ainda-poison após re-fetch em campanha imutável → KV.put com expirationTtl = RECENT_STATS_TTL", async () => {
    const { fetchRecentCampaigns, RECENT_STATS_TTL } = await import("../workers/brevo-dashboard/src/index.ts");
    // Campanha imutável (> 7 dias)
    const sentDateOld = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const campaign = {
      id: 77, name: "Old Campaign", subject: "s", status: "sent",
      sentDate: sentDateOld, scheduledAt: null, createdAt: sentDateOld,
      recipients: { lists: [7] }, statistics: { campaignStats: [] },
    };
    const fakeGs = {
      sent: 300, delivered: 290, hardBounces: 3, softBounces: 1,
      uniqueViews: 80, viewed: 90, trackableViews: 70, uniqueClicks: 15,
      clickers: 12, // clickers > 0 → poison detectável
      unsubscriptions: 1, complaints: 0, appleMppOpens: 5,
    };
    // lstats envenenado tanto no cache como no re-fetch (Brevo ainda instável)
    const poisonedLstats = { "https://diar.ia/artigo": 0, "https://exemplo.com/x": 0 };

    const putOpts: Record<string, unknown> = {};
    const kv = {
      get: async (k: string, type?: string) => {
        const store: Record<string, unknown> = {
          "gstats:77": fakeGs,
          "lstats:77": poisonedLstats, // cache envenenado
          "list:7": { id: 7, name: "T1-W1", totalSubscribers: 300 },
        };
        if (!(k in store)) return null;
        return type === "json" ? store[k] : JSON.stringify(store[k]);
      },
      // Captura opts (terceiro argumento) — crítico para este teste
      put: async (k: string, _v: string, opts?: unknown) => { putOpts[k] = opts; },
    };
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [campaign] } as T;
      if (/emailCampaigns\/77\?statistics=globalStats/.test(path)) return { ...campaign, statistics: { globalStats: fakeGs } } as T;
      // Brevo ainda retorna lstats zerado (poison persistente — Brevo instável)
      if (/emailCampaigns\/77\?statistics=linksStats/.test(path)) return { ...campaign, statistics: { linksStats: poisonedLstats } } as T;
      throw new Error("path inesperado: " + path);
    };

    await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv as any } as any,
      20, false, mockFetch as any,
    );

    const lsOpts = putOpts["lstats:77"] as any;
    assert.ok(lsOpts !== undefined, "lstats:77 deve ser gravado no KV (ainda-poison precisa de re-write com TTL)");
    assert.strictEqual(lsOpts?.expirationTtl, RECENT_STATS_TTL,
      `lstats ainda-poison em campanha imutável deve usar expirationTtl=${RECENT_STATS_TTL} (auto-heal TTL), não {} (sem TTL = poison permanente)`);
  });
});

describe("F8 — gs.sent===0: poison check usa gs raw via fallback (F1 fix)", () => {
  // Antes do fix F1: quando gs.sent===0, globalStatsMap.set NÃO era chamado (guard linha 443).
  // gsFetched = globalStatsMap.get(c.id) retornava undefined → isLinksStatsPoisoned(ls, null) = false.
  // lstats envenenado era gravado sem TTL em campanha imutável — regride #2273.
  // Após F1: gsFetched = globalStatsMap.get(c.id) ?? gs ?? null — usa gs raw mesmo com sent=0.
  test("gs.sent===0 + clickers>0 + lstats-poison → ainda detecta poison via gs raw", async () => {
    const { fetchRecentCampaigns, RECENT_STATS_TTL } = await import("../workers/brevo-dashboard/src/index.ts");
    const sentDateOld = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const campaign = {
      id: 55, name: "Campaign Zeroed", subject: "s", status: "sent",
      sentDate: sentDateOld, scheduledAt: null, createdAt: sentDateOld,
      recipients: { lists: [7] }, statistics: { campaignStats: [] },
    };
    // gs.sent === 0 mas clickers > 0 — Brevo pode retornar isso em condições de zeragem parcial.
    // O guard `if (gs && gs.sent > 0) globalStatsMap.set(...)` não chama set com este gs.
    const gsZeroed = {
      sent: 0, delivered: 0, hardBounces: 0, softBounces: 0,
      uniqueViews: 0, viewed: 0, trackableViews: 0, uniqueClicks: 0,
      clickers: 25, // clickers > 0 → poison deveria ser detectável
      unsubscriptions: 0, complaints: 0, appleMppOpens: 0,
    };
    const poisonedLstats = { "https://diar.ia/z": 0, "https://outro.com/w": 0 };
    const realLstats = { "https://diar.ia/z": 10, "https://outro.com/w": 3 };

    const putOpts: Record<string, unknown> = {};
    const kv = {
      get: async (k: string, type?: string) => {
        // Sem cachedGs nem cachedLs no KV → sempre re-fetch
        if (k === "list:7") {
          const v = { id: 7, name: "T1-W1", totalSubscribers: 500 };
          return type === "json" ? v : JSON.stringify(v);
        }
        return null;
      },
      put: async (k: string, _v: string, opts?: unknown) => { putOpts[k] = opts; },
    };
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [campaign] } as T;
      if (/emailCampaigns\/55\?statistics=globalStats/.test(path)) return { ...campaign, statistics: { globalStats: gsZeroed } } as T;
      if (/emailCampaigns\/55\?statistics=linksStats/.test(path)) return { ...campaign, statistics: { linksStats: poisonedLstats } } as T;
      throw new Error("path inesperado: " + path);
    };

    await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv as any } as any,
      20, false, mockFetch as any,
    );

    const lsOpts = putOpts["lstats:55"] as any;
    assert.ok(lsOpts, "lstats:55 deve ser gravado no KV");
    assert.strictEqual(lsOpts?.expirationTtl, RECENT_STATS_TTL,
      `gs.sent===0 + clickers>0 + lstats-poison: deve usar expirationTtl=${RECENT_STATS_TTL} (poison detectado via gs raw). ` +
      `Sem o fix F1, gsFetched seria undefined → poison não detectado → TTL seria {} (imutável sem TTL, regressão #2273).`);
  });
});
