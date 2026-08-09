/**
 * test/brevo-dashboard-campaigns-include-scheduled-4786.test.ts (#4786)
 *
 * Regressão: `GET /api/campaigns` só devolvia `status=sent`
 * (`fetchRecentCampaigns`) -- deliberado (a aba Rampa consome métricas de
 * envio, que só existem PÓS-disparo), mas isso deixava
 * `scripts/clarice-plan-wave.ts` estruturalmente cego a campanha `queued`
 * real: `state.scheduledCount` nunca subia de 0, mesmo com onda recém-
 * agendada na Brevo (repro da issue: 3 campanhas `queued` reais, dashboard
 * só via `sent`, "Verificação final" da skill `/diaria-clarice-envio`
 * apontava um falso negativo garantido).
 *
 * Fix: `?includeScheduled=1` anexa `fetchScheduledCampaigns` (já usada pela
 * rota `/` pra seção "Agendadas") ao array de resposta -- opt-in, o default
 * (ausente) preserva o shape de sempre, byte a byte. Consumidor: `clarice-
 * plan-wave.ts` passa o parâmetro; `summarizeCycleSends` (já testada em
 * `test/clarice-wave-plan.test.ts`) então enxerga as campanhas `queued` e
 * classifica corretamente em `state.scheduledCount`.
 *
 * Fixtures 100% sintéticas -- nenhum id/email real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { buildInflightCoalescedCampaignsJson, LASTGOOD_CAMPAIGNS_KEY } from "../workers/brevo-dashboard/src/index.ts";
import { summarizeCycleSends } from "../scripts/lib/clarice-wave-plan.ts";

// Cache API sempre em cache-miss -- mesmo polyfill de
// test/brevo-dashboard-thundering-herd-3644.test.ts, força live-fetch.
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
  } as any;
}

const sentDate = "2026-08-01T09:00:00.000Z";
const sentCampaign = {
  id: 126,
  name: "Clarice 2608 grupo:d9-dom09-A",
  subject: "Assunto sintético",
  status: "sent",
  sentDate,
  scheduledAt: null,
  createdAt: sentDate,
  recipients: { lists: [88] as number[] },
};
const queuedCampaign = {
  id: 999,
  name: "Clarice 2608 grupo:d11-qua12-A",
  subject: "Assunto sintético — agendada",
  status: "queued",
  sentDate: null,
  scheduledAt: "2026-08-12T09:00:00.000Z",
  createdAt: "2026-08-09T00:00:00.000Z",
  recipients: { lists: [118] as number[] },
};
const globalStats = {
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
      return new Response(JSON.stringify({ campaigns: [sentCampaign] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("emailCampaigns?status=queued")) {
      return new Response(JSON.stringify({ campaigns: [queuedCampaign] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes(`emailCampaigns/${sentCampaign.id}`)) {
      return new Response(JSON.stringify({ ...sentCampaign, statistics: { globalStats } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/contacts/lists/")) {
      return new Response(JSON.stringify({ id: 1, name: "lista", totalSubscribers: 10 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEnv(kv: any) {
  return { BREVO_API_KEY: "k", STATS_CACHE: kv };
}

describe("GET /api/campaigns — includeScheduled (#4786)", () => {
  it("default (ausente) devolve SÓ enviadas — shape preservado byte a byte", async () => {
    const { kv } = { kv: makeKvMock() };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const res = await worker.fetch(new Request("http://localhost/api/campaigns"), makeEnv(kv));
      assert.equal(res.status, 200);
      const body = (await res.json()) as Array<{ id: number; status: string }>;
      assert.equal(body.length, 1);
      assert.equal(body[0].id, sentCampaign.id);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("?includeScheduled=1 anexa também as agendadas (status=queued)", async () => {
    const { kv } = { kv: makeKvMock() };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const res = await worker.fetch(new Request("http://localhost/api/campaigns?includeScheduled=1"), makeEnv(kv));
      assert.equal(res.status, 200);
      const body = (await res.json()) as Array<{ id: number; status: string }>;
      assert.equal(body.length, 2, "esperado 1 enviada + 1 agendada");
      const ids = body.map((c) => c.id).sort();
      assert.deepEqual(ids, [sentCampaign.id, queuedCampaign.id].sort());
      const queued = body.find((c) => c.id === queuedCampaign.id)!;
      assert.equal(queued.status, "queued");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("REGRESSÃO (achado real da issue): sem includeScheduled, campanha agendada é INVISÍVEL — com, aparece", async () => {
    const { kv } = { kv: makeKvMock() };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockBrevoFetch();
    try {
      const withoutParam = await (await worker.fetch(new Request("http://localhost/api/campaigns"), makeEnv(kv))).json();
      assert.ok(
        !(withoutParam as Array<{ id: number }>).some((c) => c.id === queuedCampaign.id),
        "sem o parâmetro, a campanha agendada não deveria aparecer (comportamento pré-#4786 preservado)",
      );
      const withParam = await (
        await worker.fetch(new Request("http://localhost/api/campaigns?includeScheduled=1"), makeEnv(kv))
      ).json();
      assert.ok(
        (withParam as Array<{ id: number }>).some((c) => c.id === queuedCampaign.id),
        "com o parâmetro, a campanha agendada deve aparecer",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("buildInflightCoalescedCampaignsJson — includeScheduled (#4786)", () => {
  it("default (false) não anexa scheduled mesmo presente no KV stale", async () => {
    const kv = makeKvMock({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({ campaigns: [sentCampaign], scheduled: [queuedCampaign] }),
    });
    const resp = await buildInflightCoalescedCampaignsJson({ STATS_CACHE: kv }, 50);
    const body = (await resp!.json()) as unknown[];
    assert.equal(body.length, 1);
  });

  it("includeScheduled=true anexa scheduled do mesmo KV stale", async () => {
    const kv = makeKvMock({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({ campaigns: [sentCampaign], scheduled: [queuedCampaign] }),
    });
    const resp = await buildInflightCoalescedCampaignsJson({ STATS_CACHE: kv }, 50, true);
    const body = (await resp!.json()) as Array<{ id: number }>;
    assert.equal(body.length, 2);
    assert.ok(body.some((c) => c.id === queuedCampaign.id));
  });
});

describe("state.scheduledCount enxerga campanha queued quando alimentado pelo array merged (#4786)", () => {
  it("summarizeCycleSends classifica a campanha queued/futura em scheduledCount, não em sentCount", () => {
    // Simula exatamente o array que /api/campaigns?includeScheduled=1
    // devolveria -- enviada + agendada, com listName já enriquecido (o mesmo
    // enriquecimento que clarice-plan-wave.ts's enrichWithLists faz).
    const merged = [
      { ...sentCampaign, listName: "Clarice 2607-08 d9-dom09-A — célula A", listSize: 500 },
      { ...queuedCampaign, listName: "Clarice 2607-08 d11-qua12-A — célula A", listSize: 400 },
    ];
    const now = new Date("2026-08-09T12:00:00.000Z"); // depois do sent, antes do queued
    const state = summarizeCycleSends(merged, "2607-08", now);
    assert.equal(state.waves.length, 2);
    assert.equal(state.sentCount, 1);
    assert.equal(state.scheduledCount, 1, "a campanha queued deveria contar como agendada, não sumir (era sempre 0 antes do #4786)");
  });
});
