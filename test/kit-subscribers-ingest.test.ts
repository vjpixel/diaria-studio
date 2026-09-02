/**
 * kit-subscribers-ingest.test.ts (#6464 fatia 3 — #6586)
 *
 * Cobre o miolo puro da ingestão Kit → store unificado: mapeamento
 * eixo→evento, chave natural determinística, guard anti-fabricação (#6496),
 * e a escrita idempotente por eixo contra um SQLite `:memory:` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapAudienceToEventType,
  buildKitEventExternalId,
  verifyKitIngestion,
  ingestBroadcastAudience,
} from "../scripts/lib/kit-subscribers-ingest.ts";
import {
  openDiariaSubscribersDb,
  getSubscriberTimeline,
  findSubscriberIdsByEmail,
  getStoreCounts,
} from "../scripts/lib/diaria-subscribers-db.ts";

describe("mapAudienceToEventType", () => {
  it("sent/delivered passam direto; opens/clicks viram singular (vocabulário do store)", () => {
    assert.equal(mapAudienceToEventType("sent"), "sent");
    assert.equal(mapAudienceToEventType("delivered"), "delivered");
    assert.equal(mapAudienceToEventType("opens"), "open");
    assert.equal(mapAudienceToEventType("clicks"), "click");
  });
});

describe("buildKitEventExternalId", () => {
  it("normaliza e-mail (trim + lowercase) e escopa por broadcast + eixo", () => {
    assert.equal(
      buildKitEventExternalId("  Leitor@Example.com ", 123, "sent"),
      "leitor@example.com:123:sent",
    );
  });

  it("eixos diferentes do MESMO broadcast/e-mail nunca colidem", () => {
    const sent = buildKitEventExternalId("a@x.com", 1, "sent");
    const delivered = buildKitEventExternalId("a@x.com", 1, "delivered");
    assert.notEqual(sent, delivered);
  });
});

describe("verifyKitIngestion — guard anti-fabricação (#6496)", () => {
  it("ok quando a contagem de 'sent' bate exatamente com stats.recipients", () => {
    const r = verifyKitIngestion(594, 594);
    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined);
  });

  it("NÃO ok em qualquer divergência — nem sub nem super-contagem", () => {
    assert.equal(verifyKitIngestion(590, 594).ok, false);
    assert.equal(verifyKitIngestion(600, 594).ok, false);
  });

  it("0 ingerido com 0 esperado ainda é ok (broadcast genuinamente sem envio)", () => {
    assert.equal(verifyKitIngestion(0, 0).ok, true);
  });

  it("0 ingerido com recipients>0 reprova — regressão direta do incidente #6496", () => {
    const r = verifyKitIngestion(0, 594);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /0/);
  });
});

describe("ingestBroadcastAudience", () => {
  it("grava 1 subscriber + 1 event por e-mail novo", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const r = ingestBroadcastAudience(
      db,
      555,
      "opens",
      ["a@x.com", "b@x.com"],
      "2026-08-28T10:00:00.000Z",
    );
    assert.equal(r.newEvents, 2);
    assert.equal(r.alreadyKnown, 0);
    assert.equal(r.subscribersTouched, 2);

    const counts = getStoreCounts(db);
    assert.equal(counts.subscribers, 2);
    assert.equal(counts.events, 2);

    const [subId] = findSubscriberIdsByEmail(db, "a@x.com");
    const timeline = getSubscriberTimeline(db, subId);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].platform, "kit");
    assert.equal(timeline[0].type, "open");
    assert.equal(timeline[0].ts, "2026-08-28T10:00:00.000Z");
    db.close();
  });

  it("idempotente — re-rodar o MESMO eixo/broadcast não duplica evento nem subscriber", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBroadcastAudience(db, 555, "clicks", ["a@x.com"], "2026-08-28T10:00:00.000Z");
    const r2 = ingestBroadcastAudience(db, 555, "clicks", ["a@x.com"], "2026-08-28T10:00:00.000Z");
    assert.equal(r2.newEvents, 0);
    assert.equal(r2.alreadyKnown, 1);
    assert.equal(getStoreCounts(db).events, 1);
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });

  it("dedup de e-mails repetidos na MESMA chamada (mesmo eixo/broadcast)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const r = ingestBroadcastAudience(db, 1, "sent", ["a@x.com", "A@X.COM", "a@x.com"], "2026-01-01T00:00:00.000Z");
    assert.equal(r.subscribersTouched, 1);
    assert.equal(r.newEvents, 1);
    db.close();
  });

  it("email vazio/whitespace é ignorado, não vira subscriber fantasma", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const r = ingestBroadcastAudience(db, 1, "sent", ["  ", "", "a@x.com"], "2026-01-01T00:00:00.000Z");
    assert.equal(r.subscribersTouched, 1);
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });

  it("mesmo e-mail em 4 eixos do mesmo broadcast grava 4 eventos distintos", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const ts = "2026-08-28T10:00:00.000Z";
    ingestBroadcastAudience(db, 9, "sent", ["a@x.com"], ts);
    ingestBroadcastAudience(db, 9, "delivered", ["a@x.com"], ts);
    ingestBroadcastAudience(db, 9, "opens", ["a@x.com"], ts);
    ingestBroadcastAudience(db, 9, "clicks", ["a@x.com"], ts);
    assert.equal(getStoreCounts(db).subscribers, 1, "mesmo subscriber, resolvido 4x pelo mesmo alias");
    assert.equal(getStoreCounts(db).events, 4);
    db.close();
  });
});
