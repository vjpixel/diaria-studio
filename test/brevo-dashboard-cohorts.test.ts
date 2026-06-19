/**
 * #2426: coortes de engajamento por contato no clarice-dashboard.
 *
 * Cobre:
 *  - computeCohorts: partição mutuamente exclusiva + precedência de saída
 *    (bounce/unsub ganha de open), bucketing por (recebido, aberto), universo,
 *    maxReceived e breakdown disjunto (bounced + optedOut = exits).
 *  - normalizeContact: shapes reais da Brevo (unsubscriptions é OBJETO, bounce
 *    tem prioridade sobre optedOut no breakdown).
 *  - renderEngagementCohortsSection: stub gracioso (null), contagens, rótulo "2+".
 *  - renderDashboardHtml injeta a seção.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCohorts,
  normalizeContact,
  type ContactEngagement,
} from "../scripts/clarice-engagement-cohorts.ts";
import {
  renderEngagementCohortsSection,
  renderDashboardHtml,
  type EngagementCohorts,
} from "../workers/brevo-dashboard/src/index.ts";

const GEN = "2026-06-19T12:00:00Z";

function eng(p: Partial<ContactEngagement>): ContactEngagement {
  return { received: 0, opened: 0, bounced: false, optedOut: false, ...p };
}

test("computeCohorts: bucketiza por (recebido, aberto) sem saídas", () => {
  const r = computeCohorts(
    [
      eng({ received: 2, opened: 2 }), // opened2plus
      eng({ received: 3, opened: 5 }), // opened2plus (>=2)
      eng({ received: 2, opened: 1 }), // opened1
      eng({ received: 1, opened: 1 }), // opened1
      eng({ received: 1, opened: 0 }), // received1_opened0
      eng({ received: 2, opened: 0 }), // received2_opened0
      eng({ received: 4, opened: 0 }), // received2_opened0 (>=2)
    ],
    GEN,
  );
  assert.equal(r.opened2plus, 2);
  assert.equal(r.opened1, 2);
  assert.equal(r.received1_opened0, 1);
  assert.equal(r.received2_opened0, 2);
  assert.equal(r.exits, 0);
  assert.equal(r.universe, 7);
  assert.equal(r.maxReceived, 4);
});

test("computeCohorts: saída tem precedência — bounce/unsub nunca conta em coorte de open", () => {
  const r = computeCohorts(
    [
      eng({ received: 2, opened: 2, bounced: true }), // saída (não opened2plus)
      eng({ received: 1, opened: 1, optedOut: true }), // saída (não opened1)
      eng({ received: 0, opened: 0, bounced: true }), // saída via bounce sem entrega
      eng({ received: 2, opened: 2 }), // opened2plus
    ],
    GEN,
  );
  assert.equal(r.exits, 3);
  assert.equal(r.opened2plus, 1);
  assert.equal(r.opened1, 0);
  // breakdown disjunto: 2 bounce + 1 optedOut = 3 exits
  assert.equal(r.exitsBreakdown.bounced, 2);
  assert.equal(r.exitsBreakdown.optedOut, 1);
  assert.equal(
    r.exitsBreakdown.bounced + r.exitsBreakdown.optedOut,
    r.exits,
  );
});

test("computeCohorts: partição completa — cada contato em exatamente uma coorte", () => {
  const contacts = [
    eng({ received: 2, opened: 2 }),
    eng({ received: 1, opened: 1 }),
    eng({ received: 1, opened: 0 }),
    eng({ received: 2, opened: 0 }),
    eng({ received: 2, opened: 1, bounced: true }),
    eng({ received: 5, opened: 3 }),
  ];
  const r = computeCohorts(contacts, GEN);
  const sum =
    r.opened2plus + r.opened1 + r.received1_opened0 + r.received2_opened0 + r.exits;
  assert.equal(sum, r.universe);
  assert.equal(r.universe, contacts.length);
});

test("computeCohorts: contatos fora do universo (received 0, opened 0, sem saída) são ignorados", () => {
  const r = computeCohorts(
    [eng({ received: 0, opened: 0 }), eng({ received: 1, opened: 0 })],
    GEN,
  );
  assert.equal(r.universe, 1);
  assert.equal(r.received1_opened0, 1);
});

test("computeCohorts: opened>0 com received=0 (anomalia Brevo) é contado, não descartado", () => {
  const r = computeCohorts(
    [eng({ received: 0, opened: 2 }), eng({ received: 0, opened: 1 })],
    GEN,
  );
  assert.equal(r.universe, 2);
  assert.equal(r.opened2plus, 1);
  assert.equal(r.opened1, 1);
});

test("normalizeContact: bounce (hard/soft) detectado; unsubscriptions é objeto", () => {
  const c = normalizeContact({
    statistics: {
      messagesSent: [{}, {}],
      opened: [{}],
      softBounces: [{}],
      unsubscriptions: { userUnsubscription: [], adminUnsubscription: [] },
    },
  });
  assert.equal(c.received, 2);
  assert.equal(c.opened, 1);
  assert.equal(c.bounced, true);
  assert.equal(c.optedOut, false); // bounce tem prioridade — optedOut fica false
});

test("normalizeContact: unsub via objeto userUnsubscription marca optedOut", () => {
  const c = normalizeContact({
    statistics: {
      messagesSent: [{}],
      unsubscriptions: { userUnsubscription: [{ campaignId: 1 }], adminUnsubscription: [] },
    },
  });
  assert.equal(c.optedOut, true);
  assert.equal(c.bounced, false);
});

test("normalizeContact: emailBlacklisted marca optedOut quando não há bounce", () => {
  const c = normalizeContact({ emailBlacklisted: true, statistics: { messagesSent: [{}] } });
  assert.equal(c.optedOut, true);
});

test("normalizeContact: bounce + blacklist → bounced, optedOut false (sem dupla contagem)", () => {
  const c = normalizeContact({
    emailBlacklisted: true,
    statistics: { hardBounces: [{}] },
  });
  assert.equal(c.bounced, true);
  assert.equal(c.optedOut, false);
});

const SAMPLE: EngagementCohorts = {
  generatedAt: GEN,
  universe: 1000,
  opened2plus: 100,
  opened1: 200,
  received1_opened0: 300,
  received2_opened0: 250,
  exits: 150,
  exitsBreakdown: { bounced: 90, optedOut: 60 },
  maxReceived: 2,
};

test("renderEngagementCohortsSection: stub gracioso quando null", () => {
  const html = renderEngagementCohortsSection(null);
  assert.match(html, /Coortes de engajamento/);
  assert.match(html, /clarice-engagement-cohorts/);
});

test("renderEngagementCohortsSection: renderiza contagens e universo", () => {
  const html = renderEngagementCohortsSection(SAMPLE);
  assert.match(html, /1\.000 contatos no universo/);
  assert.match(html, /100/); // opened2plus
  assert.match(html, /Saídas/);
  assert.match(html, /exatamente uma/); // explica exclusividade
});

test("renderEngagementCohortsSection: rótulos dos buckets ≥2 são sempre '2+' (independente de maxReceived)", () => {
  // O bucket é definido como ≥2, então "2+" é sempre exato — não acopla a maxReceived.
  assert.match(renderEngagementCohortsSection(SAMPLE), /Abriu 2\+ e-mails/);
  assert.match(renderEngagementCohortsSection(SAMPLE), /Recebeu 2\+, não abriu/);
  const big = { ...SAMPLE, maxReceived: 4 };
  assert.match(renderEngagementCohortsSection(big), /Abriu 2\+ e-mails/);
});

test("renderDashboardHtml: injeta a seção de coortes quando fornecida", () => {
  const html = renderDashboardHtml([], [], SAMPLE);
  assert.match(html, /id="engagement-cohorts"/);
  assert.match(html, /1\.000 contatos no universo/);
});

test("renderDashboardHtml: seção mostra stub quando cohorts ausente (default null)", () => {
  const html = renderDashboardHtml([]);
  assert.match(html, /id="engagement-cohorts"/);
  assert.match(html, /clarice-engagement-cohorts/);
});
