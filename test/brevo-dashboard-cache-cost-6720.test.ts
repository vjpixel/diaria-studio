/**
 * test/brevo-dashboard-cache-cost-6720.test.ts
 *
 * Regressão para a Fatia C do #6720 (Refs #7007) — reduz o custo por render
 * de `fetchRecentCampaigns` (a família `/v3/emailCampaigns*` tem teto real de
 * 100 requisições/HORA na Brevo, ver `BREVO_RATE_LIMIT_GENERAL_RPH` em
 * brevo-api.ts) sem reabrir o #2177 (linksStats zerado) nem quebrar o
 * cache-aside já existente (#2314/#2323/#2337).
 *
 * Cobertura:
 *   (A) `resolveRecentStatsTtl` — função pura, faixas de idade (48h/7d),
 *       `nowMs` injetável (mesmo padrão de `isImmutableCampaign`).
 *   (B) `includeLinksStats=false` (usado por `/api/campaigns`, #7007):
 *       - pula o 2º GET (linksStats) quando não há nada em cache;
 *       - NÃO grava `lsPending:true` — isso mentiria pro próximo render que
 *         de fato precisa do dado (early-return o faria pular o fetch real);
 *       - NÃO re-escreve o KV quando nada mudou nesta rodada (gs já
 *         cacheado, ls deliberadamente pulado) — sem write inútil;
 *       - um render SUBSEQUENTE com `includeLinksStats=true` (rota `/`)
 *         AINDA consegue buscar o ls que o render anterior pulou — a
 *         garantia central desta fatia (nunca "adiar pra sempre").
 *   (C) `includeLinksStats=true` (default — rota `/`, Studio) continua
 *       fazendo os 2 GETs e populando a seção de links com os cliques REAIS
 *       — guarda explícita contra reabrir o #2177 (ver o bloco de comentário
 *       em `fetchRecentCampaigns`, brevo-api.ts, imediatamente acima do
 *       fetch de `linksStats`, sobre `?statistics=combined` vir zerado).
 *   (D) TTL por faixa de idade no KV write (a faixa nova desta fatia):
 *       <48h → RECENT_STATS_TTL; 2-7d → MID_RANGE_STATS_TTL; poison ou
 *       ls-fetch-falho SEMPRE RECENT_STATS_TTL, independente da idade
 *       (auto-cura rápida — #2323/#2337 preservados, não deslocados pela
 *       faixa nova).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  fetchRecentCampaigns,
  resolveRecentStatsTtl,
  RECENT_STATS_TTL,
  MID_RANGE_STATS_TTL,
} from "../workers/brevo-dashboard/src/index.ts";
import type { BrevoGlobalStats, BrevoLinksStats } from "../workers/brevo-dashboard/src/types.ts";

// ─── helpers ──────────────────────────────────────────────────────────────

function makeKvMock(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const putCalls: Array<{ key: string; value: unknown; opts: unknown }> = [];
  return {
    store,
    putCalls,
    kv: {
      get: async (key: string, type?: string) => {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      put: async (key: string, value: string, opts?: unknown) => {
        putCalls.push({ key, value: JSON.parse(value), opts: opts ?? null });
        store.set(key, value);
      },
      delete: async () => {},
      list: async () => ({ keys: [], cursor: "", list_complete: true }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const fakeList = { id: 9, name: "Lista 6720", totalSubscribers: 300 };

function makeCampaign(id: number, ageMs: number) {
  const sentDate = new Date(Date.now() - ageMs).toISOString();
  return {
    id, name: `Campanha ${id}`, subject: "s", status: "sent",
    sentDate, scheduledAt: null, createdAt: sentDate,
    recipients: { lists: [9] },
    statistics: { campaignStats: [] },
  };
}

const fakeGs: BrevoGlobalStats = {
  sent: 200, delivered: 190, hardBounces: 3, softBounces: 1,
  uniqueViews: 60, viewed: 65, trackableViews: 50, uniqueClicks: 12,
  clickers: 10, unsubscriptions: 1, complaints: 0, appleMppOpens: 4,
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ─── (A) resolveRecentStatsTtl — função pura ───────────────────────────────

describe("resolveRecentStatsTtl (#6720 Fatia C) — faixas de idade puras", () => {
  test("<48h → RECENT_STATS_TTL", () => {
    const now = Date.now();
    const sentDate = new Date(now - 10 * HOUR).toISOString();
    assert.strictEqual(resolveRecentStatsTtl(sentDate, now), RECENT_STATS_TTL);
  });

  test("exatamente 47h59min → ainda RECENT_STATS_TTL (boundary inferior)", () => {
    const now = Date.now();
    const sentDate = new Date(now - (48 * HOUR - 60_000)).toISOString();
    assert.strictEqual(resolveRecentStatsTtl(sentDate, now), RECENT_STATS_TTL);
  });

  test("exatamente 48h → MID_RANGE_STATS_TTL (boundary vira faixa morna)", () => {
    const now = Date.now();
    const sentDate = new Date(now - 48 * HOUR).toISOString();
    assert.strictEqual(resolveRecentStatsTtl(sentDate, now), MID_RANGE_STATS_TTL);
  });

  test("3 dias (dentro de 2-7d) → MID_RANGE_STATS_TTL", () => {
    const now = Date.now();
    const sentDate = new Date(now - 3 * DAY).toISOString();
    assert.strictEqual(resolveRecentStatsTtl(sentDate, now), MID_RANGE_STATS_TTL);
  });

  test("6.9 dias (ainda não imutável) → MID_RANGE_STATS_TTL", () => {
    const now = Date.now();
    const sentDate = new Date(now - 6.9 * DAY).toISOString();
    assert.strictEqual(resolveRecentStatsTtl(sentDate, now), MID_RANGE_STATS_TTL);
  });

  test("sentDate null → RECENT_STATS_TTL (default conservador, espelha isImmutableCampaign)", () => {
    assert.strictEqual(resolveRecentStatsTtl(null), RECENT_STATS_TTL);
  });

  test("sentDate inválido (não-parseável) → RECENT_STATS_TTL", () => {
    assert.strictEqual(resolveRecentStatsTtl("não-é-uma-data"), RECENT_STATS_TTL);
  });

  test("MID_RANGE_STATS_TTL > RECENT_STATS_TTL (a faixa morna é mais longa, não mais curta)", () => {
    assert.ok(MID_RANGE_STATS_TTL > RECENT_STATS_TTL);
  });
});

// ─── (B) includeLinksStats=false — pula o 2º GET sob demanda ──────────────

describe("fetchRecentCampaigns — includeLinksStats=false (#6720 Fatia C, Refs #7007)", () => {
  test("sem cache: NÃO faz o GET de linksStats (só listing + globalStats)", async () => {
    const { kv } = makeKvMock({ "list:9": fakeList });
    const campaign = makeCampaign(101, 1 * DAY);
    let lsCalled = false;
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [campaign] } as T;
      if (/emailCampaigns\/101\?statistics=globalStats/.test(path)) {
        return { ...campaign, statistics: { globalStats: fakeGs } } as T;
      }
      if (/emailCampaigns\/101\?statistics=linksStats/.test(path)) {
        lsCalled = true;
        return { ...campaign, statistics: { linksStats: { "https://x/y": 4 } } } as T;
      }
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, mockFetch as any, false, /* includeLinksStats */ false,
    );
    assert.strictEqual(lsCalled, false, "GET de linksStats não deve ocorrer quando includeLinksStats=false");
    assert.strictEqual(result[0].statistics?.globalStats?.sent, 200, "globalStats continua sendo buscado normalmente");
    assert.strictEqual(result[0].statistics?.linksStats, undefined, "linksStats fica ausente no resultado deste render");
  });

  test("payload gravado NÃO tem lsPending:true (não pode mentir pro próximo render que precisa de ls)", async () => {
    const { kv, putCalls } = makeKvMock({ "list:9": fakeList });
    const campaign = makeCampaign(102, 1 * DAY);
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [campaign] } as T;
      if (/emailCampaigns\/102\?statistics=globalStats/.test(path)) {
        return { ...campaign, statistics: { globalStats: fakeGs } } as T;
      }
      throw new Error("path inesperado (linksStats NÃO deveria ser chamado): " + path);
    };
    await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, mockFetch as any, false, false,
    );
    const statsPut = putCalls.find((p) => p.key === "stats:102");
    assert.ok(statsPut, "gs foi buscado pela 1ª vez -- deve gravar stats:102");
    const payload = statsPut!.value as Record<string, unknown>;
    assert.strictEqual(payload.lsPending, undefined,
      "payload NÃO deve conter lsPending:true -- ls nunca foi tentado (skip deliberado, não falha)");
    assert.strictEqual(payload.ls, undefined, "payload não deve conter ls (nunca buscado)");
    assert.ok("gs" in payload, "gs deve estar presente no payload");
  });

  test("gs já cacheado + includeLinksStats=false → NENHUM write no KV (nada mudou)", async () => {
    const { kv, putCalls } = makeKvMock({
      "list:9": fakeList,
      "stats:103": { gs: fakeGs }, // gs cacheado, sem ls nem lsPending — estado "nunca tentado"
    });
    const campaign = makeCampaign(103, 1 * DAY);
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [campaign] } as T;
      throw new Error("nenhum GET de stats deveria ocorrer (tudo em cache/pulado): " + path);
    };
    const result = await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, mockFetch as any, false, false,
    );
    assert.strictEqual(result[0].statistics?.globalStats?.sent, 200, "gs vem do cache normalmente");
    const statsPut = putCalls.find((p) => p.key === "stats:103");
    assert.strictEqual(statsPut, undefined,
      "nenhum write deveria ocorrer -- gs já estava em cache e ls foi deliberadamente pulado (nada mudou)");
  });

  test("render com includeLinksStats=false NUNCA bloqueia um render POSTERIOR que precisa de ls", async () => {
    // Simula exatamente o cenário real: /api/campaigns (includeLinksStats=false)
    // roda primeiro (ex: Diaria-Clarice-Envio); depois a rota "/" (includeLinksStats
    // default=true) precisa da seção de links agregados para a MESMA campanha.
    const { kv } = makeKvMock({ "list:9": fakeList });
    const campaign = makeCampaign(104, 1 * DAY);
    const realLs: BrevoLinksStats = { "https://diar.ia/post": 7 };
    let lsCallCount = 0;
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [campaign] } as T;
      if (/emailCampaigns\/104\?statistics=globalStats/.test(path)) {
        return { ...campaign, statistics: { globalStats: fakeGs } } as T;
      }
      if (/emailCampaigns\/104\?statistics=linksStats/.test(path)) {
        lsCallCount++;
        return { ...campaign, statistics: { linksStats: realLs } } as T;
      }
      throw new Error("path inesperado: " + path);
    };

    // 1º render: /api/campaigns-like, sem linksStats.
    const r1 = await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, mockFetch as any, false, false,
    );
    assert.strictEqual(r1[0].statistics?.linksStats, undefined);
    assert.strictEqual(lsCallCount, 0);

    // 2º render: rota "/"-like, precisa de linksStats -- NÃO pode ficar bloqueado
    // por nenhum sentinela indevido gravado pelo 1º render.
    const r2 = await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, mockFetch as any, false, true,
    );
    assert.strictEqual(lsCallCount, 1, "o 2º render deve conseguir buscar o ls que o 1º pulou");
    assert.deepStrictEqual(r2[0].statistics?.linksStats, realLs,
      "linksStats deve vir populado no render que de fato precisa dele");
  });
});

// ─── (C) includeLinksStats=true (default) — guarda contra reabrir #2177 ──

describe("fetchRecentCampaigns — includeLinksStats=true (default, rota '/'/Studio) — guarda #2177", () => {
  test("continua fazendo os 2 GETs e a seção de links vem com cliques REAIS (não zerados)", async () => {
    // Espelha o cenário do #2177/#2249: ?statistics=combined viria com
    // linksStats zerado; o GET separado (?statistics=linksStats) traz os
    // cliques reais. Esta fatia NÃO pode reabrir essa regressão para quem
    // não passa includeLinksStats (default true).
    const { kv } = makeKvMock({ "list:9": fakeList });
    const campaign = makeCampaign(105, 1 * DAY);
    const realLs: BrevoLinksStats = { "https://diar.ia/a": 9, "https://exemplo.com/b": 2 };
    let gsCalled = false;
    let lsCalled = false;
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [campaign] } as T;
      if (/emailCampaigns\/105\?statistics=globalStats/.test(path)) {
        gsCalled = true;
        return { ...campaign, statistics: { globalStats: fakeGs } } as T;
      }
      if (/emailCampaigns\/105\?statistics=linksStats/.test(path)) {
        lsCalled = true;
        return { ...campaign, statistics: { linksStats: realLs } } as T;
      }
      throw new Error("path inesperado: " + path);
    };
    // Sem os 2 últimos argumentos -- default includeLinksStats=true.
    const result = await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as any,
      20, false, mockFetch as any,
    );
    assert.strictEqual(gsCalled, true);
    assert.strictEqual(lsCalled, true, "linksStats DEVE ser buscado quando includeLinksStats=true (default)");
    assert.deepStrictEqual(result[0].statistics?.linksStats, realLs,
      "seção de links deve vir com os cliques reais -- não pode voltar a ficar sempre vazia (#2177)");
  });
});

// ─── (D) TTL por faixa de idade no KV write ────────────────────────────────

describe("fetchRecentCampaigns — TTL por faixa de idade no write de stats:{id} (#6720 Fatia C)", () => {
  test("campanha de 3 dias (2-7d), gs+ls saudáveis → grava com MID_RANGE_STATS_TTL", async () => {
    const { kv, putCalls } = makeKvMock({ "list:9": fakeList });
    const campaign = makeCampaign(201, 3 * DAY);
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [campaign] } as T;
      if (/emailCampaigns\/201\?statistics=globalStats/.test(path)) return { ...campaign, statistics: { globalStats: fakeGs } } as T;
      if (/emailCampaigns\/201\?statistics=linksStats/.test(path)) return { ...campaign, statistics: { linksStats: { "https://x/y": 2 } } } as T;
      throw new Error("path inesperado: " + path);
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    const statsPut = putCalls.find((p) => p.key === "stats:201");
    assert.strictEqual((statsPut?.opts as any)?.expirationTtl, MID_RANGE_STATS_TTL,
      "campanha 2-7d saudável deve usar MID_RANGE_STATS_TTL, não RECENT_STATS_TTL nem permanente");
  });

  test("campanha de 1 dia (<48h), gs+ls saudáveis → grava com RECENT_STATS_TTL (frescor preservado)", async () => {
    const { kv, putCalls } = makeKvMock({ "list:9": fakeList });
    const campaign = makeCampaign(202, 1 * DAY);
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [campaign] } as T;
      if (/emailCampaigns\/202\?statistics=globalStats/.test(path)) return { ...campaign, statistics: { globalStats: fakeGs } } as T;
      if (/emailCampaigns\/202\?statistics=linksStats/.test(path)) return { ...campaign, statistics: { linksStats: { "https://x/y": 2 } } } as T;
      throw new Error("path inesperado: " + path);
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    const statsPut = putCalls.find((p) => p.key === "stats:202");
    assert.strictEqual((statsPut?.opts as any)?.expirationTtl, RECENT_STATS_TTL,
      "campanha <48h deve continuar com RECENT_STATS_TTL -- é a faixa onde frescor importa de fato");
  });

  test("campanha de 3 dias (2-7d) com linksStats poison → RECENT_STATS_TTL, NÃO MID_RANGE (auto-cura rápida vence a faixa etária)", async () => {
    const { kv, putCalls } = makeKvMock({ "list:9": fakeList });
    const campaign = makeCampaign(203, 3 * DAY);
    // clickers>0 mas todos os links com 0 clicks -- assinatura de poison (#2273).
    const poisonedLs: BrevoLinksStats = { "https://diar.ia/z": 0, "https://outro.com/w": 0 };
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [campaign] } as T;
      if (/emailCampaigns\/203\?statistics=globalStats/.test(path)) return { ...campaign, statistics: { globalStats: fakeGs } } as T;
      if (/emailCampaigns\/203\?statistics=linksStats/.test(path)) return { ...campaign, statistics: { linksStats: poisonedLs } } as T;
      throw new Error("path inesperado: " + path);
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    const statsPut = putCalls.find((p) => p.key === "stats:203");
    assert.strictEqual((statsPut?.opts as any)?.expirationTtl, RECENT_STATS_TTL,
      "poison deve sempre auto-curar com RECENT_STATS_TTL, mesmo numa campanha na faixa 2-7d (não pode ficar 4h envenenada)");
  });

  test("campanha de 3 dias (2-7d) com ls-fetch falho → RECENT_STATS_TTL, NÃO MID_RANGE (mesma lógica de auto-cura)", async () => {
    const { kv, putCalls } = makeKvMock({ "list:9": fakeList });
    const campaign = makeCampaign(204, 3 * DAY);
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [campaign] } as T;
      if (/emailCampaigns\/204\?statistics=globalStats/.test(path)) return { ...campaign, statistics: { globalStats: fakeGs } } as T;
      if (/emailCampaigns\/204\?statistics=linksStats/.test(path)) throw new Error("429 simulado");
      throw new Error("path inesperado: " + path);
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    const statsPut = putCalls.find((p) => p.key === "stats:204");
    assert.strictEqual((statsPut?.opts as any)?.expirationTtl, RECENT_STATS_TTL,
      "ls-fetch falho numa campanha 2-7d deve reter RECENT_STATS_TTL para reter tentar em breve, não esperar 4h");
  });

  test("campanha imutável (>7d) continua sem TTL (permanente) -- corte de 7d intocado", async () => {
    const { kv, putCalls } = makeKvMock({ "list:9": fakeList });
    const campaign = makeCampaign(205, 10 * DAY);
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [campaign] } as T;
      if (/emailCampaigns\/205\?statistics=globalStats/.test(path)) return { ...campaign, statistics: { globalStats: fakeGs } } as T;
      if (/emailCampaigns\/205\?statistics=linksStats/.test(path)) return { ...campaign, statistics: { linksStats: { "https://x/y": 5 } } } as T;
      throw new Error("path inesperado: " + path);
    };
    await fetchRecentCampaigns({ BREVO_API_KEY: "t", STATS_CACHE: kv } as any, 20, false, mockFetch as any);
    const statsPut = putCalls.find((p) => p.key === "stats:205");
    assert.deepStrictEqual(statsPut?.opts, {}, "campanha >7d saudável continua permanente (sem expirationTtl) -- #6720 não move este corte");
  });
});
