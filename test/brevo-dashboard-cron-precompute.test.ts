/**
 * test/brevo-dashboard-cron-precompute.test.ts (#3079)
 *
 * Regressão: `clarice-dashboard` deixa de fazer o fetch pesado de campanhas
 * Brevo (fetchRecentCampaigns/fetchScheduledCampaigns, ~100+ chamadas com
 * cache frio) em REQUEST-TIME. Um Cron Trigger (`scheduled()`, a cada 3h —
 * #3256 subiu de 10min) roda `runCronRefresh` fora do request e grava o resultado em
 * `dash:lastgood:campaigns` (KV) — a rota `/` passa a ler dessa chave por
 * padrão. `?fresh=1` continua fazendo o fetch ao vivo (debug/urgência,
 * decisão do editor #3079).
 *
 * Cobertura:
 *   (a) runCronRefresh: sucesso grava { campaigns, scheduled, generatedAt };
 *       STATS_CACHE ausente → ok:false; falha parcial (agendadas) → ok:false
 *       SEM sobrescrever o KV (mantém o último valor bom).
 *   (b) renderDashboardHtml: cabeçalho honesto — "Dados em tempo real" quando
 *       dataGeneratedAt é recente/ausente (compat pré-#3079), "Dados
 *       pré-computados" quando diverge de "agora" (via shouldShowStalenessNote,
 *       #3011) — nunca alega "tempo real" pra dado potencialmente stale.
 *   (c) rota `/`: KV populado → ZERO chamadas à Brevo (withFetchSpy); KV
 *       vazio (cold-start pré-1º-tick) → cai pro fetch ao vivo E semeia o KV
 *       (senão toda request antes do 1º tick pagaria o fetch pesado de novo);
 *       KV corrompido → mesmo fallback, nunca quebra; `?fresh=1` sempre faz
 *       fetch ao vivo e NUNCA sobrescreve `dash:lastgood:campaigns` (mesmo
 *       comportamento pré-#3079).
 *   (d) scheduled(): chama runCronRefresh via ctx.waitUntil.
 *
 * Fixtures 100% sintéticas — nenhum id/email real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, {
  runCronRefresh,
  renderDashboardHtml,
  LASTGOOD_CAMPAIGNS_KEY,
  CAMPAIGNS_FETCH_LIMIT,
  CRON_INTERVAL_HOURS,
  fmtTimeBRT,
} from "../workers/brevo-dashboard/src/index.ts";
import { withFetchSpy } from "./_helpers/with-fetch-spy.ts";

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
// Regressão INCIDENTE 260710: CAMPAIGNS_FETCH_LIMIT acima do teto real da
// Brevo derrubou a dashboard inteira em produção. #3080 subiu o valor de
// 50 → 150 sem checar contra a API real — `/v3/emailCampaigns` rejeita
// `limit` > 100 com 400 {"code":"out_of_range"}, e esse erro (não sendo
// `BrevoRateLimitError`) não cai no fallback gracioso pro KV stale, gerando
// a página "Dashboard error" crua pro usuário. O bug ficou latente ~3 dias
// porque o worker estava com deploy desatualizado (#3268) — só foi exposto
// quando o deploy foi corrigido. Este teste travará qualquer tentativa
// futura de subir o valor sem antes confirmar o teto real da Brevo.
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
// (a) runCronRefresh
// ---------------------------------------------------------------------------

describe("runCronRefresh (#3079)", () => {
  it("sucesso: grava dash:lastgood:campaigns com { campaigns, scheduled, generatedAt }", async () => {
    const { kv, store } = makeKvMock();
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await runCronRefresh({ BREVO_API_KEY: "k", STATS_CACHE: kv } as any);
      assert.equal(result.ok, true, "deve reportar sucesso");
      assert.equal(result.campaignCount, 1);
      assert.equal(result.scheduledCount, 0);
      const raw = store.get(LASTGOOD_CAMPAIGNS_KEY);
      assert.ok(raw, "deve gravar a chave dash:lastgood:campaigns");
      const parsed = JSON.parse(raw!);
      assert.equal(parsed.campaigns.length, 1);
      assert.ok(Array.isArray(parsed.scheduled));
      assert.ok(
        typeof parsed.generatedAt === "string" && !isNaN(Date.parse(parsed.generatedAt)),
        "generatedAt deve ser um ISO válido — é o que o header honesto da rota / usa",
      );
      // #3080: payload self-describing — grava o limite pedido junto, pra rota
      // `/` saber decidir "janela cheia" sem depender de CAMPAIGNS_FETCH_LIMIT
      // ter ficado igual entre o tick que escreveu e a request que lê.
      assert.equal(parsed.campaignsLimit, CAMPAIGNS_FETCH_LIMIT, "deve gravar o limite usado neste tick (#3080)");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("STATS_CACHE ausente → ok:false, nunca lança (nada pra gravar)", async () => {
    const result = await runCronRefresh({
      BREVO_API_KEY: "k",
      STATS_CACHE: undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });

  it("fetchScheduledCampaigns falha → ok:false, KV NÃO sobrescrito (mantém o último valor bom)", async () => {
    const oldPayload = JSON.stringify({
      campaigns: [{ marker: "valor-antigo" }],
      scheduled: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const { kv, store } = makeKvMock({ [LASTGOOD_CAMPAIGNS_KEY]: oldPayload });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("emailCampaigns?status=queued")) return new Response("erro", { status: 500 });
      if (u.includes("/v3/account")) return new Response(JSON.stringify({ plan: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await runCronRefresh({ BREVO_API_KEY: "k", STATS_CACHE: kv } as any);
      assert.equal(result.ok, false, "falha parcial deve reportar ok:false");
      const raw = store.get(LASTGOOD_CAMPAIGNS_KEY)!;
      assert.equal(raw, oldPayload, "KV preserva o payload do tick anterior — nunca grava parcial/vazio");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// (b) renderDashboardHtml — cabeçalho de frescor honesto
// ---------------------------------------------------------------------------

describe("renderDashboardHtml — cabeçalho de frescor (#3079)", () => {
  it("dataGeneratedAt omitido (null, default) → 'Dados em tempo real' (compat pré-#3079 para callers/testes antigos)", () => {
    const html = renderDashboardHtml([]);
    assert.ok(html.includes("Dados em tempo real"), "sem o novo argumento, preserva o texto antigo");
    assert.ok(!html.includes("pré-computados"));
  });

  it("dataGeneratedAt recente (<5min) → ainda 'Dados em tempo real' (dentro da tolerância de jitter do #3011)", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const html = renderDashboardHtml([], [], null, null, null, null, null, null, recent);
    assert.ok(html.includes("Dados em tempo real"));
    assert.ok(!html.includes("pré-computados"));
  });

  it("dataGeneratedAt antigo (10min — além da tolerância de staleness de 5min, #3011; tick real do cron agora é 3h, #3256) → 'Dados pré-computados', com o horário do CRON, nunca 'agora'", () => {
    const generatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const html = renderDashboardHtml([], [], null, null, null, null, null, null, generatedAt);
    assert.ok(html.includes("Dados pré-computados"), "wording honesto — não é fetch ao vivo desta request");
    assert.ok(!html.includes("Dados em tempo real"));
  });

  // #3256: a nota de frescor cita o intervalo do cron (via CRON_INTERVAL_HOURS,
  // sincronizado manualmente com `crons` em wrangler.toml) e a hora da PRÓXIMA
  // atualização (dataGeneratedAt + CRON_INTERVAL_HOURS) — pedido do editor pra
  // não deixar o leitor adivinhar quando esperar dado mais novo.
  it("#3256 nota de frescor cita ~CRON_INTERVAL_HOURSh e a hora da próxima atualização (dataGeneratedAt + CRON_INTERVAL_HOURS)", () => {
    const generatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const html = renderDashboardHtml([], [], null, null, null, null, null, null, generatedAt);
    assert.ok(
      html.includes(`a cada ~${CRON_INTERVAL_HOURS}h`),
      `deve citar o intervalo atual do cron (~${CRON_INTERVAL_HOURS}h), nunca o valor antigo (~10min)`,
    );
    assert.ok(!html.includes("a cada ~10min"), "wording antigo (#3079, pré-#3256) não deve mais aparecer");
    const expectedNext = fmtTimeBRT(
      new Date(Date.parse(generatedAt) + CRON_INTERVAL_HOURS * 3_600_000).toISOString(),
    );
    assert.ok(
      html.includes(`próxima: ~${expectedNext} BRT`),
      "deve mostrar a hora da próxima atualização (dataGeneratedAt + CRON_INTERVAL_HOURS), formatada como as demais horas BRT",
    );
  });

  it("#3256 dataGeneratedAt ausente ('Dados em tempo real') → sem nota de 'próxima atualização' (não é dado pré-computado)", () => {
    const html = renderDashboardHtml([]);
    assert.ok(!html.includes("próxima:"), "fetch ao vivo não tem 'próximo tick de cron' pra anunciar");
  });
});

// ---------------------------------------------------------------------------
// (c) rota / — precomputado por padrão, cold-start e ?fresh=1
// ---------------------------------------------------------------------------

const TOKEN = "cron-precompute-test-token";
const COOKIE = `cf-dash-auth=${TOKEN}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEnv(kv: any) {
  return { BREVO_API_KEY: "k", STATS_CACHE: kv, AUTH_TOKEN: TOKEN };
}

describe("rota / (#3079) — lê o pré-computado por padrão", () => {
  it("KV populado (dash:lastgood:campaigns) → ZERO chamadas à Brevo, header reflete o timestamp do cron", async () => {
    const generatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const payload = JSON.stringify({ campaigns: [fakeCampaign], scheduled: [], generatedAt });
    const { kv, store } = makeKvMock({ [LASTGOOD_CAMPAIGNS_KEY]: payload });
    await withFetchSpy(async (calls) => {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("Clarice News Dashboard"));
      assert.ok(text.includes("Dados pré-computados"), "usa o timestamp do cron — nunca 'tempo real' pra dado de até 10min");
      assert.deepEqual(calls, [], "rota / com KV populado não deve fazer NENHUMA chamada externa à Brevo");
    });
  });

  // #3080: quando o payload pré-computado registra que a janela buscada estava
  // CHEIA (campaigns.length === campaignsLimit gravado), a rota / deve repassar
  // esse sinal até o HTML — "Totais por mês" avisa que o mês mais antigo pode
  // estar parcial (defesa em profundidade complementar ao aumento de limite).
  it("#3080 janela cheia (campaignsLimit === campaigns.length) → HTML mostra aviso de mês parcial", async () => {
    const generatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const campaignWithStats = {
      ...fakeCampaign,
      statistics: { globalStats: fakeGlobalStats },
    };
    const payload = JSON.stringify({
      campaigns: [campaignWithStats],
      scheduled: [],
      generatedAt,
      campaignsLimit: 1, // janela "pedida" era 1 — bateu exatamente o length ⇒ cheia/truncada
    });
    const { kv } = makeKvMock({ [LASTGOOD_CAMPAIGNS_KEY]: payload });
    await withFetchSpy(async (calls) => {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /\(parcial — janela de 1 campanhas?\)/, "deve avisar que o mês mais antigo pode estar parcial");
      assert.deepEqual(calls, [], "ainda não deve fazer nenhuma chamada à Brevo (caminho pré-computado)");
    });
  });

  it("#3080 janela NÃO cheia (campaignsLimit > campaigns.length) → sem aviso de parcial", async () => {
    const generatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const campaignWithStats = {
      ...fakeCampaign,
      statistics: { globalStats: fakeGlobalStats },
    };
    const payload = JSON.stringify({
      campaigns: [campaignWithStats],
      scheduled: [],
      generatedAt,
      campaignsLimit: CAMPAIGNS_FETCH_LIMIT, // 100 pedidas, só 1 encontrada ⇒ não truncou
    });
    const { kv } = makeKvMock({ [LASTGOOD_CAMPAIGNS_KEY]: payload });
    await withFetchSpy(async (_calls) => {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.doesNotMatch(text, /parcial — janela de/, "janela não-truncada não deve exibir aviso de parcial");
    });
  });

  it("KV vazio (cold-start, antes do 1º tick do cron) → cai pro fetch ao vivo E semeia o KV", async () => {
    const { kv, store } = makeKvMock();
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
      assert.equal(res.status, 200, "cold-start não pode quebrar o dashboard");
      assert.ok(brevoCalls > 0, "sem KV populado, deve cair pro fetch ao vivo (senão o dashboard ficaria vazio até o 1º tick)");
      const seeded = store.get(LASTGOOD_CAMPAIGNS_KEY);
      assert.ok(seeded, "cold-start deve semear dash:lastgood:campaigns pra requests seguintes já lerem do KV");
      const parsed = JSON.parse(seeded!);
      assert.equal(parsed.campaigns.length, 1);
      assert.ok(typeof parsed.generatedAt === "string");
      // #3080: o fallback ao vivo (cold-start) também grava o limite usado, pra
      // manter o payload self-describing consistente com o caminho do cron.
      assert.equal(parsed.campaignsLimit, CAMPAIGNS_FETCH_LIMIT);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("KV corrompido (campaigns não é array) → mesmo fallback ao vivo, nunca quebra", async () => {
    const { kv, store } = makeKvMock({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({ campaigns: "corrompido", scheduled: 0 }),
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
      const res = await worker.fetch(req, makeEnv(kv));
      assert.equal(res.status, 200, "KV corrompido nunca deve derrubar a rota — degrada pro fetch ao vivo");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("?fresh=1 SEMPRE faz fetch ao vivo (bypassa o KV) e NUNCA sobrescreve dash:lastgood:campaigns", async () => {
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
      assert.ok(brevoCalls > 0, "?fresh=1 deve ignorar o KV e buscar ao vivo");
      const text = await res.text();
      assert.ok(text.includes("Dados em tempo real"), "fetch ao vivo desta request → wording 'tempo real', nunca 'pré-computado'");
      assert.equal(store.get(LASTGOOD_CAMPAIGNS_KEY), oldPayload, "?fresh=1 não deve escrever em dash:lastgood:campaigns (mesmo comportamento pré-#3079)");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// (d) scheduled() — Cron Trigger
// ---------------------------------------------------------------------------

describe("scheduled() — Cron Trigger (#3079)", () => {
  it("chama runCronRefresh via ctx.waitUntil e popula dash:lastgood:campaigns", async () => {
    const { kv, store } = makeKvMock();
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      let waited: Promise<unknown> | null = null;
      const ctx = {
        waitUntil: (p: Promise<unknown>) => {
          waited = p;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      await worker.scheduled(
        {} as ScheduledEvent,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { BREVO_API_KEY: "k", STATS_CACHE: kv } as any,
        ctx,
      );
      assert.ok(waited, "scheduled() deve registrar o trabalho via ctx.waitUntil (não deixar o Worker reciclar antes de terminar)");
      await waited;
      const seeded = store.get(LASTGOOD_CAMPAIGNS_KEY);
      assert.ok(seeded, "scheduled() deve ter populado dash:lastgood:campaigns");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
