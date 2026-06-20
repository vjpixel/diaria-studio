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
  remainingRefs,
  shouldResume,
  MAX_RESUME_AGE_H,
  type ContactEngagement,
  type ContactRef,
  type Checkpoint,
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

// ─── Checkpoint / resume (resiliência a rate-limit) ──────────────────────────

const REF = (id: number): ContactRef => ({ id, blacklisted: false });
const ENG = (): ContactEngagement => ({ received: 1, opened: 0, bounced: false, optedOut: false });

test("remainingRefs: filtra ids já buscados (resume não re-gasta GETs)", () => {
  const refs = [REF(1), REF(2), REF(3)];
  const done = { "1": ENG(), "3": ENG() };
  const rem = remainingRefs(refs, done);
  assert.deepEqual(rem.map((r) => r.id), [2]);
});

test("remainingRefs: nada feito → todos pendentes; tudo feito → vazio", () => {
  const refs = [REF(1), REF(2)];
  assert.equal(remainingRefs(refs, {}).length, 2);
  assert.equal(remainingRefs(refs, { "1": ENG(), "2": ENG() }).length, 0);
});

const NOW = Date.parse("2026-06-19T12:00:00Z");
function cp(startedAt: string, scope: "emailed" | "all" = "emailed"): Checkpoint {
  return { startedAt, scope, refs: [REF(1)], done: {} };
}

test("shouldResume: null ou escopo diferente → false", () => {
  assert.equal(shouldResume(null, NOW, "emailed"), false);
  assert.equal(shouldResume(cp("2026-06-19T11:00:00Z", "all"), NOW, "emailed"), false);
});

test("shouldResume: checkpoint recente do mesmo escopo → true", () => {
  assert.equal(shouldResume(cp("2026-06-19T11:00:00Z"), NOW, "emailed"), true);
});

test("shouldResume: checkpoint antigo (> MAX_RESUME_AGE_H) → false (recomeça)", () => {
  const old = new Date(NOW - (MAX_RESUME_AGE_H + 1) * 3_600_000).toISOString();
  assert.equal(shouldResume(cp(old), NOW, "emailed"), false);
});

test("shouldResume: startedAt inválido ou no futuro → false", () => {
  assert.equal(shouldResume(cp("não-é-data"), NOW, "emailed"), false);
  assert.equal(shouldResume(cp("2026-06-20T12:00:00Z"), NOW, "emailed"), false);
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
  // #2429: rótulo atualizado para "pessoas únicas alcançadas" (≠ eventos de envio)
  assert.match(html, /1\.000 pessoas únicas alcançadas/);
  assert.match(html, /100/); // opened2plus
  assert.match(html, /Saídas/);
  assert.match(html, /exatamente uma/); // explica exclusividade
});

// #2429: testa novos rótulos e tooltips que distinguem pessoas únicas de eventos de envio
test("renderEngagementCohortsSection: #2429 rótulo 'Pessoas únicas alcançadas' e tooltip de dedupagem", () => {
  const html = renderEngagementCohortsSection(SAMPLE);
  // Rótulo principal do universo
  assert.match(html, /pessoas únicas alcançadas/i, "deve usar rótulo 'pessoas únicas alcançadas'");
  // Tooltip com explicação de dedupagem
  assert.match(html, /title="[^"]*únicos dedupados[^"]*"/, "deve ter tooltip explicando deduplicação");
  // Coluna da tabela deve ser "Pessoas únicas", não apenas "Pessoas"
  assert.match(html, /Pessoas únicas<\/th>/, "coluna deve ser 'Pessoas únicas'");
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
  // #2429: rótulo atualizado para "pessoas únicas alcançadas"
  assert.match(html, /1\.000 pessoas únicas alcançadas/);
});

test("renderDashboardHtml: seção mostra stub quando cohorts ausente (default null)", () => {
  const html = renderDashboardHtml([]);
  assert.match(html, /id="engagement-cohorts"/);
  assert.match(html, /clarice-engagement-cohorts/);
});
