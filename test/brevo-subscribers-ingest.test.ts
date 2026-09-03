/**
 * brevo-subscribers-ingest.test.ts (#6464 fatia 4 — #6587)
 *
 * Cobre `extractContactEvents` (brevo-stats.ts) e o miolo puro da ingestão
 * Brevo → store unificado: mapeamento categoria→evento, chave natural, e a
 * escrita idempotente contra um SQLite `:memory:` real. `brevo_clarice`
 * nunca entra aqui desde #7196 — a identidade "1 subscriber por CONTA" que
 * este arquivo cobria (2 contas nunca fundidas) virou identidade "1 conta
 * só", coberta pelo guard mecânico de `test/store-excludes-clarice.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractContactEvents } from "../scripts/lib/brevo-stats.ts";
import {
  mapStatCategoryToEventType,
  buildBrevoEventExternalId,
  ingestBrevoContact,
  extractBrevoContactAttributes,
} from "../scripts/lib/brevo-subscribers-ingest.ts";
import {
  openDiariaSubscribersDb,
  getSubscriberTimeline,
  findSubscriberIdsByEmail,
  getAttributesForSubscriber,
  getStoreCounts,
} from "../scripts/lib/diaria-subscribers-db.ts";

// ---------------------------------------------------------------------------
// extractContactEvents
// ---------------------------------------------------------------------------

describe("extractContactEvents", () => {
  it("contato sem statistics → []", () => {
    assert.deepEqual(extractContactEvents({ email: "a@x.com" }), []);
  });

  it("1 evento por entrada de cada categoria simples (messagesSent/opened/bounces/...)", () => {
    const events = extractContactEvents({
      email: "a@x.com",
      statistics: {
        messagesSent: [{ campaignId: 1, eventTime: "2026-01-01T00:00:00Z" }],
        opened: [{ campaignId: 1, eventTime: "2026-01-02T00:00:00Z" }],
        hardBounces: [{ campaignId: 2, eventTime: "2026-01-03T00:00:00Z" }],
      },
    });
    assert.equal(events.length, 3);
    const sent = events.find((e) => e.category === "messagesSent")!;
    assert.equal(sent.campaignId, 1);
    assert.equal(sent.ts, "2026-01-01T00:00:00.000Z");
  });

  it("clicked expande 1 evento POR LINK (shape real aninhado, #4429)", () => {
    const events = extractContactEvents({
      email: "felipe@clarice.ai",
      statistics: {
        clicked: [
          {
            campaignId: 25,
            links: [
              { eventTime: "2026-05-08T17:28:28.148-03:00", url: "https://a" },
              { eventTime: "2026-05-08T17:58:40.090-03:00", url: "https://b" },
            ],
          },
        ],
      },
    });
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.category === "clicked" && e.campaignId === 25));
    assert.deepEqual(events.map((e) => e.url).sort(), ["https://a", "https://b"]);
  });

  it("entrada sem timestamp reconhecido vira ts:null, não é descartada em silêncio", () => {
    const events = extractContactEvents({
      statistics: { opened: [{ campaignId: 1 }] },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].ts, null);
  });

  it("statistics object-keyed (não-array) também é decomposto", () => {
    const events = extractContactEvents({
      statistics: {
        opened: { "123": { campaignId: 5, eventTime: "2026-02-01T00:00:00Z" } },
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].campaignId, 5);
  });

  it("2 aberturas da MESMA campanha viram 2 eventos distintos (não deduplicado por campaignId)", () => {
    const events = extractContactEvents({
      statistics: {
        opened: [
          { campaignId: 9, eventTime: "2026-01-01T00:00:00Z" },
          { campaignId: 9, eventTime: "2026-01-02T00:00:00Z" },
        ],
      },
    });
    assert.equal(events.length, 2);
  });
});

// ---------------------------------------------------------------------------
// mapStatCategoryToEventType / buildBrevoEventExternalId
// ---------------------------------------------------------------------------

describe("mapStatCategoryToEventType", () => {
  it("mapeia as 7 categorias — hard/softBounces colapsam em 'bounce'", () => {
    assert.equal(mapStatCategoryToEventType("messagesSent"), "sent");
    assert.equal(mapStatCategoryToEventType("opened"), "open");
    assert.equal(mapStatCategoryToEventType("clicked"), "click");
    assert.equal(mapStatCategoryToEventType("hardBounces"), "bounce");
    assert.equal(mapStatCategoryToEventType("softBounces"), "bounce");
    assert.equal(mapStatCategoryToEventType("unsubscriptions"), "unsub");
    assert.equal(mapStatCategoryToEventType("complaints"), "complaint");
  });
});

describe("buildBrevoEventExternalId", () => {
  it("incorpora ts na chave — 2 eventos da MESMA campanha em momentos diferentes não colidem", () => {
    const e1 = buildBrevoEventExternalId("a@x.com", "opened", 9, "2026-01-01T00:00:00.000Z");
    const e2 = buildBrevoEventExternalId("a@x.com", "opened", 9, "2026-01-02T00:00:00.000Z");
    assert.notEqual(e1, e2);
  });

  it("clicked incorpora url — 2 links da mesma campanha/mesmo ts não colidem", () => {
    const e1 = buildBrevoEventExternalId("a@x.com", "clicked", 9, "2026-01-01T00:00:00.000Z", "https://a");
    const e2 = buildBrevoEventExternalId("a@x.com", "clicked", 9, "2026-01-01T00:00:00.000Z", "https://b");
    assert.notEqual(e1, e2);
  });

  it("normaliza e-mail (trim + lowercase)", () => {
    const e1 = buildBrevoEventExternalId(" A@X.com ", "opened", 1, "t");
    assert.equal(e1, "a@x.com:opened:1:t");
  });
});

// ---------------------------------------------------------------------------
// ingestBrevoContact
// ---------------------------------------------------------------------------

describe("ingestBrevoContact", () => {
  it("grava subscriber + subscription + eventos a partir de um contato cru", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestBrevoContact(db, "brevo_diaria", 42, {
      id: 42,
      email: "leitor@example.com",
      createdAt: "2026-01-01T00:00:00Z",
      modifiedAt: "2026-08-01T00:00:00Z",
      listIds: [3],
      statistics: {
        messagesSent: [{ campaignId: 1, eventTime: "2026-01-05T00:00:00Z" }],
        opened: [{ campaignId: 1, eventTime: "2026-01-05T01:00:00Z" }],
      },
    });
    // #7201: 2 eventos de statistics (sent+opened) + 1 "subscribe" a partir
    // de createdAt (nova cobertura desta issue — antes ingestBrevoContact
    // upsertava subscription.entered_at mas nunca emitia o evento datado).
    assert.equal(result.newEvents, 3);
    assert.equal(result.skippedNoTimestamp, 0);

    const [subId] = findSubscriberIdsByEmail(db, "leitor@example.com");
    const timeline = getSubscriberTimeline(db, subId);
    assert.equal(timeline.length, 3);
    assert.ok(timeline.every((e) => e.platform === "brevo_diaria"));
    assert.equal(timeline.filter((e) => e.type === "subscribe").length, 1);

    const sub = db
      .prepare("SELECT status, source FROM subscription WHERE subscriber_id = ? AND platform = ?")
      .get(subId, "brevo_diaria") as { status: string; source: string };
    assert.equal(sub.status, "active");
    assert.equal(sub.source, "brevo_list:3");
    db.close();
  });

  it("unsubscribed via emailBlacklisted → subscription status unsubscribed", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBrevoContact(db, "brevo_diaria", 1, {
      id: 1,
      email: "a@x.com",
      emailBlacklisted: true,
      modifiedAt: "2026-06-01T00:00:00Z",
    });
    const [subId] = findSubscriberIdsByEmail(db, "a@x.com");
    const sub = db
      .prepare("SELECT status, exited_at FROM subscription WHERE subscriber_id = ? AND platform = ?")
      .get(subId, "brevo_diaria") as { status: string; exited_at: string };
    assert.equal(sub.status, "unsubscribed");
    assert.equal(sub.exited_at, "2026-06-01T00:00:00Z");
    db.close();
  });

  it("idempotente — re-ingerir o MESMO contato não duplica evento nem subscriber", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const contact = {
      id: 1,
      email: "a@x.com",
      statistics: { opened: [{ campaignId: 1, eventTime: "2026-01-01T00:00:00Z" }] },
    };
    ingestBrevoContact(db, "brevo_diaria", 1, contact);
    const r2 = ingestBrevoContact(db, "brevo_diaria", 1, contact);
    assert.equal(r2.newEvents, 0);
    assert.equal(r2.alreadyKnown, 1);
    assert.equal(getStoreCounts(db).subscribers, 1);
    assert.equal(getStoreCounts(db).events, 1);
    db.close();
  });

  it("evento sem timestamp parseável é contado como skipped, nunca gravado com ts inventado", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestBrevoContact(db, "brevo_diaria", 1, {
      id: 1,
      email: "a@x.com",
      statistics: { opened: [{ campaignId: 1 }] }, // sem eventTime
    });
    assert.equal(result.newEvents, 0);
    assert.equal(result.skippedNoTimestamp, 1);
    assert.equal(getStoreCounts(db).events, 0);
    db.close();
  });

  it("contato sem e-mail utilizável é pulado (sem lançar)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestBrevoContact(db, "brevo_diaria", 1, { id: 1 });
    assert.equal(result.newEvents, 0);
    assert.equal(getStoreCounts(db).subscribers, 0);
    db.close();
  });

  // -------------------------------------------------------------------------
  // subscribe a partir de createdAt (#7201 — residual do checklist: Kit e
  // Beehiiv já emitiam, a Brevo upsertava subscription.entered_at mas nunca
  // gravava o evento datado).
  // -------------------------------------------------------------------------

  it("emite subscribe com ts = createdAt", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBrevoContact(db, "brevo_diaria", 1, {
      id: 1,
      email: "a@x.com",
      createdAt: "2026-03-01T10:00:00Z",
    });
    const [subId] = findSubscriberIdsByEmail(db, "a@x.com");
    const timeline = getSubscriberTimeline(db, subId);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].type, "subscribe");
    assert.equal(timeline[0].ts, "2026-03-01T10:00:00Z");
    db.close();
  });

  it("sem createdAt não emite subscribe (nunca inventa data)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBrevoContact(db, "brevo_diaria", 1, { id: 1, email: "a@x.com" });
    const [subId] = findSubscriberIdsByEmail(db, "a@x.com");
    assert.equal(getSubscriberTimeline(db, subId).length, 0);
    db.close();
  });

  it("re-ingerir o mesmo contato não duplica o subscribe (chave natural = email:subscribe:createdAt)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const contact = { id: 1, email: "a@x.com", createdAt: "2026-03-01T10:00:00Z" };
    ingestBrevoContact(db, "brevo_diaria", 1, contact);
    const r2 = ingestBrevoContact(db, "brevo_diaria", 1, contact);
    assert.equal(r2.newEvents, 0);
    assert.equal(r2.alreadyKnown, 1);
    db.close();
  });

  // -------------------------------------------------------------------------
  // atributos (#7202)
  // -------------------------------------------------------------------------

  it("grava subscriber_attribute a partir de contact.attributes", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestBrevoContact(db, "brevo_diaria", 1, {
      id: 1,
      email: "a@x.com",
      attributes: { NIVEL: "Iniciante", SETOR: "Tecnologia", VAZIO: null },
    });
    assert.equal(result.attributesWritten, 2, "VAZIO (null) é ausência, não gravado");
    const [subId] = findSubscriberIdsByEmail(db, "a@x.com");
    const attrs = getAttributesForSubscriber(db, subId);
    assert.equal(attrs.length, 2);
    assert.ok(attrs.some((a) => a.key === "NIVEL" && a.value === "Iniciante"));
    db.close();
  });

  it("sem attributes (ou attributes: {}) não grava nada", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestBrevoContact(db, "brevo_diaria", 1, { id: 1, email: "a@x.com" });
    assert.equal(result.attributesWritten, 0);
    db.close();
  });
});

describe("extractBrevoContactAttributes", () => {
  it("ignora null (a Brevo devolve TODO atributo configurado, null pra quem nunca preencheu)", () => {
    assert.deepEqual(extractBrevoContactAttributes({ attributes: { A: "x", B: null } }), [
      { key: "A", value: "x" },
    ]);
  });

  it("attributes ausente/não-objeto/array devolve []", () => {
    assert.deepEqual(extractBrevoContactAttributes({}), []);
    assert.deepEqual(extractBrevoContactAttributes({ attributes: null }), []);
    assert.deepEqual(extractBrevoContactAttributes({ attributes: ["x"] }), []);
  });
});
