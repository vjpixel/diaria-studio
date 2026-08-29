/**
 * test/brevo-dashboard-studio-skip-kv-cache-4186.test.ts (#4186)
 *
 * Achado no review consolidado do PR #4183: `buildEnv()` do Studio
 * (`scripts/studio-ui/dashboard-clarice.ts`) passou a ligar `STATS_CACHE` ao
 * namespace KV REAL de produção (`RemoteKvNamespace`, #4165/#4173). Isso é
 * correto para as 3 seções que o #4165/#4173 pediram (cohorts/couponUsage/
 * eiaEngagement, via `readKvTabs`) -- mas o MESMO `env.STATS_CACHE` também é
 * consumido, sem nenhuma mudança nesta PR, por `fetchRecentCampaigns`
 * (`list:{id}`/`stats:{id}`), `fetchScheduledCampaigns` (`list:{id}`) e
 * `fetchPlanCredits` (`brevo:plan-credits`) -- que passaram a ler/escrever o
 * KV COMPARTILHADO de produção toda vez que o editor abre o painel Clarice
 * do Studio, sem nenhuma coordenação (`tryAcquireRefreshLock`/
 * `coalesceRefresh` só existem em index.ts). Medido: até ~100 GETs na Brevo
 * por abertura, contribuindo pro incidente de rate-limit do #4187.
 *
 * Fix (#4186, opção 1 da issue): parâmetro `skipKvCache` nas 3 funções --
 * quando `true`, pula leitura E escrita de `list:*`/`stats:*`/
 * `brevo:plan-credits` no KV (o fetch ao vivo à Brevo continua acontecendo
 * normalmente). `false` (default) preserva o Worker de produção EXATAMENTE
 * como antes -- nenhum call site de produção passa isso.
 *
 * Esta suíte prova o MECANISMO (as 3 funções, via KV mock instrumentado com
 * spies) -- a validação de que `dashboard-clarice.ts` de fato PASSA
 * `skipKvCache: true` nas 3 chamadas é feita por inspeção de fonte (mesmo
 * padrão já usado em brevo-dashboard-studio-kv-adapter-4165-4173.test.ts
 * describe "(d)", que testa esse MESMO arquivo pelo mesmo motivo: montar o
 * pipeline completo do Studio exige Brevo real + SQLite real, e o próprio
 * test/studio-dashboard-panels.test.ts já documenta essa decisão
 * explicitamente).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  fetchRecentCampaigns,
  fetchScheduledCampaigns,
  fetchPlanCredits,
} from "../workers/brevo-dashboard/src/index.ts";

function makeSpyKv(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial));
  const getCalls: string[] = [];
  const putCalls: string[] = [];
  return {
    getCalls,
    putCalls,
    kv: {
      get: async (key: string, type?: string) => {
        getCalls.push(key);
        const v = store.get(key);
        if (v == null) return null;
        return type === "json" ? v : JSON.stringify(v);
      },
      put: async (key: string, value: string) => {
        putCalls.push(key);
        store.set(key, JSON.parse(value));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const fakeList = { id: 9, name: "Lista Teste 4186", totalSubscribers: 200 };
const fakeGlobalStats = {
  sent: 50, delivered: 48, hardBounces: 1, softBounces: 0,
  uniqueViews: 20, viewed: 22, trackableViews: 18, uniqueClicks: 5,
  clickers: 4, unsubscriptions: 0, complaints: 0, appleMppOpens: 2,
};
const sentDateOld = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
const fakeCampaign = {
  id: 4186, name: "Campanha teste #4186", subject: "s", status: "sent",
  sentDate: sentDateOld, scheduledAt: null, createdAt: sentDateOld,
  recipients: { lists: [9] },
};

describe("fetchRecentCampaigns — skipKvCache (#4186)", () => {
  it("skipKvCache:true → ZERO get/put no KV compartilhado, mesmo com dado já cacheado", async () => {
    const { kv, getCalls, putCalls } = makeSpyKv({
      "list:9": fakeList,
      "stats:4186": { gs: fakeGlobalStats },
    });
    let brevoCalls = 0;
    const mockFetch = async <T>(pathArg: string): Promise<T> => {
      brevoCalls++;
      if (pathArg.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (pathArg.includes("contacts/lists/9")) return fakeList as T;
      if (/emailCampaigns\/4186\?statistics=globalStats/.test(pathArg)) return { ...fakeCampaign, statistics: { globalStats: fakeGlobalStats } } as T;
      if (/emailCampaigns\/4186\?statistics=linksStats/.test(pathArg)) return { ...fakeCampaign, statistics: { linksStats: {} } } as T;
      throw new Error("path inesperado: " + pathArg);
    };
    const result = await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as never,
      20,
      false,
      mockFetch as never,
      true, // skipKvCache
    );
    assert.deepStrictEqual(getCalls, [], "skipKvCache:true não deve ler NENHUMA chave do KV compartilhado");
    assert.deepStrictEqual(putCalls, [], "skipKvCache:true não deve escrever NENHUMA chave no KV compartilhado");
    assert.ok(brevoCalls > 1, "o fetch ao vivo à Brevo continua acontecendo (Studio ainda precisa do dado)");
    assert.strictEqual(result[0]?.id, 4186);
    assert.strictEqual(result[0]?.statistics?.globalStats?.sent, 50, "dado real da Brevo, não do cache pulado");
  });

  it("skipKvCache:false (default) preserva o comportamento de produção (KV consultado normalmente)", async () => {
    const { kv, getCalls } = makeSpyKv({ "stats:4186": { gs: fakeGlobalStats }, "list:9": fakeList });
    const mockFetch = async <T>(pathArg: string): Promise<T> => {
      if (pathArg.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      throw new Error("não devia chamar a Brevo — KV já tem tudo cacheado: " + pathArg);
    };
    const result = await fetchRecentCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as never,
      20,
      false,
      mockFetch as never,
      // skipKvCache omitido → false, produção
    );
    assert.ok(getCalls.includes("stats:4186"), "produção (default) DEVE consultar o KV normalmente");
    assert.strictEqual(result[0]?.statistics?.globalStats?.sent, 50, "veio do KV, sem chamar a Brevo de novo");
  });
});

describe("fetchScheduledCampaigns — skipKvCache (#4186)", () => {
  it("skipKvCache:true → ZERO get/put em list:{id} no KV compartilhado", async () => {
    const { kv, getCalls, putCalls } = makeSpyKv({ "list:9": fakeList });
    const queued = { ...fakeCampaign, status: "queued", sentDate: null, scheduledAt: "2026-08-01T09:00:00Z" };
    const mockFetch = async <T>(pathArg: string): Promise<T> => {
      if (pathArg.includes("emailCampaigns?status=queued")) return { campaigns: [queued] } as T;
      if (pathArg.includes("contacts/lists/9")) return fakeList as T;
      throw new Error("path inesperado: " + pathArg);
    };
    const result = await fetchScheduledCampaigns(
      { BREVO_API_KEY: "t", STATS_CACHE: kv } as never,
      50,
      false,
      mockFetch as never,
      true, // skipKvCache
    );
    assert.deepStrictEqual(getCalls, [], "skipKvCache:true não deve ler list:{id} do KV compartilhado");
    assert.deepStrictEqual(putCalls, [], "skipKvCache:true não deve escrever list:{id} no KV compartilhado");
    assert.strictEqual(result[0]?.listName, "Lista Teste 4186", "nome da lista ainda resolvido, via fetch ao vivo");
  });
});

describe("fetchPlanCredits — skipKvCache (#4186)", () => {
  it("skipKvCache:true → ZERO get/put em brevo:plan-credits, mas o fetch ao vivo continua (Studio precisa do valor)", async () => {
    const { kv, getCalls, putCalls } = makeSpyKv({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env: any = {
      STATS_CACHE: kv,
      BREVO_API_KEY: "t",
    };
    // brevoFetch usa fetch global — mocka só pra este teste.
    const realFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = (async (url: string) => {
      assert.match(String(url), /\/v3\/account$/);
      return new Response(JSON.stringify({ plan: [{ creditsType: "sendLimit", credits: 12345 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      const credits = await fetchPlanCredits(env, "cached", true /* skipKvCache */);
      assert.strictEqual(credits, 12345, "valor real da Brevo, mesmo com skipKvCache");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepStrictEqual(getCalls, [], "skipKvCache:true não deve ler brevo:plan-credits");
    assert.deepStrictEqual(putCalls, [], "skipKvCache:true não deve escrever brevo:plan-credits");
  });

  it("skipKvCache:false (default) preserva o cache-aside de produção", async () => {
    const { kv, getCalls } = makeSpyKv({ "brevo:plan-credits": { credits: 999 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env: any = { STATS_CACHE: kv, BREVO_API_KEY: "t" };
    const realFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = (async () => {
      throw new Error("não devia chamar a Brevo — KV (produção, mode=cached) já tem valor");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      const credits = await fetchPlanCredits(env, "cached");
      assert.strictEqual(credits, 999, "veio do KV (produção honra cache-aside)");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(getCalls.includes("brevo:plan-credits"));
  });
});

// ---------------------------------------------------------------------------
// Wiring: dashboard-clarice.ts de fato passa skipKvCache:true nas 3 chamadas,
// e reusa buildRateLimitFallback (não mais a tela de erro em branco) no
// catch de BrevoRateLimitError. Inspeção de fonte -- mesmo padrão já
// estabelecido em brevo-dashboard-studio-kv-adapter-4165-4173.test.ts pra
// este MESMO arquivo (montar o pipeline completo exige Brevo+SQLite reais).
// ---------------------------------------------------------------------------

describe("dashboard-clarice.ts — wiring de skipKvCache + fallback last-good (#4186/#4187)", () => {
  const srcPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../scripts/studio-ui/dashboard-clarice.ts",
  );
  const src = readFileSync(srcPath, "utf-8");

  // #6720 Fatia A: as 3 chamadas trocaram `skipKvCache: true` (que desligava
  // o cache-aside inteiro, forçando fetch ao vivo sempre) por
  // `skipKvCache: false` + um `env` sombreado (`campaignCacheEnv`) cujo
  // `STATS_CACHE` é o cache LOCAL em arquivo (`createLocalFileCampaignCache`),
  // não o KV real de produção. O invariante do #4186 (nunca tocar o KV
  // COMPARTILHADO) continua valendo — só muda de "cache totalmente desligado"
  // para "cache local, isolado da produção" (ver
  // test/clarice-studio-campaign-cache.test.ts pro mecanismo do adapter e o
  // describe "wiring: env sombreado nunca usa o STATS_CACHE de produção"
  // abaixo pra prova de que `campaignCacheEnv` não é o `env` de produção).

  it("fetchPlanCredits é chamado com campaignCacheEnv + skipKvCache:false (3º argumento)", () => {
    assert.match(src, /fetchPlanCredits\(campaignCacheEnv,\s*"cached",\s*false\)/);
  });

  it("fetchScheduledCampaigns é chamado com campaignCacheEnv + skipKvCache:false (5º argumento)", () => {
    assert.match(src, /fetchScheduledCampaigns\(campaignCacheEnv,\s*50,\s*false,\s*undefined,\s*false\)/);
  });

  it("fetchRecentCampaigns é chamado com campaignCacheEnv + skipKvCache:false (5º argumento)", () => {
    assert.match(src, /fetchRecentCampaigns\(campaignCacheEnv,\s*CAMPAIGNS_FETCH_LIMIT,\s*false,\s*undefined,\s*false\)/);
  });

  it("campaignCacheEnv sombreia STATS_CACHE com o cache LOCAL, não o KV real de produção", () => {
    assert.match(
      src,
      /const campaignCacheEnv: Env = \{ \.\.\.env, STATS_CACHE: localCampaignCache as unknown as Env\["STATS_CACHE"\] \}/,
    );
  });

  it("catch de BrevoRateLimitError usa buildRateLimitFallback (não mais uma tela de erro em branco)", () => {
    assert.match(src, /buildRateLimitFallback\(env,\s*e\.retryAfterSecs,\s*planCredits\)/);
    assert.match(src, /import\s*\{[^}]*buildRateLimitFallback[^}]*\}\s*from\s*["']\.\.\/\.\.\/workers\/brevo-dashboard\/src\/brevo-api\.ts["']/);
  });

  it("não referencia mais a antiga tela de erro em branco de rate-limit (rateLimitedHtml)", () => {
    assert.doesNotMatch(src, /function rateLimitedHtml/);
  });
});
