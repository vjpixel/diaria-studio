import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateRisk, toOpenTrendPoints, toSpamSignalLike, fetchRiskSnapshot } from "../scripts/clarice-envio-risk.ts";
import { TransientDashboardError } from "../scripts/lib/transient-dashboard-error.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

function campaign(over: Partial<BrevoCampaign> & { sentDate: string }): BrevoCampaign {
  return {
    id: 1,
    name: "x",
    subject: "x",
    status: "sent",
    scheduledAt: null,
    createdAt: over.sentDate,
    recipients: { lists: [1] },
    ...over,
  } as BrevoCampaign;
}

function withGlobalStats(over: Partial<BrevoCampaign>, stats: Record<string, number>): BrevoCampaign {
  return campaign({ ...over, sentDate: over.sentDate as string, statistics: { globalStats: stats as any } });
}

describe("aggregateRisk", () => {
  it("soma sent/delivered/hardBounces/bounces/unsub de várias campanhas", () => {
    const cs = [
      withGlobalStats({ sentDate: "2026-08-01T09:00:00.000Z" }, { sent: 1000, delivered: 990, hardBounces: 10, softBounces: 5, unsubscriptions: 8, uniqueViews: 100 }),
      withGlobalStats({ sentDate: "2026-08-02T09:00:00.000Z" }, { sent: 500, delivered: 480, hardBounces: 5, softBounces: 3, unsubscriptions: 2, uniqueViews: 40 }),
    ];
    const r = aggregateRisk(cs);
    assert.equal(r.sent, 1500);
    assert.equal(r.delivered, 1470);
    // hardBounce: 15/1500 = 1%
    assert.ok(Math.abs(r.hardBounceRatePct - 1.0) < 1e-9);
    // bounce total: (15+8)/1500 = 1.5333...%
    assert.ok(Math.abs(r.bounceRatePct - (23 / 1500) * 100) < 1e-9);
    // unsub: 10/1500
    assert.ok(Math.abs(r.unsubRatePct - (10 / 1500) * 100) < 1e-9);
  });

  it("array vazio => zeros, nunca NaN", () => {
    const r = aggregateRisk([]);
    assert.equal(r.sent, 0);
    assert.equal(r.hardBounceRatePct, 0);
    assert.equal(r.bounceRatePct, 0);
    assert.equal(r.unsubRatePct, 0);
  });

  it("campanha sem statistics utilizável (pickStats null) é ignorada, não quebra a soma", () => {
    const cs = [
      campaign({ sentDate: "2026-08-01T09:00:00.000Z", statistics: {} }),
      withGlobalStats({ sentDate: "2026-08-02T09:00:00.000Z" }, { sent: 100, delivered: 95, hardBounces: 1, softBounces: 0, unsubscriptions: 0, uniqueViews: 10 }),
    ];
    const r = aggregateRisk(cs);
    assert.equal(r.sent, 100);
  });
});

describe("toOpenTrendPoints", () => {
  it("1 ponto por dia BRT, delivered/uniqueViews somados dentro do dia", () => {
    const cs = [
      withGlobalStats({ sentDate: "2026-08-01T09:00:00.000Z" }, { sent: 100, delivered: 100, hardBounces: 0, softBounces: 0, unsubscriptions: 0, uniqueViews: 20 }),
      withGlobalStats({ sentDate: "2026-08-01T09:05:00.000Z" }, { sent: 100, delivered: 100, hardBounces: 0, softBounces: 0, unsubscriptions: 0, uniqueViews: 10 }), // célula B do mesmo dia
      withGlobalStats({ sentDate: "2026-08-02T09:00:00.000Z" }, { sent: 50, delivered: 50, hardBounces: 0, softBounces: 0, unsubscriptions: 0, uniqueViews: 5 }),
    ];
    const points = toOpenTrendPoints(cs);
    assert.equal(points.length, 2);
    const d1 = points.find((p) => p.dayKey === "2026-08-01");
    assert.ok(d1);
    assert.equal(d1!.delivered, 200);
    assert.equal(d1!.uniqueViews, 30);
  });
});

describe("toSpamSignalLike — adaptador do shape flat do worker pra união discriminada do motor", () => {
  it("postmaster com ratePct numérico vira {source:postmaster, ratePct:number}", () => {
    assert.deepEqual(toSpamSignalLike({ source: "postmaster", ratePct: 0.05 }), { source: "postmaster", ratePct: 0.05 });
  });

  it("indeterminate vira {source:indeterminate, ratePct:null}", () => {
    assert.deepEqual(toSpamSignalLike({ source: "indeterminate", ratePct: null }), { source: "indeterminate", ratePct: null });
  });

  it("estado impossível (postmaster + ratePct null) degrada pra indeterminate, nunca lança", () => {
    assert.deepEqual(toSpamSignalLike({ source: "postmaster", ratePct: null }), { source: "indeterminate", ratePct: null });
  });
});

describe("fetchRiskSnapshot — smoke test com fetch fake (sem rede real)", () => {
  it("monta o snapshot a partir de uma resposta fake do dashboard", async () => {
    const now = new Date("2026-08-11T22:00:00Z");
    const fakeCampaigns: BrevoCampaign[] = [
      withGlobalStats({ sentDate: "2026-08-11T09:00:00.000Z" }, { sent: 3000, delivered: 2980, hardBounces: 14, softBounces: 13, unsubscriptions: 15, uniqueViews: 335 }),
      withGlobalStats({ sentDate: "2026-08-10T09:00:00.000Z" }, { sent: 800, delivered: 790, hardBounces: 3, softBounces: 2, unsubscriptions: 4, uniqueViews: 30 }),
    ];
    const fakeFetch = (async (url: string) => {
      if (String(url).includes("/api/campaigns")) {
        return new Response(JSON.stringify(fakeCampaigns), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url).includes("/api/postmaster-spam")) {
        return new Response(JSON.stringify({ entry: null }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`fakeFetch: URL inesperada ${url}`);
    }) as typeof fetch;

    const snapshot = await fetchRiskSnapshot({ dashboardUrl: "https://fake.example", now, fetchFn: fakeFetch });
    assert.equal(snapshot.spamSignal.source, "indeterminate", "sem entry no postmaster-spam => indeterminate");
    assert.ok(["ok", "hold", "stop"].includes(snapshot.brake.level));
    assert.ok(snapshot.step >= 0 && snapshot.step <= 0.25);
    assert.equal(snapshot.freshWindow.sent, 3800); // ambas campanhas caem nos últimos 3 dias de envio
  });

  // #5220 — mesma distinção transitório/estrutural de clarice-plan-wave.ts
  // (#5058), agora também neste script (guard das 05:00 depende disso pra
  // retentar em vez de abortar antes de reavaliar o freio).
  it("503 do dashboard => TransientDashboardError com retryAfterSecs extraído do header, NUNCA Error genérico", async () => {
    const fakeFetch = (async () =>
      new Response("rate limited", { status: 503, headers: { "retry-after": "12" } })) as typeof fetch;
    await assert.rejects(
      () => fetchRiskSnapshot({ dashboardUrl: "https://fake.example", now: new Date(), fetchFn: fakeFetch }),
      (err: unknown) => {
        assert.ok(err instanceof TransientDashboardError, `esperado TransientDashboardError, veio ${err}`);
        assert.equal((err as TransientDashboardError).retryAfterSecs, 12);
        assert.equal((err as TransientDashboardError).status, 503);
        return true;
      },
    );
  });

  it("429 do dashboard => também TransientDashboardError (defensivo)", async () => {
    const fakeFetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    await assert.rejects(
      () => fetchRiskSnapshot({ dashboardUrl: "https://fake.example", now: new Date(), fetchFn: fakeFetch }),
      (err: unknown) => {
        assert.ok(err instanceof TransientDashboardError);
        assert.equal((err as TransientDashboardError).retryAfterSecs, null, "sem header Retry-After => null, nunca inventa valor");
        return true;
      },
    );
  });

  it("500/outro status NÃO-transitório => Error genérico, nunca TransientDashboardError (não é retentável às cegas)", async () => {
    const fakeFetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await assert.rejects(
      () => fetchRiskSnapshot({ dashboardUrl: "https://fake.example", now: new Date(), fetchFn: fakeFetch }),
      (err: unknown) => {
        assert.ok(!(err instanceof TransientDashboardError), "500 não é rate limit — não deve sinalizar retry");
        return true;
      },
    );
  });
});
