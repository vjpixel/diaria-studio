/**
 * beehiiv-subscribers-ingest.test.ts (#6464 fatia 3b — #7104)
 *
 * Cobre o miolo puro da ingestão Beehiiv → store unificado: derivação de
 * eixos a partir do registro cru, extração de identidade, chave natural
 * determinística, guard anti-fabricação (#6496) e a escrita idempotente
 * contra um SQLite `:memory:` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveBeehiivEventTypes,
  extractBeehiivIdentity,
  buildBeehiivEventExternalId,
  verifyBeehiivIngestion,
  ingestPostEngagement,
  type BeehiivEngagementRecord,
} from "../scripts/lib/beehiiv-subscribers-ingest.ts";
import {
  openDiariaSubscribersDb,
  getSubscriberTimeline,
  findSubscriberIdsByEmail,
  getStoreCounts,
} from "../scripts/lib/diaria-subscribers-db.ts";

describe("deriveBeehiivEventTypes", () => {
  it("status delivered sem contadores → só 'delivered'", () => {
    assert.deepEqual(deriveBeehiivEventTypes({ status: "delivered" }), ["delivered"]);
  });

  it("status delivered COM total_opened>0 ainda inclui 'open' (exemplo literal do corpo da issue #7104)", () => {
    // Achado da própria issue: {"status":"delivered", ..., "total_opened":1} —
    // status categórico e contador não são estritamente redundantes.
    const rec: BeehiivEngagementRecord = { status: "delivered", total_opened: 1, total_clicked: 0 };
    assert.deepEqual(deriveBeehiivEventTypes(rec), ["delivered", "open"]);
  });

  it("status opened → 'delivered' + 'open'", () => {
    assert.deepEqual(deriveBeehiivEventTypes({ status: "opened" }), ["delivered", "open"]);
  });

  it("status clicked → 'delivered' + 'open' + 'click'", () => {
    assert.deepEqual(deriveBeehiivEventTypes({ status: "clicked" }), ["delivered", "open", "click"]);
  });

  it("total_clicked>0 sem status clicked ainda inclui 'click'", () => {
    assert.deepEqual(deriveBeehiivEventTypes({ status: "opened", total_clicked: 3 }), [
      "delivered",
      "open",
      "click",
    ]);
  });

  it("status unsubscribed → 'delivered' + 'unsub' (presença na lista prova entrega)", () => {
    assert.deepEqual(deriveBeehiivEventTypes({ status: "unsubscribed" }), ["delivered", "unsub"]);
  });

  it("sem 'sent': nenhum eixo 'sent' é derivável desta fonte (limitação nomeada #7104)", () => {
    for (const status of ["delivered", "opened", "clicked", "unsubscribed"]) {
      assert.ok(!deriveBeehiivEventTypes({ status }).includes("sent" as never));
    }
  });
});

describe("extractBeehiivIdentity", () => {
  it("subscriber_id + email presentes → os dois", () => {
    const id = extractBeehiivIdentity({ subscriber_id: "7bfa5666-abc", email: " Leitor@Example.com " });
    assert.deepEqual(id, { externalId: "7bfa5666-abc", email: "leitor@example.com" });
  });

  it("só email → externalId null", () => {
    assert.deepEqual(extractBeehiivIdentity({ email: "a@x.com" }), { externalId: null, email: "a@x.com" });
  });

  it("só subscriber_id → email null", () => {
    assert.deepEqual(extractBeehiivIdentity({ subscriber_id: "uuid-1" }), { externalId: "uuid-1", email: null });
  });

  it("nem subscriber_id nem email → null (nunca vira subscriber fantasma)", () => {
    assert.equal(extractBeehiivIdentity({ status: "delivered" }), null);
  });

  it("campos com tipo errado (não-string) são tratados como ausentes", () => {
    assert.equal(extractBeehiivIdentity({ subscriber_id: 123, email: null }), null);
  });
});

describe("buildBeehiivEventExternalId", () => {
  it("prefere subscriber_id quando presente", () => {
    const id = buildBeehiivEventExternalId({ externalId: "uuid-1", email: "a@x.com" }, "post_1", "open");
    assert.equal(id, "uuid-1:post_1:open");
  });

  it("cai pro email quando subscriber_id ausente", () => {
    const id = buildBeehiivEventExternalId({ externalId: null, email: "a@x.com" }, "post_1", "open");
    assert.equal(id, "a@x.com:post_1:open");
  });

  it("eixos diferentes do MESMO post/identidade nunca colidem", () => {
    const identity = { externalId: "uuid-1", email: null };
    assert.notEqual(
      buildBeehiivEventExternalId(identity, "post_1", "delivered"),
      buildBeehiivEventExternalId(identity, "post_1", "open"),
    );
  });
});

describe("verifyBeehiivIngestion — guard anti-fabricação (#6496)", () => {
  it("ok quando processados bate exatamente com manifest.count", () => {
    const r = verifyBeehiivIngestion(553, 553);
    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined);
  });

  it("NÃO ok em qualquer divergência", () => {
    assert.equal(verifyBeehiivIngestion(550, 553).ok, false);
    assert.equal(verifyBeehiivIngestion(560, 553).ok, false);
  });

  it("0 processado com 0 esperado ainda é ok", () => {
    assert.equal(verifyBeehiivIngestion(0, 0).ok, true);
  });

  it("0 processado com count>0 reprova, motivo cita os dois números", () => {
    const r = verifyBeehiivIngestion(0, 553);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /553/);
  });
});

describe("ingestPostEngagement", () => {
  it("grava 1 subscriber + evento 'delivered' por registro delivered simples", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const records: BeehiivEngagementRecord[] = [
      { subscriber_id: "s1", email: "a@x.com", status: "delivered", timestamp: "2025-09-09T12:00:33Z" },
    ];
    const r = ingestPostEngagement(db, "post_abc", records);
    assert.equal(r.recordsProcessed, 1);
    assert.equal(r.recordsSkippedNoIdentity, 0);
    assert.equal(r.newEvents, 1);
    assert.equal(r.subscribersTouched, 1);

    const [subId] = findSubscriberIdsByEmail(db, "a@x.com");
    const timeline = getSubscriberTimeline(db, subId);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].platform, "beehiiv");
    assert.equal(timeline[0].type, "delivered");
    assert.equal(timeline[0].ts, "2025-09-09T12:00:33Z");
    assert.equal(timeline[0].edicao, "post_abc");
    db.close();
  });

  it("registro clicked grava 3 eventos: delivered + open + click", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const records: BeehiivEngagementRecord[] = [
      { subscriber_id: "s1", email: "a@x.com", status: "clicked", total_opened: 2, total_clicked: 1 },
    ];
    const r = ingestPostEngagement(db, "post_abc", records);
    assert.equal(r.newEvents, 3);
    assert.equal(getStoreCounts(db).events, 3);
    db.close();
  });

  it("idempotente — re-ingerir o MESMO post não duplica evento nem subscriber", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const records: BeehiivEngagementRecord[] = [
      { subscriber_id: "s1", email: "a@x.com", status: "opened" },
    ];
    ingestPostEngagement(db, "post_abc", records);
    const r2 = ingestPostEngagement(db, "post_abc", records);
    assert.equal(r2.newEvents, 0);
    assert.equal(r2.alreadyKnown, 2); // delivered + open
    assert.equal(getStoreCounts(db).events, 2);
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });

  it("registro sem subscriber_id nem email é pulado, não vira subscriber fantasma", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const records: BeehiivEngagementRecord[] = [
      { status: "delivered" },
      { subscriber_id: "s1", email: "a@x.com", status: "delivered" },
    ];
    const r = ingestPostEngagement(db, "post_abc", records);
    assert.equal(r.recordsProcessed, 1);
    assert.equal(r.recordsSkippedNoIdentity, 1);
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });

  it("mesmo subscriber em 2 posts diferentes: eventos distintos, mesmo subscriber (fusão dentro da plataforma)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestPostEngagement(db, "post_1", [{ subscriber_id: "s1", email: "a@x.com", status: "delivered" }]);
    ingestPostEngagement(db, "post_2", [{ subscriber_id: "s1", email: "a@x.com", status: "opened" }]);
    assert.equal(getStoreCounts(db).subscribers, 1, "mesmo subscriber_id nativo, resolvido pro mesmo subscriber");
    assert.equal(getStoreCounts(db).events, 3); // post_1 delivered + post_2 delivered + post_2 open
    db.close();
  });

  it("ts cai no timestamp do registro; usa `now` só quando ausente", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestPostEngagement(
      db,
      "post_1",
      [{ subscriber_id: "s1", status: "delivered" }],
      "2026-01-01T00:00:00.000Z",
    );
    const row = db.prepare("SELECT ts FROM event LIMIT 1").get() as { ts: string };
    assert.equal(row.ts, "2026-01-01T00:00:00.000Z");
    db.close();
  });
});
