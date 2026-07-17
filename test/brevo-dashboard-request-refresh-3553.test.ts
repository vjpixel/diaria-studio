/**
 * test/brevo-dashboard-request-refresh-3553.test.ts (#3553 parte B)
 *
 * Regressão: `clarice-dashboard` deixou de ter um Cron Trigger que
 * pré-computava `dash:lastgood:campaigns` fora do request-time (era #3079,
 * cadência revisada em #3256). Decisão do editor (2026-07-16): a dashboard
 * Cloudflare não deve mais se atualizar sozinha — só no reload da página.
 *
 * Substitui test/brevo-dashboard-cron-precompute.test.ts (deletado — testava
 * exatamente o comportamento removido aqui: leitura de KV como fonte PRIMÁRIA
 * + `scheduled()`/`runCronRefresh`).
 *
 * Cobertura:
 *   (a) CAMPAIGNS_FETCH_LIMIT <= 100 — regressão do incidente 260710 (teto
 *       real da Brevo), preservada da suíte anterior (não depende de cron).
 *   (b) renderDashboardHtml: cabeçalho SEMPRE "Dados em tempo real" — a
 *       nota "Dados pré-computados ... próxima: ~Y" (cron-specific) não
 *       existe mais, independente de quão "velho" dataGeneratedAt seja.
 *   (c) rota `/`: SEMPRE faz fetch ao vivo na Brevo, mesmo com
 *       dash:lastgood:campaigns populado (era o oposto pré-#3553: KV
 *       populado = zero chamadas). Cada fetch bem-sucedido grava
 *       write-through em dash:lastgood:campaigns (fora de ?fresh=1) — o KV
 *       vira cache de FALLBACK (consumido só por buildRateLimitFallback em
 *       429, já coberto por test/brevo-dashboard-2733.test.ts), nunca mais
 *       fonte primária de leitura.
 *   (d) `scheduled()` não existe mais no worker exportado; `wrangler.toml`
 *       não declara `[triggers]`/`crons` — trava reintrodução acidental do
 *       Cron Trigger.
 *
 * Fixtures 100% sintéticas — nenhum id/email real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker, {
  renderDashboardHtml,
  LASTGOOD_CAMPAIGNS_KEY,
  CAMPAIGNS_FETCH_LIMIT,
  fmtTimeBRT,
} from "../workers/brevo-dashboard/src/index.ts";

// Cache API (usada por /) — mesmo polyfill de test/dashboard-auth.test.ts.
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
  const putCalls: Array<{ key: string; value: string }> = [];
  return {
    store,
    putCalls,
    kv: {
      get: async (key: string, type?: string) => {
        const v = store.get(key);
        if (v == null) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      put: async (key: string, value: string) => {
        putCalls.push({ key, value });
        store.set(key, value);
      },
      delete: async () => {},
      list: async () => ({ keys: [], cursor: "", list_complete: true }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const sentDateOld = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const fakeCampaign = {
  id: 1,
  name: "Camp Teste",
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
    if (u.includes("emailCampaigns/1")) {
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
// (a) CAMPAIGNS_FETCH_LIMIT — regressão do incidente 260710 (não depende de
// cron: continua valendo com fetch em request-time).
// ---------------------------------------------------------------------------
describe("CAMPAIGNS_FETCH_LIMIT — nunca deve exceder o teto real da Brevo (incidente 260710)", () => {
  it("CAMPAIGNS_FETCH_LIMIT <= 100 (teto documentado/confirmado de /v3/emailCampaigns)", () => {
    assert.ok(
      CAMPAIGNS_FETCH_LIMIT <= 100,
      `CAMPAIGNS_FETCH_LIMIT=${CAMPAIGNS_FETCH_LIMIT} excede o teto real da Brevo (100) — ` +
        `qualquer valor acima disso faz /v3/emailCampaigns retornar 400 "out_of_range" e derruba ` +
        `a dashboard inteira (sem fallback gracioso, ver incidente 260710). Confirme o teto real ` +
        `contra a API antes de subir este valor de novo.`,
    );
  });
});

// ---------------------------------------------------------------------------
// (b) renderDashboardHtml — cabeçalho sempre "tempo real" (#3553)
// ---------------------------------------------------------------------------
describe("renderDashboardHtml — cabeçalho de frescor sem Cron Trigger (#3553)", () => {
  it("dataGeneratedAt omitido (null, default) → 'Dados em tempo real'", () => {
    const html = renderDashboardHtml([]);
    assert.ok(html.includes("Dados em tempo real"), "sem o argumento, mostra o texto de fetch ao vivo");
    assert.ok(!html.includes("pré-computados"), "sem Cron Trigger, nunca alega dado pré-computado");
    assert.ok(!html.includes("próxima:"), "sem cron, não há 'próxima atualização' a anunciar");
  });

  it("dataGeneratedAt recente (<1min, fetch desta request) → 'Dados em tempo real'", () => {
    const recent = new Date(Date.now() - 5_000).toISOString();
    const html = renderDashboardHtml([], [], null, null, null, null, null, null, recent);
    assert.ok(html.includes("Dados em tempo real"));
    assert.ok(!html.includes("pré-computados"));
  });

  it("dataGeneratedAt 'velho' (10min — cenário que ANTES do #3553 disparava 'Dados pré-computados') → segue 'Dados em tempo real', nunca 'pré-computados'", () => {
    const generatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const html = renderDashboardHtml([], [], null, null, null, null, null, null, generatedAt);
    assert.ok(
      html.includes("Dados em tempo real"),
      "sem Cron Trigger, TODO dataGeneratedAt reflete o fetch desta própria request — nunca um payload pré-computado",
    );
    assert.ok(!html.includes("pré-computados"), "wording cron-specific não deve mais aparecer, mesmo com timestamp antigo");
    assert.ok(!html.includes("próxima:"), "sem cron, não há cadência fixa de atualização a anunciar");
    // O timestamp exibido continua sendo o de dataGeneratedAt (não "agora") —
    // só o WORDING da nota mudou, não a honestidade do horário mostrado.
    assert.ok(html.includes(fmtTimeBRT(generatedAt)), "o horário exibido continua sendo o de dataGeneratedAt, não 'agora'");
  });

  it("dataGeneratedAt malformado (string não-ISO) → não lança, degrada graciosamente", () => {
    assert.doesNotThrow(() => {
      renderDashboardHtml([], [], null, null, null, null, null, null, "not-a-real-date");
    }, "renderDashboardHtml não deve lançar RangeError quando dataGeneratedAt é uma string não-parseável como data");
    const html = renderDashboardHtml([], [], null, null, null, null, null, null, "not-a-real-date");
    assert.ok(!html.includes("próxima:"), "dado malformado não deve fingir calcular 'próxima atualização'");
  });
});

// ---------------------------------------------------------------------------
// (c) rota / — SEMPRE fetch ao vivo + write-through (#3553)
// ---------------------------------------------------------------------------

const TOKEN = "request-refresh-test-token";
const COOKIE = `cf-dash-auth=${TOKEN}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEnv(kv: any) {
  return { BREVO_API_KEY: "k", STATS_CACHE: kv, AUTH_TOKEN: TOKEN };
}

describe("rota / (#3553) — sempre fetch ao vivo, KV vira write-through", () => {
  it("dash:lastgood:campaigns JÁ populado → mesmo assim faz fetch ao vivo na Brevo (era o oposto pré-#3553)", async () => {
    const generatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const oldPayload = JSON.stringify({ campaigns: [{ ...fakeCampaign, id: 999 }], scheduled: [], generatedAt });
    const { kv } = makeKvMock({ [LASTGOOD_CAMPAIGNS_KEY]: oldPayload });
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
      assert.ok(brevoCalls > 0, "KV populado não deve mais bloquear o fetch ao vivo — #3553 removeu o Cron Trigger que justificava isso");
      const text = await res.text();
      assert.ok(text.includes("Dados em tempo real"), "resultado é do fetch DESTA request, não do KV stale");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("fetch bem-sucedido → grava write-through em dash:lastgood:campaigns (fora de ?fresh=1)", async () => {
    const { kv, store, putCalls } = makeKvMock();
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      const seeded = store.get(LASTGOOD_CAMPAIGNS_KEY);
      assert.ok(seeded, "deve gravar dash:lastgood:campaigns a cada fetch bem-sucedido — é o write-through que alimenta o fallback de rate-limit");
      const parsed = JSON.parse(seeded!);
      assert.equal(parsed.campaigns.length, 1);
      assert.ok(Array.isArray(parsed.scheduled));
      assert.ok(
        typeof parsed.generatedAt === "string" && !isNaN(Date.parse(parsed.generatedAt)),
        "generatedAt deve ser um ISO válido",
      );
      assert.equal(parsed.campaignsLimit, CAMPAIGNS_FETCH_LIMIT);
      assert.ok(
        putCalls.some((c) => c.key === LASTGOOD_CAMPAIGNS_KEY),
        "o write deve ter sido de fato observado no mock (não só refletido no snapshot final do store)",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("?fresh=1 faz fetch ao vivo (como sempre) mas NUNCA sobrescreve dash:lastgood:campaigns", async () => {
    const oldPayload = JSON.stringify({
      campaigns: [{ ...fakeCampaign, id: 999 }],
      scheduled: [],
      generatedAt: "2020-01-01T00:00:00.000Z",
    });
    const { kv, store } = makeKvMock({ [LASTGOOD_CAMPAIGNS_KEY]: oldPayload });
    const origFetch = globalThis.fetch;
    let brevoCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      brevoCalls++;
      return mockBrevoFetch()(url);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      const req = new Request("http://localhost/?fresh=1", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      assert.ok(brevoCalls > 0, "?fresh=1 sempre busca ao vivo");
      const text = await res.text();
      assert.ok(text.includes("Dados em tempo real"));
      assert.equal(store.get(LASTGOOD_CAMPAIGNS_KEY), oldPayload, "?fresh=1 não deve escrever em dash:lastgood:campaigns (preserva comportamento pré-#3553)");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("KV corrompido/ausente não impede o fetch ao vivo (write-through é best-effort)", async () => {
    const { kv } = makeKvMock({
      [LASTGOOD_CAMPAIGNS_KEY]: "not-json-at-all-{{{",
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200, "KV corrompido nunca deve derrubar a rota — o fetch ao vivo nem depende de lê-lo mais");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// (d) Cron Trigger removido — trava reintrodução acidental
// ---------------------------------------------------------------------------

describe("Cron Trigger removido (#3553 parte B)", () => {
  it("worker exportado não tem mais scheduled()", () => {
    assert.ok(
      !("scheduled" in worker),
      "scheduled() (Cron Trigger handler) deve ter sido removido de index.ts — a dashboard não se atualiza mais sozinha",
    );
  });

  it("wrangler.toml não declara [triggers]/crons", () => {
    const wranglerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../workers/brevo-dashboard/wrangler.toml",
    );
    const toml = readFileSync(wranglerPath, "utf-8");
    assert.ok(!/\[triggers\]/.test(toml), "wrangler.toml não deve mais ter uma seção [triggers]");
    assert.ok(!/^\s*crons\s*=/m.test(toml), "wrangler.toml não deve mais declarar crons — reintroduzir isso reativaria a atualização automática que o #3553 removeu");
  });
});
