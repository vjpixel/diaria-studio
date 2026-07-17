/**
 * test/brevo-dashboard-3653-limit-trycatch.test.ts (#3653)
 *
 * Regressão de 2 achados de baixa severidade do review consolidado 1.5b
 * (overnight 260717), mesma área (workers/brevo-dashboard):
 *
 * Achado 1 — `GET /api/campaigns?limit=0` ainda virava 20 no Worker. O #3643
 * minor-2 (PR #3648) corrigiu o lado CLIENTE (`scripts/clarice-schedule-ramp.ts`,
 * `resolveDashboardLimit`) pra respeitar `--dashboard-limit 0` explícito, mas
 * `workers/brevo-dashboard/src/index.ts` continuava com o padrão idêntico de
 * falsy-zero (`Number(raw ?? "20") || 20`), então o fix do cliente não tinha
 * efeito observável fim-a-fim: o Worker recebia `limit=0` explícito e mesmo
 * assim pedia 20 campanhas à Brevo. Fix: `resolveCampaignsLimitParam`
 * (`Number.isFinite` em vez de `||`), espelhando `resolveDashboardLimit`.
 *
 * Achado 2 — `buildDashboardResponse` tinha o bloco de lock-acquire +
 * inflight-fallback (`tryAcquireRefreshLock`/`buildInflightCoalescedFallback`)
 * FORA do try/finally da função — diferente de `buildCampaignsResponse`
 * (mesma extração do #3644), que já tinha o bloco equivalente DENTRO do
 * try/finally. Verificado como não-alcançável na prática (tudo que
 * `buildInflightCoalescedFallback` toca já é blindado por `.catch`/try-catch
 * internos), mas a assimetria estrutural deixava uma exceção genuína nesse
 * trecho escapar do catch(502)/finally(release lock) da função, propagando
 * sem tratamento pelo call site (`coalesceRefresh`). Fix: mover o bloco pra
 * dentro do try, espelhando `buildCampaignsResponse`.
 *
 * Fixtures 100% sintéticas — nenhum id/email real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, {
  resolveCampaignsLimitParam,
  REFRESH_LOCK_KEY_PREFIX,
  LASTGOOD_CAMPAIGNS_KEY,
  CAMPAIGNS_FETCH_LIMIT,
} from "../workers/brevo-dashboard/src/index.ts";

// Cache API -- mesmo polyfill das outras suítes de brevo-dashboard: sempre
// cache-miss, força o caminho de live-fetch em toda chamada.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).caches = {
  default: {
    match: async (_req: unknown) => null,
    put: async (_req: unknown, _res: unknown) => {},
  },
};

const TOKEN = "3653-test-token";
const COOKIE = `cf-dash-auth=${TOKEN}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEnv(kv: any) {
  return { BREVO_API_KEY: "k", STATS_CACHE: kv, AUTH_TOKEN: TOKEN };
}

const sentDateOld = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const fakeCampaign = {
  id: 999,
  name: "Camp Teste 3653",
  subject: "Assunto",
  status: "sent",
  sentDate: sentDateOld,
  scheduledAt: null,
  createdAt: sentDateOld,
  recipients: { lists: [] as number[] },
};
const fakeGlobalStats = {
  sent: 10,
  delivered: 9,
  hardBounces: 0,
  softBounces: 0,
  uniqueViews: 4,
  viewed: 4,
  trackableViews: 3,
  uniqueClicks: 1,
  clickers: 1,
  unsubscriptions: 0,
  complaints: 0,
  appleMppOpens: 0,
};

function mockBrevoFetch() {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes("emailCampaigns?status=sent")) {
      return new Response(JSON.stringify({ campaigns: [fakeCampaign] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("emailCampaigns?status=queued")) {
      return new Response(JSON.stringify({ campaigns: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/v3/account")) {
      return new Response(JSON.stringify({ plan: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("emailCampaigns/999")) {
      return new Response(
        JSON.stringify({ ...fakeCampaign, statistics: { globalStats: fakeGlobalStats } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

// ---------------------------------------------------------------------------
// Achado 1 -- resolveCampaignsLimitParam (unidade, pura)
// ---------------------------------------------------------------------------
describe("resolveCampaignsLimitParam (#3653 achado 1)", () => {
  it("raw ausente (null) -> fallback default (20)", () => {
    assert.equal(resolveCampaignsLimitParam(null), 20);
  });

  it('raw="0" explícito -> 0 (bug original: Number("0") || 20 colapsava silenciosamente pra 20)', () => {
    assert.equal(resolveCampaignsLimitParam("0"), 0);
  });

  it('raw="30" -> 30', () => {
    assert.equal(resolveCampaignsLimitParam("30"), 30);
  });

  it("raw não-numérico -> fallback", () => {
    assert.equal(resolveCampaignsLimitParam("abc"), 20);
  });

  it("fallback customizado é respeitado quando raw ausente", () => {
    assert.equal(resolveCampaignsLimitParam(null, 5), 5);
  });
});

// ---------------------------------------------------------------------------
// Achado 1 -- rota /api/campaigns?limit=0 fim-a-fim (o Worker de fato pede
// limit=0 upstream, não 20 silenciosamente)
// ---------------------------------------------------------------------------
describe("GET /api/campaigns?limit=0 (#3653 achado 1)", () => {
  it("Worker chama a Brevo com limit=0 na URL -- não cai no fallback 20", async () => {
    const capturedUrls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      capturedUrls.push(String(url));
      return mockBrevoFetch()(url);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      const req = new Request("http://localhost/api/campaigns?limit=0");
      const res = await worker.fetch(req, makeEnv(undefined));
      assert.equal(res.status, 200);
      const listingCall = capturedUrls.find((u) => u.includes("/v3/emailCampaigns?status=sent"));
      assert.ok(listingCall, "deveria ter chamado a listagem de campanhas da Brevo");
      assert.ok(
        listingCall!.includes("limit=0"),
        `esperado limit=0 na URL pedida à Brevo (Worker deve respeitar o 0 explícito) -- veio: ${listingCall}`,
      );
      assert.ok(
        !listingCall!.includes("limit=20"),
        `NÃO deveria ter caído no fallback 20 (bug pré-fix) -- veio: ${listingCall}`,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("sem ?limit= (ausente) -- comportamento antigo preservado: cai no default 20", async () => {
    const capturedUrls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      capturedUrls.push(String(url));
      return mockBrevoFetch()(url);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      const req = new Request("http://localhost/api/campaigns");
      const res = await worker.fetch(req, makeEnv(undefined));
      assert.equal(res.status, 200);
      const listingCall = capturedUrls.find((u) => u.includes("/v3/emailCampaigns?status=sent"));
      assert.ok(listingCall!.includes("limit=20"), `esperado default 20 sem ?limit= explícito -- veio: ${listingCall}`);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Achado 2 -- try/catch assimétrico em buildDashboardResponse
// ---------------------------------------------------------------------------
describe("buildDashboardResponse -- lock-acquire + inflight-fallback dentro do try (#3653 achado 2)", () => {
  /**
   * KV mock que simula "outro isolate segura o lock" (força o caminho
   * buildInflightCoalescedFallback) + "stale bom presente" (passa do guard
   * `if (!staleCampaignsRaw) return null`), mas faz QUALQUER outra leitura de
   * KV (as 4 abas lidas por readKvTabs: cohorts/mv/contacts/eia) lançar
   * SINCRONAMENTE -- não uma Promise rejeitada (que já seria pega pelo
   * `.catch(() => null)` encadeado em cada leitura dentro de readKvTabs), mas
   * uma exceção síncrona levantada ANTES do `.catch` conseguir se acoplar.
   * Isso reproduz fielmente uma "quebra futura" hipotética em qualquer código
   * chamado por buildInflightCoalescedFallback -- exatamente o cenário que o
   * achado 2 descreve como "hoje não alcançável, mas a assimetria estrutural
   * deixaria escapar sem tratamento".
   */
  function makeThrowingKvMock() {
    const lockKey = `${REFRESH_LOCK_KEY_PREFIX}/`;
    const lastgoodPayload = JSON.stringify({
      campaigns: [fakeCampaign],
      scheduled: [],
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
      campaignsLimit: CAMPAIGNS_FETCH_LIMIT,
    });
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get: (key: string, type?: string): any => {
        if (key === lockKey) return Promise.resolve("outro-isolate-qualquer");
        if (key === LASTGOOD_CAMPAIGNS_KEY) {
          return Promise.resolve(type === "json" ? JSON.parse(lastgoodPayload) : lastgoodPayload);
        }
        // Qualquer outra chave (cohorts/mv/contacts/eia/coupons): throw SÍNCRONO,
        // simula uma quebra futura em código hoje blindado.
        throw new Error("[#3653 test] simulated synchronous KV crash inside readKvTabs");
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], cursor: "", list_complete: true }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    };
  }

  it("exceção síncrona dentro do bloco de inflight-fallback é capturada -- resposta 502 graciosa, não uma rejection não-tratada", async () => {
    const kv = makeThrowingKvMock();
    const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });

    // Não deve LANÇAR -- se a estrutura voltasse a ficar assimétrica (bloco
    // fora do try), esta chamada rejeitaria em vez de resolver, e o `await`
    // abaixo propagaria a exceção pro teste (falhando com erro não-tratado
    // em vez da asserção de status/corpo abaixo).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await worker.fetch(req, makeEnv(kv as any));

    assert.equal(res.status, 502, "exceção dentro do bloco de fallback deve degradar pra 502, não propagar sem tratamento");
    const text = await res.text();
    assert.ok(
      text.includes("simulated synchronous KV crash"),
      `corpo do 502 deveria conter a mensagem do erro capturado -- veio: ${text}`,
    );
  });
});
