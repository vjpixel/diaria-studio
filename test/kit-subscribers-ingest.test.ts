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
  ingestKitRoster,
  extractKitFieldAttributes,
} from "../scripts/lib/kit-subscribers-ingest.ts";
import {
  openDiariaSubscribersDb,
  getSubscriberTimeline,
  findSubscriberIdsByEmail,
  findSubscriberIdByAlias,
  getSubscriptionsForSubscriber,
  getAttributesForSubscriber,
  getStoreCounts,
} from "../scripts/lib/diaria-subscribers-db.ts";
import type { KitSubscriberSummary } from "../scripts/lib/kit-subscribers.ts";

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

// ---------------------------------------------------------------------------
// ingestKitRoster (#7174, F2 do épico #7172)
// ---------------------------------------------------------------------------

function makeSub(overrides: Partial<KitSubscriberSummary> = {}): KitSubscriberSummary {
  return {
    id: 1,
    email_address: "leitor@example.com",
    state: "active",
    created_at: "2026-08-25T10:00:00.000Z",
    fields: {},
    ...overrides,
  };
}

describe("ingestKitRoster", () => {
  it("grava 1 subscriber + 1 subscription + 1 evento subscribe por assinante novo", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestKitRoster(db, [makeSub()], "2026-09-02T04:25:00.000Z");
    assert.equal(result.processed, 1);
    assert.equal(result.subscriptionsWritten, 1);
    assert.equal(result.subscribeEvents.newEvents, 1);
    assert.equal(getStoreCounts(db).subscribers, 1);
    assert.equal(getStoreCounts(db).subscriptions, 1);
    db.close();
  });

  it("lê utm_* de `fields`, NUNCA de `attribution` — attribution nem é aceito no input", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestKitRoster(
      db,
      [
        makeSub({
          fields: {
            utm_source: "sparkloop-upscribe",
            utm_medium: "referral",
            utm_campaign: "onda-3",
            utm_channel: "boost",
            referring_site: "www.alquimiaoperativa.news",
            origem_cadastro: "poll",
          },
        }),
      ],
      "2026-09-02T04:25:00.000Z",
    );
    const subscriberId = findSubscriberIdByAlias(db, "kit", "1", "leitor@example.com");
    assert.notEqual(subscriberId, null);
    const [sub] = getSubscriptionsForSubscriber(db, subscriberId!);
    assert.equal(sub.source, "sparkloop-upscribe");
    assert.equal(sub.utm_medium, "referral");
    assert.equal(sub.utm_campaign, "onda-3");
    assert.equal(sub.utm_channel, "boost");
    assert.equal(sub.referring_site, "www.alquimiaoperativa.news");
    assert.equal(sub.origem_cadastro, "poll");
    db.close();
  });

  it("entered_at vem de created_at; status vem de state; external_id vem de id", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestKitRoster(db, [makeSub({ id: 42, state: "inactive", created_at: "2025-09-02T00:00:00.000Z" })], "2026-09-02T04:25:00.000Z");
    const subscriberId = findSubscriberIdByAlias(db, "kit", "42", "leitor@example.com");
    assert.notEqual(subscriberId, null);
    const [sub] = getSubscriptionsForSubscriber(db, subscriberId!);
    assert.equal(sub.status, "inactive");
    assert.equal(sub.entered_at, "2025-09-02T00:00:00.000Z");
    assert.equal(sub.exited_at, null, "inactive ainda é membro da base — só o double opt-in não confirmou");
    db.close();
  });

  it("cancelled/bounced/complained grava exitedAt e emite evento unsub", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestKitRoster(db, [makeSub({ state: "cancelled" })], "2026-09-02T04:25:00.000Z");
    assert.equal(result.unsubEvents.newEvents, 1);
    const subscriberId = findSubscriberIdByAlias(db, "kit", "1", "leitor@example.com");
    const [sub] = getSubscriptionsForSubscriber(db, subscriberId!);
    assert.notEqual(sub.exited_at, null);
    db.close();
  });

  it("re-execução no MESMO dia não duplica subscription nem event (idempotente)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestKitRoster(db, [makeSub()], "2026-09-02T04:25:00.000Z");
    ingestKitRoster(db, [makeSub()], "2026-09-02T09:00:00.000Z");
    assert.equal(getStoreCounts(db).subscribers, 1);
    assert.equal(getStoreCounts(db).subscriptions, 1);
    assert.equal(getStoreCounts(db).events, 1, "1 evento subscribe, nunca duplicado por re-execução no mesmo dia");
    db.close();
  });

  it("re-execução no MESMO dia com state cancelled também não duplica o evento unsub", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestKitRoster(db, [makeSub({ state: "cancelled" })], "2026-09-02T04:25:00.000Z");
    ingestKitRoster(db, [makeSub({ state: "cancelled" })], "2026-09-02T09:00:00.000Z");
    assert.equal(getStoreCounts(db).events, 2, "1 subscribe + 1 unsub, nenhum duplicado");
    db.close();
  });

  it("3+ execuções consecutivas com o MESMO state exited só gravam 1 evento unsub (#7222 finding 1 — regressão)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const day1 = ingestKitRoster(db, [makeSub({ state: "cancelled" })], "2026-09-02T04:25:00.000Z");
    const day2 = ingestKitRoster(db, [makeSub({ state: "cancelled" })], "2026-09-03T04:25:00.000Z");
    const day3 = ingestKitRoster(db, [makeSub({ state: "cancelled" })], "2026-09-04T04:25:00.000Z");
    assert.equal(day1.unsubEvents.newEvents, 1, "1ª rodada: transição active→cancelled, evento novo");
    assert.equal(day2.unsubEvents.newEvents, 0, "2ª rodada: já estava exited, sem transição, sem evento novo");
    assert.equal(day3.unsubEvents.newEvents, 0, "3ª rodada: mesma coisa — nunca reinsere por dia de captura");
    const subscriberId = findSubscriberIdByAlias(db, "kit", "1", "leitor@example.com");
    const timeline = getSubscriberTimeline(db, subscriberId!);
    assert.equal(
      timeline.filter((e) => e.type === "unsub").length,
      1,
      "30 dias cancelado não pode virar 30 eventos unsub — só 1, na transição",
    );
    db.close();
  });

  it("assinante que some da API numa próxima rodada permanece na série (linha antiga não é apagada)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestKitRoster(db, [makeSub({ id: 1 }), makeSub({ id: 2, email_address: "outro@example.com" })], "2026-09-02T04:25:00.000Z");
    // 2ª execução: só o id=1 volta (id=2 "sumiu" da API — deletado do Kit).
    ingestKitRoster(db, [makeSub({ id: 1 })], "2026-09-03T04:25:00.000Z");
    assert.equal(getStoreCounts(db).subscribers, 2, "subscriber do id=2 continua no store — nunca apagado por ausência numa rodada");
    db.close();
  });

  it("mudança de state gera evento novo sem apagar o anterior", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestKitRoster(db, [makeSub({ state: "active" })], "2026-09-02T04:25:00.000Z");
    ingestKitRoster(db, [makeSub({ state: "cancelled" })], "2026-09-03T04:25:00.000Z");
    const subscriberId = findSubscriberIdByAlias(db, "kit", "1", "leitor@example.com");
    const timeline = getSubscriberTimeline(db, subscriberId!);
    // 1 subscribe (idempotente entre as 2 rodadas, mesmo created_at) + 1 unsub novo.
    assert.equal(timeline.filter((e) => e.type === "subscribe").length, 1);
    assert.equal(timeline.filter((e) => e.type === "unsub").length, 1);
    db.close();
  });

  it("email vazio é ignorado, não vira subscriber fantasma", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestKitRoster(db, [makeSub({ email_address: "  " })], "2026-09-02T04:25:00.000Z");
    assert.equal(result.subscriptionsWritten, 0);
    assert.equal(getStoreCounts(db).subscribers, 0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// extractKitFieldAttributes / atributos no roster (#7202)
// ---------------------------------------------------------------------------

describe("extractKitFieldAttributes", () => {
  it("extrai TODO field, incluindo apoio_nivel (não só o subconjunto de UTM)", () => {
    const out = extractKitFieldAttributes({ fields: { apoio_nivel: "mantenedor", utm_source: "linkedin" } });
    assert.deepEqual(out.sort((a, b) => a.key.localeCompare(b.key)), [
      { key: "apoio_nivel", value: "mantenedor" },
      { key: "utm_source", value: "linkedin" },
    ]);
  });

  it("valor vazio/só espaço é ausência, não gravado", () => {
    assert.deepEqual(extractKitFieldAttributes({ fields: { apoio_nivel: "", setor: "   " } }), []);
  });

  it("fields ausente devolve []", () => {
    assert.deepEqual(extractKitFieldAttributes({}), []);
  });
});

describe("ingestKitRoster — atributos (#7202)", () => {
  it("grava subscriber_attribute a partir de fields e reporta attributesWritten", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestKitRoster(
      db,
      [makeSub({ fields: { apoio_nivel: "amigo" } })],
      "2026-09-02T04:25:00.000Z",
    );
    assert.equal(result.attributesWritten, 1);
    const subscriberId = findSubscriberIdByAlias(db, "kit", "1", "leitor@example.com");
    const attrs = getAttributesForSubscriber(db, subscriberId!);
    assert.deepEqual(attrs.map((a) => ({ key: a.key, value: a.value })), [
      { key: "apoio_nivel", value: "amigo" },
    ]);
    db.close();
  });

  it("sem fields não grava atributo nenhum", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestKitRoster(db, [makeSub()], "2026-09-02T04:25:00.000Z");
    assert.equal(result.attributesWritten, 0);
    db.close();
  });
});
