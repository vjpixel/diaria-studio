/**
 * test/brevo-dashboard-fatal-fallback-4187.test.ts (#4187)
 *
 * Regressão do incidente 260727: com a Brevo em rate-limit horário, o
 * dashboard Cloudflare (caminho autenticado) devolveu Error 1101 (exceção JS
 * não-tratada escapando do Worker) em vez de degradar com banner + último
 * dado bom. Investigado por leitura de código (sem reproduzir contra a
 * Brevo real, por instrução explícita da sessão):
 *
 *  - REFUTADO: o deploy #4183 (studioMode em renderDashboardHtml) não altera
 *    o caminho de produção — nenhum call site de produção (index.ts:326, e
 *    os fallbacks buildRateLimitFallback/buildInflightCoalescedFallback em
 *    brevo-api.ts) passa `opts`, então `studioMode` é sempre `false`/ausente
 *    lá. Confirmado por leitura + os testes de
 *    brevo-dashboard-studio-kv-adapter-4165-4173.test.ts (regressão "sem
 *    opts" preserva o texto antigo).
 *
 *  - ACHADO CONCRETO: `buildDashboardResponse` (index.ts), no catch genérico
 *    (não-BrevoRateLimitError), construía a resposta de erro com
 *    `escHtml((e as Error).message)`. Se `e` não é uma instância de `Error`
 *    (ex: uma dependência externa -- fetch nativo, runtime do Workers --
 *    lança um valor não-Error), `(e as Error).message` é `undefined`, e
 *    `escHtml(undefined)` lança `TypeError: Cannot read properties of
 *    undefined (reading 'replace')` DENTRO do próprio catch, sem nenhum try
 *    em volta -- exatamente o tipo de exceção que escapa até o `fetch()`
 *    handler (que não tinha try/catch nenhum) e vira Error 1101 no
 *    Cloudflare. Corrigido (`e instanceof Error ? e.message : String(e)`) em
 *    index.ts e no catch equivalente de buildCampaignsResponse.
 *
 *  - GUARD DE ÚLTIMA INSTÂNCIA (o pedido central da issue, independente de
 *    causa raiz): `export default.fetch` agora envolve TODO o roteamento
 *    (extraído para `handleFetch`) num try/catch que chama
 *    `buildFatalErrorFallback` -- que por sua vez reusa a MESMA composição
 *    de dado stale do `buildRateLimitFallback` (#2733), com banner distinto
 *    ("erro inesperado", não presume Brevo/rate-limit), e degrada pro
 *    `genericFatalErrorResponse()` (zero I/O) se isso também falhar. Esta
 *    suíte prova que ISSO nunca deixa uma exceção escapar até o runtime,
 *    mesmo para uma causa sintética completamente alheia à Brevo (injetada
 *    via `request.headers.get` malformado) -- não dependente de reproduzir
 *    o 429 real.
 *
 * Fixtures 100% sintéticas -- nenhum id/email real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, {
  buildFatalErrorFallback,
  genericFatalErrorResponse,
  injectFatalErrorBanner,
  LASTGOOD_CAMPAIGNS_KEY,
  COUPONS_KV_KEY,
} from "../workers/brevo-dashboard/src/index.ts";
import type { CouponUsageReport } from "../scripts/lib/stripe-coupons.ts";

// Cache API stub -- mesmo padrão de test/brevo-dashboard-thundering-herd-3644.test.ts,
// sempre cache-miss (força o caminho de live-fetch / roteamento real).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).caches = {
  default: {
    match: async (_req: unknown) => null,
    put: async (_req: unknown, _res: unknown) => {},
  },
};

function makeKvMock(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    kv: {
      get: async (key: string, type?: string) => {
        const v = store.get(key);
        if (v == null) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      put: async (key: string, value: string) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); },
      list: async () => ({ keys: [], cursor: "", list_complete: true }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const staleCampaign = {
  id: 501,
  name: "Clarice News 2607-08 d01-A (seg)",
  subject: "Assunto",
  status: "sent",
  sentDate: "2026-07-20T09:00:00Z",
  scheduledAt: null,
  createdAt: "2026-07-20T09:00:00Z",
  recipients: { lists: [] as number[] },
};

const syntheticCoupons: CouponUsageReport = {
  NEWS50: {
    couponIds: ["cpnSYNTH50"],
    timesRedeemed: 1,
    rowCount: 1,
    totalProjectedDiscountCents: 22450,
    redemptions: [
      {
        coupon_code: "NEWS50",
        coupon_id: "cpnSYNTH50",
        percent_off: 50,
        duration: "once",
        customer: "cus_TEST1",
        customer_email: "test1@example.com",
        subscription: "sub_SYNTH1",
        status: "active",
        created: 1782383062,
        plan_amount_cents: 44900,
        currency: "brl",
        interval: "year",
        discount_value_cents: 22450,
      },
    ],
  },
};

// ─── genericFatalErrorResponse / injectFatalErrorBanner ─────────────────────

describe("genericFatalErrorResponse (#4187) — piso absoluto, zero I/O", () => {
  it("500 + marcador de observabilidade + nunca lança", () => {
    const resp = genericFatalErrorResponse();
    assert.strictEqual(resp.status, 500);
    assert.strictEqual(resp.headers.get("X-Dashboard-Stale"), "fatal-error-empty");
    assert.strictEqual(resp.headers.get("Cache-Control"), "no-store");
  });

  it("corpo é HTML válido com link pra tentar de novo", async () => {
    const resp = genericFatalErrorResponse();
    const body = await resp.text();
    assert.match(body, /<!DOCTYPE html>/);
    assert.match(body, /fresh=1/);
  });
});

describe("injectFatalErrorBanner (#4187) — distinto do banner de rate-limit", () => {
  it("insere banner logo após <body>, preserva o resto", () => {
    const html = `<!DOCTYPE html><html><body class="x"><h1>Dash</h1></body></html>`;
    const out = injectFatalErrorBanner(html);
    assert.ok(out.includes("Erro inesperado"), "banner presente");
    assert.ok(/<body class="x">.*Erro inesperado/s.test(out), "banner logo após <body>");
    assert.ok(out.includes("<h1>Dash</h1>"), "conteúdo original preservado");
    assert.ok(!out.includes("rate-limit"), "não deve mencionar rate-limit — causa desconhecida");
  });

  it("sem <body> → prepend (nunca perde conteúdo)", () => {
    const out = injectFatalErrorBanner("<div>conteudo</div>");
    assert.ok(out.startsWith("<div style="));
    assert.ok(out.includes("<div>conteudo</div>"));
  });
});

// ─── buildFatalErrorFallback ─────────────────────────────────────────────────

describe("buildFatalErrorFallback (#4187) — catch de última instância nunca lança", () => {
  it("STATS_CACHE ausente → estado vazio explicativo (500), nunca lança", async () => {
    const env = { STATS_CACHE: undefined };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildFatalErrorFallback(env as any, new Error("causa sintética"));
    assert.strictEqual(resp.status, 500);
    assert.strictEqual(resp.headers.get("X-Dashboard-Stale"), "fatal-error-empty");
  });

  it("STATS_CACHE presente mas SEM dash:lastgood:campaigns → estado vazio explicativo, nunca lança", async () => {
    const { kv } = makeKvMock({});
    const env = { STATS_CACHE: kv, COUPONS_TAB_ENABLED: "true" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildFatalErrorFallback(env as any, "causa sintética não-Error");
    assert.strictEqual(resp.status, 500);
    assert.strictEqual(resp.headers.get("X-Dashboard-Stale"), "fatal-error-empty");
  });

  it("com dash:lastgood:campaigns + abas de KV → 200 com banner de erro inesperado + dado stale", async () => {
    const { kv } = makeKvMock({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleCampaign],
        scheduled: [],
        generatedAt: "2026-07-20T10:00:00.000Z",
      }),
      [COUPONS_KV_KEY]: JSON.stringify(syntheticCoupons),
    });
    const env = { STATS_CACHE: kv, COUPONS_TAB_ENABLED: "true" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildFatalErrorFallback(env as any, new TypeError("exceção sintética não relacionada à Brevo"));
    assert.strictEqual(resp.status, 200, "com dado stale disponível, degrada pra 200 (não 500)");
    assert.strictEqual(resp.headers.get("X-Dashboard-Stale"), "fatal-error");
    const body = await resp.text();
    assert.ok(body.includes("Erro inesperado"), "banner de erro inesperado presente");
    assert.ok(body.includes("Clarice News 2607-08"), "campanha stale renderizada");
    assert.ok(body.includes("test1@example.com"), "aba de cupons fresca (via readKvTabs) presente");
  });

  it("nunca lança mesmo com KV.get lançando algo bizarro (fail-soft até no piso)", async () => {
    const env = {
      STATS_CACHE: {
        get: async () => { throw "kv totalmente quebrado"; },
        put: async () => {},
      },
      COUPONS_TAB_ENABLED: "true",
    };
    await assert.doesNotReject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async () => buildFatalErrorFallback(env as any, new Error("causa original")),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildFatalErrorFallback(env as any, new Error("causa original"));
    assert.strictEqual(resp.status, 500, "KV completamente quebrado → degrada pro piso absoluto");
  });

  it("cause não-Error (string/objeto) não impede o fallback de funcionar", async () => {
    const { kv } = makeKvMock({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({ campaigns: [staleCampaign], scheduled: [] }),
    });
    const env = { STATS_CACHE: kv, COUPONS_TAB_ENABLED: "false" };
    await assert.doesNotReject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async () => buildFatalErrorFallback(env as any, "raw string thrown by native fetch"),
    );
    await assert.doesNotReject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async () => buildFatalErrorFallback(env as any, undefined),
    );
  });
});

// ─── E2E: worker.fetch() nunca deixa uma exceção escapar (Error 1101) ──────

describe("worker.fetch() — guard de última instância end-to-end (#4187)", () => {
  const TOKEN = "fatal-fallback-test-token";

  it("exceção sintética não relacionada à Brevo (request.headers.get malformado) → 200 com dado stale, NUNCA rejeita", async () => {
    const { kv } = makeKvMock({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleCampaign],
        scheduled: [],
        generatedAt: "2026-07-20T10:00:00.000Z",
      }),
    });
    const env = { BREVO_API_KEY: "k", STATS_CACHE: kv, AUTH_TOKEN: TOKEN };
    // Request "malformada" propositalmente -- headers.get lança de forma
    // sintética, simulando QUALQUER exceção não-tratada que escape de um
    // ponto do roteamento sem catch específico (o caso real do #4187 pode
    // ter sido outro ponto -- o que importa aqui é que NENHUM ponto deveria
    // deixar isso propagar até o runtime).
    const evilRequest = {
      url: "http://localhost/",
      headers: { get: () => { throw new Error("synthetic isAuthenticated failure"); } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // A garantia central: fetch() NUNCA rejeita (isso é o que "Error 1101"
    // significaria em produção -- uma exceção que sobe até o runtime).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchPromise = worker.fetch(evilRequest, env as any);
    await assert.doesNotReject(async () => fetchPromise);
    const resp = await fetchPromise;
    // Como há dado stale no KV, o catch de última instância degrada pra 200.
    assert.strictEqual(resp.status, 200);
    const body = await resp.text();
    assert.ok(body.includes("Erro inesperado"), "banner de erro inesperado presente na resposta real da rota");
    assert.ok(body.includes("Clarice News 2607-08"), "dado stale real chega até a resposta HTTP");
  });

  it("mesma exceção sintética, SEM dado stale no KV → 500 explicativo, ainda sem rejeitar", async () => {
    const { kv } = makeKvMock({});
    const env = { BREVO_API_KEY: "k", STATS_CACHE: kv, AUTH_TOKEN: TOKEN };
    const evilRequest = {
      url: "http://localhost/",
      headers: { get: () => { throw new Error("synthetic isAuthenticated failure"); } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchPromise = worker.fetch(evilRequest, env as any);
    await assert.doesNotReject(async () => fetchPromise);
    const resp = await fetchPromise;
    assert.strictEqual(resp.status, 500);
  });

  it("regressão: caminho feliz (sem exceção sintética) continua funcionando normalmente, sem banner de erro", async () => {
    const { kv } = makeKvMock({});
    const env = { BREVO_API_KEY: "k", STATS_CACHE: kv, AUTH_TOKEN: TOKEN };
    // Sem AUTH_TOKEN correto no cookie → login page normal (200), NUNCA o
    // catch de última instância (prova que o wrapper não interfere no
    // caminho não-excepcional).
    const req = new Request("http://localhost/");
    const resp = await worker.fetch(req, env as never);
    assert.strictEqual(resp.status, 200);
    const body = await resp.text();
    assert.ok(body.includes("clarice dashboard"), "login page normal, não o fallback de erro");
    assert.ok(!body.includes("Erro inesperado"), "sem exceção sintética, o banner de erro NUNCA aparece");
  });
});
