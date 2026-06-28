import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrevoContact, latestEventTime } from "../scripts/lib/brevo-stats.ts";
import {
  openClariceDb,
  makeBrevoUpsert,
  recomputeDerived,
} from "../scripts/lib/clarice-db.ts";

// ---------------------------------------------------------------------------
// latestEventTime
// ---------------------------------------------------------------------------

test("latestEventTime: vazio/ausente → null", () => {
  assert.equal(latestEventTime([]), null);
  assert.equal(latestEventTime(undefined), null);
  assert.equal(latestEventTime(null), null);
});

test("latestEventTime: pega o evento mais recente", () => {
  const r = latestEventTime([
    { eventTime: "2026-01-01T10:00:00Z" },
    { eventTime: "2026-06-01T10:00:00Z" },
    { eventTime: "2026-03-01T10:00:00Z" },
  ]);
  assert.equal(r, "2026-06-01T10:00:00.000Z");
});

test("latestEventTime: tolera nomes alternativos de campo + ignora não-objetos", () => {
  const r = latestEventTime([
    "lixo",
    { messageSentTime: "2026-02-01T00:00:00Z" },
    { date: "2026-05-01T00:00:00Z" },
  ]);
  assert.equal(r, "2026-05-01T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// parseBrevoContact
// ---------------------------------------------------------------------------

test("parseBrevoContact: contato sem statistics → tudo-zero, não lança", () => {
  const c = parseBrevoContact({ email: "X@Y.com" });
  assert.equal(c.email, "x@y.com");
  assert.equal(c.opens_count, 0);
  assert.equal(c.sends_count, 0);
  assert.equal(c.email_blacklisted, 0);
  assert.equal(c.unsubscribed, 0);
  assert.equal(c.last_open_at, null);
  assert.equal(c.brevo_list_ids, "[]");
});

test("parseBrevoContact: conta campanhas + extrai last_* + attributes + listIds", () => {
  const c = parseBrevoContact({
    email: "ana@x.com",
    listIds: [3, 7],
    createdAt: "2025-01-01T00:00:00Z",
    modifiedAt: "2026-06-01T00:00:00Z",
    attributes: { RECENCY_QUARTIL: "Q1" },
    statistics: {
      messagesSent: [{ eventTime: "2026-05-01T00:00:00Z" }, { eventTime: "2026-06-01T00:00:00Z" }, {}],
      opened: [{ eventTime: "2026-05-02T00:00:00Z" }, { eventTime: "2026-06-02T00:00:00Z" }],
      clicked: [{ eventTime: "2026-06-03T00:00:00Z" }],
      softBounces: [{ eventTime: "2026-04-01T00:00:00Z" }],
    },
  });
  assert.equal(c.sends_count, 3);
  assert.equal(c.opens_count, 2);
  assert.equal(c.clicks_count, 1);
  assert.equal(c.soft_bounce_count, 1);
  assert.equal(c.last_sent_at, "2026-06-01T00:00:00.000Z");
  assert.equal(c.last_open_at, "2026-06-02T00:00:00.000Z");
  assert.equal(c.recency_quartil, "Q1");
  assert.equal(c.brevo_list_ids, "[3,7]");
  assert.equal(c.brevo_created_at, "2025-01-01T00:00:00Z");
});

test("parseBrevoContact: emailBlacklisted → unsubscribed=1 + email_blacklisted=1", () => {
  const c = parseBrevoContact({ email: "a@x.com", emailBlacklisted: true });
  assert.equal(c.email_blacklisted, 1);
  assert.equal(c.unsubscribed, 1);
});

test("parseBrevoContact: listUnsubscribed não-vazio → unsubscribed=1", () => {
  const c = parseBrevoContact({ email: "a@x.com", listUnsubscribed: [5] });
  assert.equal(c.unsubscribed, 1);
  assert.equal(c.email_blacklisted, 0);
});

test("parseBrevoContact: evento de unsubscription → unsubscribed=1", () => {
  const c = parseBrevoContact({
    email: "a@x.com",
    statistics: { unsubscriptions: [{ eventTime: "2026-06-01T00:00:00Z" }] },
  });
  assert.equal(c.unsubscribed, 1);
});

test("parseBrevoContact: hard bounce / complaint → flags", () => {
  const c = parseBrevoContact({
    email: "a@x.com",
    statistics: {
      hardBounces: [{ eventTime: "2026-06-01T00:00:00Z" }],
      complaints: [{ eventTime: "2026-06-02T00:00:00Z" }],
    },
  });
  assert.equal(c.hard_bounced, 1);
  assert.equal(c.complained, 1);
});

// ---------------------------------------------------------------------------
// Integração: sync do Brevo torna send_eligible autoritativo (#2647 follow-up)
// ---------------------------------------------------------------------------

test("upsert Brevo + recompute: descadastro do Brevo passa a suprimir", () => {
  const db = openClariceDb(":memory:");
  // usuário Stripe ativo, antes do sync: sem sinal Brevo → elegível
  db.prepare(
    "INSERT INTO clarice_users (email, status, tier) VALUES (?, 'active', 1)",
  ).run("ana@x.com");
  recomputeDerived(db);
  let ana = db
    .prepare("SELECT send_eligible FROM clarice_users WHERE email = ?")
    .get("ana@x.com") as any;
  assert.equal(ana.send_eligible, 1); // sem Brevo, parecia elegível

  // chega o sync do Brevo: ana se descadastrou + abriu 2 de 3 antes disso
  const upsert = makeBrevoUpsert(db);
  upsert(
    parseBrevoContact({
      email: "ana@x.com",
      emailBlacklisted: true,
      statistics: {
        messagesSent: [{ eventTime: "1" }, { eventTime: "2" }, { eventTime: "3" }],
        opened: [{ eventTime: "1" }, { eventTime: "2" }],
        unsubscriptions: [{ eventTime: "3" }],
      },
    }),
  );
  recomputeDerived(db);

  ana = db
    .prepare(
      "SELECT send_eligible, ineligible_reason, opens_count, sends_count FROM clarice_users WHERE email = ?",
    )
    .get("ana@x.com") as any;
  assert.equal(ana.send_eligible, 0);
  assert.equal(ana.ineligible_reason, "unsubscribed");
  assert.equal(ana.opens_count, 2);
  assert.equal(ana.sends_count, 3);

  db.close();
});
