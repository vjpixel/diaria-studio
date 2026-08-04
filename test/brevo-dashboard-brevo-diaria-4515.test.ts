/**
 * test/brevo-dashboard-brevo-diaria-4515.test.ts (#4515)
 *
 * Regressão da aba nova "brevo_diaria" no dashboard Clarice
 * (`workers/brevo-dashboard`) — canal Brevo PRÓPRIO do editor (#4266/#4476),
 * conta SEPARADA da Clarice. Cobre:
 *   - evaluateBrevoDiariaBreaches: os mesmos circuit breakers da Rampa Clarice
 *     (thresholds.ts) aplicados às stats brutas de uma campanha.
 *   - fetchBrevoDiariaCampaigns: fetch + enrich (lista/stats) com chaves KV
 *     prefixadas `diaria:` (nunca colidem com as chaves da Clarice — mesmo
 *     KV namespace, contas Brevo DIFERENTES podem reusar os mesmos ids).
 *   - fetchBrevoDiariaTabData: null sem secret; write-through de lastgood;
 *     fallback stale em falha; erro explícito sem stale.
 *   - renderDashboardHtml: aba ausente por padrão (regressão — nenhum caller
 *     pré-#4515 deve ver a aba aparecer sem passar opts.brevoDiaria) e aba
 *     presente + alert coloring quando opts.brevoDiaria é passado.
 *
 * Todas as chamadas à API Brevo são mockadas via `_fetchFn` — nunca rede real
 * (guard de dispatch #4515: nunca chamar a API Brevo real neste PR).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBrevoDiariaBreaches,
  fetchBrevoDiariaCampaigns,
  fetchBrevoDiariaTabData,
  renderBrevoDiariaTabPanel,
  renderDashboardHtml,
  BREVO_DIARIA_LASTGOOD_KEY,
  type BrevoDiariaTabData,
} from "../workers/brevo-dashboard/src/index.ts";

function makeKVMock(initialData: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialData));
  const getCalls: string[] = [];
  const putCalls: string[] = [];
  return {
    store,
    getCalls,
    putCalls,
    kv: {
      get: async (key: string, type?: string) => {
        getCalls.push(key);
        const val = store.get(key);
        if (val === undefined) return null;
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

const healthyStats = {
  sent: 100,
  delivered: 98,
  hardBounces: 1,
  softBounces: 1,
  uniqueViews: 40,
  viewed: 44,
  trackableViews: 30,
  uniqueClicks: 8,
  clickers: 7,
  unsubscriptions: 1,
  complaints: 0,
  appleMppOpens: 4,
};

// ─── evaluateBrevoDiariaBreaches ────────────────────────────────────────────

describe("evaluateBrevoDiariaBreaches (#4515)", () => {
  test("stats saudáveis → nenhum breach", () => {
    const flags = evaluateBrevoDiariaBreaches(healthyStats);
    assert.deepStrictEqual(flags, {
      openAlert: false,
      bounceAlert: false,
      spamAlert: false,
      unsubAlert: false,
    });
  });

  test("abertura < 15% (com dado real, >0) → openAlert", () => {
    const flags = evaluateBrevoDiariaBreaches({ ...healthyStats, uniqueViews: 5, delivered: 100 });
    assert.strictEqual(flags.openAlert, true);
  });

  test("abertura 0% (sem dado ainda, uniqueViews=0) → NÃO alerta (dado ainda propagando)", () => {
    const flags = evaluateBrevoDiariaBreaches({ ...healthyStats, uniqueViews: 0 });
    assert.strictEqual(flags.openAlert, false);
  });

  test("bounce duro sozinho >= 2% já dispara (mesmo com total < 5%) — regra OR do #3078", () => {
    const flags = evaluateBrevoDiariaBreaches({ ...healthyStats, sent: 100, hardBounces: 2, softBounces: 0 });
    assert.strictEqual(flags.bounceAlert, true);
  });

  test("bounce total >= 5% dispara mesmo com hard < 2%", () => {
    const flags = evaluateBrevoDiariaBreaches({ ...healthyStats, sent: 100, hardBounces: 1, softBounces: 4 });
    assert.strictEqual(flags.bounceAlert, true);
  });

  test("spam >= 0,3% dispara (limiar ATUAL de thresholds.ts — #4154, oficial Postmaster Tools; a issue #4515 citou 0,1%, que era o valor PRÉ-#4154)", () => {
    // complaints=5/sent=1000 = 0,5% — folgado o bastante pra não flakar por
    // imprecisão de ponto flutuante perto do limiar exato (0,3%).
    const flags = evaluateBrevoDiariaBreaches({ ...healthyStats, sent: 1000, complaints: 5 });
    assert.strictEqual(flags.spamAlert, true);
  });

  test("spam em 0,2% (entre o verde 0,1% e o vermelho 0,3%) NÃO dispara — só >= yellow é breach", () => {
    const flags = evaluateBrevoDiariaBreaches({ ...healthyStats, sent: 1000, complaints: 2 });
    assert.strictEqual(flags.spamAlert, false);
  });

  test("unsub >= 3% dispara", () => {
    const flags = evaluateBrevoDiariaBreaches({ ...healthyStats, sent: 100, unsubscriptions: 3 });
    assert.strictEqual(flags.unsubAlert, true);
  });

  test("sent=0 → nenhum breach de bounce/spam/unsub (denominador zero, nunca NaN/Infinity)", () => {
    const flags = evaluateBrevoDiariaBreaches({ ...healthyStats, sent: 0, delivered: 0 });
    assert.deepStrictEqual(flags, {
      openAlert: false,
      bounceAlert: false,
      spamAlert: false,
      unsubAlert: false,
    });
  });
});

// ─── fetchBrevoDiariaCampaigns ───────────────────────────────────────────────

describe("fetchBrevoDiariaCampaigns (#4515)", () => {
  test("sem BREVO_DIARIA_API_KEY → [] sem nenhuma chamada de rede", async () => {
    let fetchCalled = false;
    const result = await fetchBrevoDiariaCampaigns(
      { BREVO_DIARIA_API_KEY: undefined, STATS_CACHE: undefined },
      20,
      false,
      (async () => { fetchCalled = true; throw new Error("não deveria chamar"); }) as any,
    );
    assert.deepStrictEqual(result, []);
    assert.strictEqual(fetchCalled, false);
  });

  test("busca campanhas + enriquece com nome de lista e globalStats", async () => {
    const fakeCampaign = {
      id: 11,
      name: "Diária Brevo — canário",
      subject: "Assunto",
      status: "sent",
      sentDate: new Date().toISOString(),
      scheduledAt: null,
      createdAt: new Date().toISOString(),
      recipients: { lists: [7] },
    };
    const { kv } = makeKVMock();
    const mockFetch = async <T>(path: string, apiKey: string): Promise<T> => {
      assert.strictEqual(apiKey, "diaria-key-123");
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (path.includes("/v3/contacts/lists/7")) return { id: 7, name: "Diária — Reativação Pending", totalSubscribers: 110 } as T;
      if (path.includes("emailCampaigns/11")) return { statistics: { globalStats: healthyStats } } as T;
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchBrevoDiariaCampaigns(
      { BREVO_DIARIA_API_KEY: "diaria-key-123", STATS_CACHE: kv },
      20,
      false,
      mockFetch as any,
    );
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].listName, "Diária — Reativação Pending");
    assert.strictEqual(result[0].statistics?.globalStats?.sent, 100);
  });

  test("chaves KV usam o prefixo diaria: (nunca colidem com as chaves list:{id}/stats:{id} da Clarice)", async () => {
    const fakeCampaign = {
      id: 42, // MESMO id que o fixture da Clarice em brevo-dashboard-ratelimit.test.ts usa
      name: "Diária Brevo",
      subject: "Assunto",
      status: "sent",
      sentDate: new Date().toISOString(),
      scheduledAt: null,
      createdAt: new Date().toISOString(),
      recipients: { lists: [7] }, // MESMO list id que o fixture da Clarice também usa
    };
    const { kv, putCalls } = makeKVMock();
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (path.includes("/v3/contacts/lists/7")) return { id: 7, name: "Lista Diária", totalSubscribers: 110 } as T;
      if (path.includes("emailCampaigns/42")) return { statistics: { globalStats: healthyStats } } as T;
      throw new Error("path inesperado: " + path);
    };
    await fetchBrevoDiariaCampaigns({ BREVO_DIARIA_API_KEY: "k", STATS_CACHE: kv }, 20, false, mockFetch as any);
    assert.ok(putCalls.includes("diaria:list:7"), "deve gravar sob diaria:list:7, não list:7");
    assert.ok(putCalls.includes("diaria:stats:42"), "deve gravar sob diaria:stats:42, não stats:42");
    assert.ok(!putCalls.includes("list:7"), "NUNCA deve gravar na chave genérica list:7 (colidiria com a Clarice)");
    assert.ok(!putCalls.includes("stats:42"), "NUNCA deve gravar na chave genérica stats:42 (colidiria com a Clarice)");
  });

  test("KV hit (stats) evita 2º fetch de detalhe da campanha", async () => {
    const fakeCampaign = {
      id: 99, name: "X", subject: "Y", status: "sent",
      sentDate: new Date().toISOString(), scheduledAt: null, createdAt: new Date().toISOString(),
      recipients: { lists: [] },
    };
    const { kv } = makeKVMock({ "diaria:stats:99": JSON.stringify(healthyStats) });
    let detailCalled = false;
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (path.includes("emailCampaigns/99")) { detailCalled = true; throw new Error("não deveria chamar"); }
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchBrevoDiariaCampaigns({ BREVO_DIARIA_API_KEY: "k", STATS_CACHE: kv }, 20, false, mockFetch as any);
    assert.strictEqual(detailCalled, false);
    assert.strictEqual(result[0].statistics?.globalStats?.sent, 100);
  });

  test("isFresh=true bypassa o KV mesmo com stats já em cache", async () => {
    const fakeCampaign = {
      id: 99, name: "X", subject: "Y", status: "sent",
      sentDate: new Date().toISOString(), scheduledAt: null, createdAt: new Date().toISOString(),
      recipients: { lists: [] },
    };
    const { kv } = makeKVMock({ "diaria:stats:99": JSON.stringify({ ...healthyStats, sent: 999 }) });
    let detailCalled = false;
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      if (path.includes("emailCampaigns/99")) { detailCalled = true; return { statistics: { globalStats: healthyStats } } as T; }
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchBrevoDiariaCampaigns({ BREVO_DIARIA_API_KEY: "k", STATS_CACHE: kv }, 20, true, mockFetch as any);
    assert.strictEqual(detailCalled, true, "isFresh deve ignorar o cache e buscar ao vivo");
    assert.strictEqual(result[0].statistics?.globalStats?.sent, 100);
  });

  test("falha individual de UMA campanha não derruba as demais (linha cai em 'sem stats')", async () => {
    const campaigns = [
      { id: 1, name: "A", subject: "s", status: "sent", sentDate: new Date().toISOString(), scheduledAt: null, createdAt: new Date().toISOString(), recipients: { lists: [] } },
      { id: 2, name: "B", subject: "s", status: "sent", sentDate: new Date().toISOString(), scheduledAt: null, createdAt: new Date().toISOString(), recipients: { lists: [] } },
    ];
    const { kv } = makeKVMock();
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns } as T;
      if (path.includes("emailCampaigns/1")) throw new Error("500 upstream");
      if (path.includes("emailCampaigns/2")) return { statistics: { globalStats: healthyStats } } as T;
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchBrevoDiariaCampaigns({ BREVO_DIARIA_API_KEY: "k", STATS_CACHE: kv }, 20, false, mockFetch as any);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result.find((c) => c.id === 1)?.statistics?.globalStats, undefined);
    assert.strictEqual(result.find((c) => c.id === 2)?.statistics?.globalStats?.sent, 100);
  });
});

// ─── fetchBrevoDiariaTabData ─────────────────────────────────────────────────

describe("fetchBrevoDiariaTabData (#4515)", () => {
  test("sem BREVO_DIARIA_API_KEY → null (aba oculta)", async () => {
    const result = await fetchBrevoDiariaTabData({ BREVO_DIARIA_API_KEY: undefined, STATS_CACHE: undefined });
    assert.strictEqual(result, null);
  });

  test("sucesso → retorna campanhas e grava lastgood no KV (write-through)", async () => {
    const fakeCampaign = {
      id: 7, name: "Camp", subject: "s", status: "sent",
      sentDate: new Date().toISOString(), scheduledAt: null, createdAt: new Date().toISOString(),
      recipients: { lists: [] },
    };
    const { kv, putCalls } = makeKVMock();
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [fakeCampaign] } as T;
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchBrevoDiariaTabData({ BREVO_DIARIA_API_KEY: "k", STATS_CACHE: kv }, false, mockFetch as any);
    assert.ok(result !== null);
    assert.strictEqual(result!.campaigns.length, 1);
    assert.strictEqual(result!.stale, undefined);
    assert.ok(putCalls.includes(BREVO_DIARIA_LASTGOOD_KEY), "deve gravar o write-through de lastgood");
  });

  test("falha do fetch + stale disponível no KV → stale:true com o error preenchido", async () => {
    const staleCampaigns = [{ id: 5, name: "Stale", listName: "L" }];
    const { kv } = makeKVMock({
      [BREVO_DIARIA_LASTGOOD_KEY]: JSON.stringify({ campaigns: staleCampaigns, generatedAt: "2026-08-01T00:00:00Z" }),
    });
    const mockFetch = async <T>(): Promise<T> => {
      throw new Error("Brevo API /v3/emailCampaigns failed (500): erro simulado");
    };
    const result = await fetchBrevoDiariaTabData({ BREVO_DIARIA_API_KEY: "k", STATS_CACHE: kv }, false, mockFetch as any);
    assert.ok(result !== null);
    assert.strictEqual(result!.stale, true);
    assert.deepStrictEqual(result!.campaigns, staleCampaigns);
    assert.ok(result!.error?.includes("erro simulado"));
  });

  test("falha do fetch SEM stale disponível → campaigns:[] com error preenchido, nunca lança", async () => {
    const { kv } = makeKVMock();
    const mockFetch = async <T>(): Promise<T> => {
      throw new Error("network error simulado");
    };
    const result = await fetchBrevoDiariaTabData({ BREVO_DIARIA_API_KEY: "k", STATS_CACHE: kv }, false, mockFetch as any);
    assert.ok(result !== null);
    assert.strictEqual(result!.stale, undefined);
    assert.deepStrictEqual(result!.campaigns, []);
    assert.ok(result!.error?.includes("network error simulado"));
  });
});

// ─── renderBrevoDiariaTabPanel ───────────────────────────────────────────────

describe("renderBrevoDiariaTabPanel (#4515)", () => {
  test("data=null → string vazia", () => {
    assert.strictEqual(renderBrevoDiariaTabPanel(null), "");
  });

  test("campanha saudável → sem classe alert nas células de métrica", () => {
    const data: BrevoDiariaTabData = {
      campaigns: [{
        id: 1, name: "Camp A", subject: "s", status: "sent",
        sentDate: new Date().toISOString(), scheduledAt: null, createdAt: new Date().toISOString(),
        recipients: { lists: [] }, listName: "Lista X",
        statistics: { globalStats: healthyStats },
      }],
      generatedAt: new Date().toISOString(),
    };
    const html = renderBrevoDiariaTabPanel(data);
    assert.ok(html.includes("Lista X"));
    assert.ok(!html.includes('class="alert"'), "campanha saudável não deve ter célula alert isolada");
  });

  test("bounce duro alto → célula com class alert", () => {
    const data: BrevoDiariaTabData = {
      campaigns: [{
        id: 2, name: "Camp B", subject: "s", status: "sent",
        sentDate: new Date().toISOString(), scheduledAt: null, createdAt: new Date().toISOString(),
        recipients: { lists: [] }, listName: "Lista Y",
        statistics: { globalStats: { ...healthyStats, sent: 100, hardBounces: 5, softBounces: 0 } },
      }],
      generatedAt: new Date().toISOString(),
    };
    const html = renderBrevoDiariaTabPanel(data);
    assert.ok(html.includes('class="alert"'), "bounce duro 5% deveria colorir a célula");
  });

  test("campanha sem stats → linha 'sem stats', sem lançar", () => {
    const data: BrevoDiariaTabData = {
      campaigns: [{
        id: 3, name: "Camp C", subject: "s", status: "sent",
        sentDate: new Date().toISOString(), scheduledAt: null, createdAt: new Date().toISOString(),
        recipients: { lists: [] }, listName: "?",
      }],
      generatedAt: new Date().toISOString(),
    };
    const html = renderBrevoDiariaTabPanel(data);
    assert.ok(html.includes("sem stats"));
  });

  test("stale:true → banner amarelo de defasagem", () => {
    const data: BrevoDiariaTabData = {
      campaigns: [],
      generatedAt: new Date().toISOString(),
      stale: true,
      error: "network error",
    };
    const html = renderBrevoDiariaTabPanel(data);
    assert.ok(html.includes("último dado bom conhecido"));
    assert.ok(html.includes("network error"));
  });

  test("error sem stale → banner vermelho, campanhas vazias", () => {
    const data: BrevoDiariaTabData = {
      campaigns: [],
      generatedAt: new Date().toISOString(),
      error: "chave inválida",
    };
    const html = renderBrevoDiariaTabPanel(data);
    assert.ok(html.includes("Falha ao buscar campanhas"));
    assert.ok(html.includes("chave inválida"));
  });

  test("nota sobre a fila de contatos (data/brevo-diaria/contacts.json) sempre presente — limitação documentada (#4515)", () => {
    const html = renderBrevoDiariaTabPanel({ campaigns: [], generatedAt: new Date().toISOString() });
    assert.ok(html.includes("contacts.json"));
  });
});

// ─── renderDashboardHtml — regressão de opt-in por opts.brevoDiaria ──────────

describe("renderDashboardHtml — aba brevo_diaria (#4515)", () => {
  test("regressão: opts.brevoDiaria ausente (default) → aba NUNCA aparece", () => {
    const html = renderDashboardHtml([]);
    assert.ok(!html.includes('id="tab-brevodiaria"'));
    assert.ok(!html.includes('id="panel-brevodiaria"'));
  });

  test("regressão: opts.brevoDiaria=null explícito → aba não aparece", () => {
    const html = renderDashboardHtml([], [], null, null, null, null, null, null, null, null, null, { brevoDiaria: null });
    assert.ok(!html.includes('id="tab-brevodiaria"'));
  });

  test("opts.brevoDiaria presente → aba aparece com o conteúdo da campanha", () => {
    const brevoDiaria: BrevoDiariaTabData = {
      campaigns: [{
        id: 1, name: "Camp A", subject: "s", status: "sent",
        sentDate: new Date().toISOString(), scheduledAt: null, createdAt: new Date().toISOString(),
        recipients: { lists: [] }, listName: "Lista Diária",
        statistics: { globalStats: healthyStats },
      }],
      generatedAt: new Date().toISOString(),
    };
    const html = renderDashboardHtml([], [], null, null, null, null, null, null, null, null, null, { brevoDiaria });
    assert.ok(html.includes('id="tab-brevodiaria"'));
    assert.ok(html.includes('id="panel-brevodiaria"'));
    assert.ok(html.includes("Lista Diária"));
  });

  test("opts.brevoDiaria com campaigns:[] e error → aba aparece com banner (nunca esconde a falha)", () => {
    const brevoDiaria: BrevoDiariaTabData = { campaigns: [], generatedAt: new Date().toISOString(), error: "boom" };
    const html = renderDashboardHtml([], [], null, null, null, null, null, null, null, null, null, { brevoDiaria });
    assert.ok(html.includes('id="tab-brevodiaria"'));
    assert.ok(html.includes("boom"));
  });
});
