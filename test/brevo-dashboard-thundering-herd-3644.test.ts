/**
 * test/brevo-dashboard-thundering-herd-3644.test.ts (#3644)
 *
 * Regressão: #3553 removeu o Cron Trigger do `brevo-dashboard`, convertendo a
 * rota `/` (e `/api/campaigns`) de "KV-first, refrescada por cron" pra "sempre
 * live-fetch em cache-miss, write-through em `dash:lastgood:campaigns`". O
 * comentário do #3553 dizia que o cache de borda 5min (`caches.default`)
 * bastava pra limitar isso a "1 fetch real a cada 5min mesmo com múltiplos
 * visitantes" -- mas `caches.default` é PER-COLO, não global: duas requests
 * concorrentes (colos diferentes, ou uma chegando antes do `cache.put()` da
 * outra resolver) veem cache-miss cada uma e disparam a sequência completa de
 * live-fetch (~150 chamadas Brevo), multiplicando o volume além do prometido
 * e reintroduzindo o risco de rate-limit já registrado como incidente de
 * produção anterior (memória do projeto: brevo-hourly-ratelimit.md).
 *
 * `test/brevo-dashboard-request-refresh-3553.test.ts` (teste do #3553) só
 * mocka `caches.default.match` retornando `null` sequencialmente -- nunca
 * exercita requests verdadeiramente CONCORRENTES, então não cobria essa race.
 *
 * Fix (#3644), 2 camadas:
 *
 *   1. `coalesceRefresh` (brevo-api.ts) — Map em memória, PRIMÁRIA e
 *      DETERMINÍSTICA: `Map.get`/`Map.set` são síncronos, sem `await` entre
 *      o check e o set, então não existe janela de corrida possível DENTRO
 *      do mesmo isolate (JS é single-threaded). Cobre o caso mais comum:
 *      requests concorrentes no mesmo isolate/colo.
 *
 *   2. `tryAcquireRefreshLock`/`releaseRefreshLock` (KV) — SEGUNDA linha,
 *      best-effort, pra requests que caem em isolates/colos DIFERENTES (fora
 *      do alcance do Map em memória). KV não tem compare-and-swap, então
 *      ESTA camada sozinha NÃO garante exclusão mútua sob corrida real —
 *      validado empiricamente durante o self-review desta PR: uma tentativa
 *      anterior de fechar essa janela via token+readback no KV não resolvia
 *      a corrida de forma confiável sob o scheduling real de microtasks do
 *      V8/Node (2 chamadas concorrentes a `tryAcquireRefreshLock` sozinho,
 *      SEM o Map por cima, ainda podem as 2 retornar `true`). Por isso a
 *      suíte abaixo testa a garantia forte (camada 1, via `coalesceRefresh`
 *      e via as rotas completas) separada da garantia fraca (camada 2, via
 *      `tryAcquireRefreshLock` em isolamento — documentada como best-effort,
 *      não como exclusão mútua).
 *
 * Esta suíte não existia antes do #3644 -- os exports `coalesceRefresh`/
 * `tryAcquireRefreshLock`/`releaseRefreshLock`/`buildInflightCoalescedFallback`/
 * `buildInflightCoalescedCampaignsJson` não existiam no código pré-fix, e o
 * teste "(c)" abaixo (2 requests genuinamente sobrepostas, uma delas mantida
 * em voo por um gate controlado até a outra também ter chegado na rota) teria
 * FALHADO no código pré-#3644 mesmo comentando as chamadas ausentes e
 * deixando a rota seguir seu curso normal -- as 2 requests em cache-miss
 * faziam, cada uma, a sequência completa de live-fetch (brevoCalls dobrava).
 * Validado manualmente via revert temporário do diff de fix antes de abrir o PR.
 *
 * Fixtures 100% sintéticas -- nenhum id/email real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, {
  coalesceRefresh,
  getCoalesceCallCount,
  tryAcquireRefreshLock,
  releaseRefreshLock,
  REFRESH_LOCK_KEY_PREFIX,
  LASTGOOD_CAMPAIGNS_KEY,
  CAMPAIGNS_FETCH_LIMIT,
} from "../workers/brevo-dashboard/src/index.ts";

// Cache API (usada por / e /api/campaigns) -- mesmo polyfill de
// test/brevo-dashboard-request-refresh-3553.test.ts: sempre cache-miss, pra
// forçar o caminho de live-fetch em toda chamada.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).caches = {
  default: {
    match: async (_req: unknown) => null,
    put: async (_req: unknown, _res: unknown) => {},
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeKvMock(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    kv: {
      get: async (key: string, type?: string) => {
        const v = store.get(key);
        if (v == null) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async () => ({ keys: [], cursor: "", list_complete: true }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const sentDateOld = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const fakeCampaign = {
  id: 777,
  name: "Camp Teste 3644",
  subject: "Assunto",
  status: "sent",
  sentDate: sentDateOld,
  scheduledAt: null,
  createdAt: sentDateOld,
  recipients: { lists: [] as number[] },
};
const fakeGlobalStats = {
  sent: 100,
  delivered: 95,
  hardBounces: 1,
  softBounces: 1,
  uniqueViews: 40,
  viewed: 42,
  trackableViews: 35,
  uniqueClicks: 8,
  clickers: 7,
  unsubscriptions: 1,
  complaints: 0,
  appleMppOpens: 3,
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
    if (u.includes("emailCampaigns/777")) {
      return new Response(
        JSON.stringify({ ...fakeCampaign, statistics: { globalStats: fakeGlobalStats } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

const TOKEN = "thundering-herd-test-token";
const COOKIE = `cf-dash-auth=${TOKEN}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEnv(kv: any) {
  return { BREVO_API_KEY: "k", STATS_CACHE: kv, AUTH_TOKEN: TOKEN };
}

/** Espera até `cond()` ficar true, cedendo a vez pro event loop a cada tentativa. */
async function waitUntil(cond: () => boolean, maxTicks = 1000): Promise<void> {
  for (let i = 0; i < maxTicks && !cond(); i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(cond(), "waitUntil: condição não ficou true a tempo");
}

/**
 * Dá uma folga generosa pro event loop antes de liberar o gate -- usado
 * especificamente pra dar tempo da request 2 atravessar `isAuthenticated`
 * (2x `crypto.subtle.digest`, real operação assíncrona via WebCrypto, NÃO
 * um microtask puro) e chegar no checkpoint de coalescing ANTES de eu
 * liberar a request 1.
 *
 * Achado em CI (não reproduzido localmente em 15 runs seguidos): um único
 * `setImmediate` não é suficiente em toda infra -- `crypto.subtle.digest`
 * no Node é despachado via threadpool/callback nativo, cujo timing real
 * varia mais entre máquinas do que qualquer microtask puro. Combinar
 * MUITOS `setImmediate` (cobre o caso comum, custo ~0) com um `setTimeout`
 * real pequeno (força uma volta completa pelas fases de timer do event
 * loop, cobrindo o caso em que o callback nativo da crypto ainda não
 * tinha disparado dentro da rajada de `setImmediate`) sem deixar o teste
 * lento (worst-case ~30ms).
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setTimeout(r, 40));
}

/**
 * Mock de `globalThis.fetch` que SEGURA a 1ª chamada num gate controlado —
 * simula genuinamente "request 1 já está em voo, não terminou" em vez de
 * torcer pra 2 `worker.fetch()` concorrentes calharem de intercalar do jeito
 * certo (`crypto.subtle.digest`, usado por `isAuthenticated`, tem timing real
 * não-determinístico o bastante pra quebrar suposições de lockstep de
 * microtask). Retorna `{ install, release, callCount }`.
 */
function makeGatedBrevoFetch() {
  let released = false;
  let resolveGate: () => void;
  const gate = new Promise<void>((r) => { resolveGate = r; });
  let callCount = 0;
  const fn = (async (url: unknown) => {
    callCount++;
    if (callCount === 1 && !released) await gate;
    return mockBrevoFetch()(url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return {
    fn,
    release: () => { released = true; resolveGate(); },
    callCount: () => callCount,
  };
}

// ---------------------------------------------------------------------------
// (a) coalesceRefresh -- unidade, garantia FORTE (Map em memória, síncrono)
// ---------------------------------------------------------------------------
describe("coalesceRefresh (#3644) — garantia forte de execução única entre chamadas concorrentes", () => {
  it("2 chamadas concorrentes com a MESMA routeKey: run() executa 1 única vez, ambas recebem o mesmo resultado", async () => {
    let runs = 0;
    const run = async () => { runs++; return runs; };
    const [a, b] = await Promise.all([
      coalesceRefresh("test-key-a", run),
      coalesceRefresh("test-key-a", run),
    ]);
    assert.equal(runs, 1, "run() deveria ter sido chamado só 1 vez pras 2 chamadas concorrentes");
    assert.equal(a, b, "ambas as chamadas concorrentes devem receber o MESMO resultado (a mesma execução)");
  });

  it("routeKeys diferentes não compartilham execução", async () => {
    let runs = 0;
    const run = async () => { runs++; return runs; };
    await Promise.all([
      coalesceRefresh("test-key-b1", run),
      coalesceRefresh("test-key-b2", run),
    ]);
    assert.equal(runs, 2, "routeKeys diferentes devem disparar run() independentemente");
  });

  it("após a 1ª execução resolver, uma chamada SEGUINTE (não concorrente) dispara run() de novo", async () => {
    let runs = 0;
    const run = async () => { runs++; return runs; };
    await coalesceRefresh("test-key-c", run);
    await coalesceRefresh("test-key-c", run);
    assert.equal(runs, 2, "chamada sequencial (fora da janela da 1ª) não deve ficar presa ao resultado antigo");
  });
});

// ---------------------------------------------------------------------------
// (b) tryAcquireRefreshLock -- unidade, garantia FRACA (KV, best-effort,
// documentada explicitamente como NÃO sendo exclusão mútua sob corrida real)
// ---------------------------------------------------------------------------
describe("tryAcquireRefreshLock (#3644) — lock via KV, 2ª linha de defesa (cross-isolate), best-effort", () => {
  it("2ª chamada, feita DEPOIS que a 1ª já terminou (sequencial, não concorrente), vê o lock ocupado", async () => {
    const { kv } = makeKvMock();
    const env = { STATS_CACHE: kv };
    const r1 = await tryAcquireRefreshLock(env, "/");
    const r2 = await tryAcquireRefreshLock(env, "/");
    assert.equal(r1, true, "1ª chamada, sem corrida, deve adquirir o lock");
    assert.equal(r2, false, "2ª chamada, enquanto o lock da 1ª ainda está vivo (TTL), deve vê-lo ocupado");
  });

  it("sem binding STATS_CACHE -- fail-open, sempre retorna true (nunca bloqueia por falta de KV)", async () => {
    const acquired = await tryAcquireRefreshLock({ STATS_CACHE: undefined as never }, "/");
    assert.equal(acquired, true);
  });

  it("releaseRefreshLock apaga a chave -- request seguinte não fica presa até o TTL", async () => {
    const { kv, store } = makeKvMock();
    const env = { STATS_CACHE: kv };
    await tryAcquireRefreshLock(env, "/");
    assert.ok(store.has(`${REFRESH_LOCK_KEY_PREFIX}/`), "lock deveria estar gravado no KV após adquirir");
    await releaseRefreshLock(env, "/");
    assert.ok(!store.has(`${REFRESH_LOCK_KEY_PREFIX}/`), "release deveria ter apagado a chave do lock");
    const r2 = await tryAcquireRefreshLock(env, "/");
    assert.equal(r2, true, "após release, uma nova chamada deve conseguir adquirir o lock de novo");
  });
});

// ---------------------------------------------------------------------------
// (c) rota / e /api/campaigns -- 2 requests GENUINAMENTE sobrepostas (gate
// controlado, não "Promise.all e torcer") não duplicam o live-fetch.
// ---------------------------------------------------------------------------
describe("rota / (#3644) — 2 requests genuinamente sobrepostas coalescem em 1 live-fetch", () => {
  it("request 2 chega ENQUANTO a request 1 ainda está em voo (antes do 1º cache.put resolver) -- só 1 sequência completa de live-fetch acontece; as 2 respostas são idênticas (mesmo fetch)", async () => {
    const { kv } = makeKvMock();
    const gated = makeGatedBrevoFetch();
    const origFetch = globalThis.fetch;
    globalThis.fetch = gated.fn;
    try {
      const env = makeEnv(kv);
      const req1 = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const req2 = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      // Baseline -- não assume que "GET:/" nunca foi chamado antes desta
      // suíte (robusto a reordenação/novos testes usando a mesma routeKey).
      const baseline = getCoalesceCallCount("GET:/");

      const p1 = worker.fetch(req1, env);
      // Espera a request 1 realmente ter alcançado o live-fetch (1ª chamada
      // Brevo já disparada, presa no gate) -- só então lançamos a request 2,
      // garantindo sobreposição de verdade, não uma corrida de timing torcida.
      await waitUntil(() => gated.callCount() >= 1);
      const p2 = worker.fetch(req2, env);
      // Espera DETERMINISTICAMENTE (não estimando ticks) até a request 2 ter
      // de fato chamado coalesceRefresh("GET:/") -- ela ainda precisa
      // atravessar isAuthenticated (2x crypto.subtle.digest, real async via
      // WebCrypto/threadpool, timing não-determinístico entre ambientes) antes
      // de chegar lá. getCoalesceCallCount é um contador de observabilidade
      // pra teste (nunca lido por lógica de produção, ver brevo-api.ts) --
      // isso elimina a adivinhação de "quantos ticks bastam" que causou o
      // flake em CI (não reproduzido localmente, mas real: um único
      // `setImmediate` não é garantia suficiente sob scheduling diferente).
      // `settle()` continua como cinto-de-segurança adicional depois.
      await waitUntil(() => getCoalesceCallCount("GET:/") >= baseline + 2);
      await settle();
      gated.release();

      const [res1, res2] = await Promise.all([p1, p2]);
      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);
      const [t1, t2] = await Promise.all([res1.text(), res2.text()]);
      assert.equal(t1, t2, "as 2 respostas devem ser IDÊNTICAS -- vieram da mesma execução coalescida (não fetches independentes)");
      assert.ok(t1.includes("Dados em tempo real"));
      // Contagem EXATA de chamadas Brevo pra 1 sequência completa de "/":
      // fetchPlanCredits(1) + fetchScheduledCampaigns(1) + fetchRecentCampaigns
      // listing(1) + stats de 1 campanha (globalStats + linksStats = 2) = 5.
      // Sem coalescing (bug pré-#3644), as 2 requests rodariam a sequência
      // completa cada uma -- 10 chamadas. Esta é a asserção que teria
      // FALHADO no código antigo.
      assert.equal(gated.callCount(), 5, `esperado 5 chamadas Brevo (1 única sequência completa) -- callCount=${gated.callCount()} sugere thundering-herd não coalescido`);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("?fresh=1 sempre bypassa o coalescing (como já bypassa cache/KV) -- 2 requests com fresh=1 fazem 2 sequências completas, por design", async () => {
    const { kv } = makeKvMock();
    const origFetch = globalThis.fetch;
    let brevoCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      brevoCalls++;
      return mockBrevoFetch()(url);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      const env = makeEnv(kv);
      const req1 = new Request("http://localhost/?fresh=1", { headers: { Cookie: COOKIE } });
      const req2 = new Request("http://localhost/?fresh=1", { headers: { Cookie: COOKIE } });
      const [res1, res2] = await Promise.all([
        worker.fetch(req1, env),
        worker.fetch(req2, env),
      ]);
      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);
      assert.equal(brevoCalls, 10, "fresh=1 bypassa o coalescing por design -- 2 requests concorrentes = 2 sequências completas (5 chamadas cada)");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("lock KV ocupado (simulando cross-isolate) + KV lastgood presente -- serve o fallback de coalescing em vez de live-fetch", async () => {
    // Simula "outra request (outro isolate) já está no meio do fetch" sem
    // depender de corrida real: pré-semeia o lock manualmente (token que não
    // é desta chamada) + dash:lastgood:campaigns. Sequencial (1 única
    // chamada) -- exercita só a camada 2 (KV), que o Map em memória não
    // intercepta aqui porque não há OUTRA chamada concorrente no mesmo
    // processo disputando a mesma routeKey.
    const generatedAt = new Date(Date.now() - 60_000).toISOString();
    const lastgoodPayload = JSON.stringify({
      campaigns: [fakeCampaign],
      scheduled: [],
      generatedAt,
      campaignsLimit: CAMPAIGNS_FETCH_LIMIT,
    });
    const { kv } = makeKvMock({
      [LASTGOOD_CAMPAIGNS_KEY]: lastgoodPayload,
      [`${REFRESH_LOCK_KEY_PREFIX}/`]: "outro-isolate-qualquer",
    });
    const origFetch = globalThis.fetch;
    let brevoCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      brevoCalls++;
      return mockBrevoFetch()(url);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("Atualização já em andamento"), "com o lock KV ocupado e stale bom disponível, deve servir o fallback de coalescing (banner honesto, não rate-limit)");
      assert.equal(brevoCalls, 0, "não deve ter feito NENHUMA chamada Brevo -- serviu inteiramente do KV stale");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("lock KV ocupado mas SEM stale bom (KV lastgood ausente) -- fail-open, prossegue com live-fetch normalmente", async () => {
    const { kv } = makeKvMock({ [`${REFRESH_LOCK_KEY_PREFIX}/`]: "outro-isolate-qualquer" });
    const origFetch = globalThis.fetch;
    let brevoCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      brevoCalls++;
      return mockBrevoFetch()(url);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("Dados em tempo real"), "sem stale bom pra servir, deve prosseguir com o live-fetch (fail-open), não travar");
      assert.ok(brevoCalls > 0, "fail-open: lock ocupado sem fallback disponível não deve bloquear o live-fetch");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("rota /api/campaigns (#3644) — mesma garantia de coalescing (Map em memória)", () => {
  it("request 2 chega ENQUANTO a request 1 ainda está em voo -- só 1 sequência completa de live-fetch; respostas idênticas", async () => {
    const { kv } = makeKvMock();
    const gated = makeGatedBrevoFetch();
    const origFetch = globalThis.fetch;
    globalThis.fetch = gated.fn;
    try {
      const env = makeEnv(kv);
      // /api/campaigns é isenta de auth (automação interna) -- sem Cookie.
      const req1 = new Request("http://localhost/api/campaigns");
      const req2 = new Request("http://localhost/api/campaigns");
      // limit=20 é o default de /api/campaigns sem ?limit=.
      const coalesceKey = "GET:/api/campaigns:20";
      const baseline = getCoalesceCallCount(coalesceKey);

      const p1 = worker.fetch(req1, env);
      await waitUntil(() => gated.callCount() >= 1);
      const p2 = worker.fetch(req2, env);
      // Espera deterministicamente a request 2 ter chamado coalesceRefresh
      // (ver comentário equivalente no teste da rota "/" acima).
      await waitUntil(() => getCoalesceCallCount(coalesceKey) >= baseline + 2);
      await settle();
      gated.release();

      const [res1, res2] = await Promise.all([p1, p2]);
      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);
      const [t1, t2] = await Promise.all([res1.text(), res2.text()]);
      assert.equal(t1, t2, "as 2 respostas devem ser idênticas -- mesma execução coalescida");
      // fetchRecentCampaigns (limit=20 default): listing(1) + stats de 1 campanha
      // (globalStats + linksStats = 2) = 3. Sem coalescing: 6 (2 por request).
      assert.equal(gated.callCount(), 3, `esperado 3 chamadas Brevo (1 única sequência) -- callCount=${gated.callCount()} sugere thundering-herd não coalescido`);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
