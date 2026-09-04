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
  resolveOrCreateBeehiivSubscriber,
  findExistingBeehiivSubscriberId,
  ingestBeehiivRoster,
  applyBeehiivExitHistory,
  extractBeehiivCustomFieldAttributes,
  extractBeehiivClickEntries,
  isBeehiivClickIdentityRecord,
  buildBeehiivClickExternalId,
  type BeehiivEngagementRecord,
} from "../scripts/lib/beehiiv-subscribers-ingest.ts";
import {
  openDiariaSubscribersDb,
  getSubscriberTimeline,
  findSubscriberIdsByEmail,
  findSubscriberIdByAlias,
  getSubscriptionsForSubscriber,
  getAttributesForSubscriber,
  getStoreCounts,
  hasSubscriberEventOfType,
} from "../scripts/lib/diaria-subscribers-db.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

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

  it("classe C (#7181): sem `email`, mas `subscriber_id` É um e-mail → recuperado", () => {
    // Achado ao vivo: 100/100 linhas de post_048a8526… ("Post 11/20" no
    // manifest) têm o endereço gravado em `subscriber_id`, sem chave `email`.
    const id = extractBeehiivIdentity({ subscriber_id: "User@Example.com" });
    assert.deepEqual(id, { externalId: "User@Example.com", email: "user@example.com" });
  });

  it("classe C: `email` presente vence — subscriber_id-como-email não sobrescreve", () => {
    const id = extractBeehiivIdentity({ subscriber_id: "outro@x.com", email: "real@y.com" });
    assert.deepEqual(id, { externalId: "outro@x.com", email: "real@y.com" });
  });

  it("#7206: subscription_id (click-identity record) é aceito como externalId quando subscriber_id ausente", () => {
    const id = extractBeehiivIdentity({ subscription_id: "uuid-click-1", email: "a@x.com" });
    assert.deepEqual(id, { externalId: "uuid-click-1", email: "a@x.com" });
  });

  it("#7206: subscriber_id vence sobre subscription_id quando os dois presentes (nunca deveria acontecer, mas determinístico)", () => {
    const id = extractBeehiivIdentity({ subscriber_id: "uuid-a", subscription_id: "uuid-b", email: "a@x.com" });
    assert.equal(id!.externalId, "uuid-a");
  });
});

describe("extractBeehiivClickEntries / isBeehiivClickIdentityRecord (#7206)", () => {
  it("shape FLAT (url/clicked_at no nível do registro) → 1 clique", () => {
    const record: BeehiivEngagementRecord = {
      subscription_id: "s1",
      email: "a@x.com",
      url: "https://diar.ia.br/x",
      url_hash: "abc123",
      clicked_at: "2026-08-01T10:00:00Z",
    };
    assert.deepEqual(extractBeehiivClickEntries(record), [{ url: "https://diar.ia.br/x", ts: "2026-08-01T10:00:00Z" }]);
    assert.equal(isBeehiivClickIdentityRecord(record), true);
  });

  it("shape NESTED (clicks[]) → 1 clique por entrada", () => {
    const record: BeehiivEngagementRecord = {
      subscriber_id: "s1",
      email: "a@x.com",
      clicks: [
        { url: "https://a", clicked_at: "2026-08-01T10:00:00Z" },
        { url: "https://b", clicked_at: "2026-08-01T11:00:00Z" },
      ],
    };
    assert.deepEqual(extractBeehiivClickEntries(record), [
      { url: "https://a", ts: "2026-08-01T10:00:00Z" },
      { url: "https://b", ts: "2026-08-01T11:00:00Z" },
    ]);
    assert.equal(isBeehiivClickIdentityRecord(record), true);
  });

  it("clicked_at ausente/malformado numa entrada → ts null, entrada não descartada", () => {
    const record: BeehiivEngagementRecord = { subscriber_id: "s1", clicks: [{ url: "https://a" }] };
    assert.deepEqual(extractBeehiivClickEntries(record), [{ url: "https://a", ts: null }]);
  });

  it("entrada de clicks[] sem url utilizável é descartada, não vira clique fantasma", () => {
    const record: BeehiivEngagementRecord = { subscriber_id: "s1", clicks: [{ clicked_at: "2026-08-01T10:00:00Z" }, null, "x"] };
    assert.deepEqual(extractBeehiivClickEntries(record), []);
  });

  it("registro de engagement genérico (com status, sem url/clicks) → [] e isBeehiivClickIdentityRecord false", () => {
    const record: BeehiivEngagementRecord = { subscriber_id: "s1", status: "delivered" };
    assert.deepEqual(extractBeehiivClickEntries(record), []);
    assert.equal(isBeehiivClickIdentityRecord(record), false);
  });

  it("registro com status E url (nunca deveria acontecer, mas não é o discriminador por design) → isBeehiivClickIdentityRecord false", () => {
    // O discriminador é a AUSÊNCIA de status — um registro real de engagement
    // nunca deveria ter url/clicks (são fontes MCP diferentes), mas se algum
    // dia acontecer, a presença de `status` já basta pra tratar como
    // engagement normal (evita reclassificar um registro válido por engano).
    const record: BeehiivEngagementRecord = { subscriber_id: "s1", status: "clicked", url: "https://a" };
    assert.equal(isBeehiivClickIdentityRecord(record), false);
  });
});

describe("buildBeehiivClickExternalId (#7206)", () => {
  it("inclui a url — 2 links do mesmo post/identidade não colidem", () => {
    const identity = { externalId: "uuid-1", email: null };
    assert.notEqual(
      buildBeehiivClickExternalId(identity, "post_1", "https://a"),
      buildBeehiivClickExternalId(identity, "post_1", "https://b"),
    );
  });

  it("é DIFERENTE da chave do 'click' derivado de engagement genérico (nunca colide, mesmo post/identidade)", () => {
    const identity = { externalId: "uuid-1", email: null };
    assert.notEqual(
      buildBeehiivClickExternalId(identity, "post_1", "https://a"),
      buildBeehiivEventExternalId(identity, "post_1", "click"),
    );
  });

  it("identidade vazia lança", () => {
    assert.throws(() => buildBeehiivClickExternalId({ externalId: null, email: null }, "post_1", "https://a"));
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

describe("resolveOrCreateBeehiivSubscriber — funde combinações inconsistentes do mesmo assinante (#7135 finding 3)", () => {
  it("2 linhas do MESMO subscriber_id com combinações de e-mail diferentes convergem num único subscriber", () => {
    const db = openDiariaSubscribersDb(":memory:");
    // Linha 1: subscriber_id + email presentes.
    const id1 = resolveOrCreateBeehiivSubscriber(db, { externalId: "uuid-1", email: "a@x.com" });
    // Linha 2: MESMO subscriber_id, mas email ausente/malformado (null) — a
    // chave exata (platform, external_id, email) do `ensureSubscriber`
    // genérico trataria isso como uma identidade NOVA, criando um 2º
    // `subscriber` pro mesmo humano real.
    const id2 = resolveOrCreateBeehiivSubscriber(db, { externalId: "uuid-1", email: null });
    assert.equal(id1, id2, "mesmo subscriber_id nativo → mesmo subscriber, mesmo com email divergente");
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });

  it("linha SEM subscriber_id (só email) casa com um subscriber já visto sob esse email", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id1 = resolveOrCreateBeehiivSubscriber(db, { externalId: "uuid-2", email: "b@x.com" });
    // Linha posterior chega sem subscriber_id (ex: página da MCP que só
    // devolveu email) — deve fundir com o subscriber já resolvido por email,
    // não criar um novo.
    const id2 = resolveOrCreateBeehiivSubscriber(db, { externalId: null, email: "b@x.com" });
    assert.equal(id1, id2);
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });

  it("identidades genuinamente distintas continuam criando subscribers separados", () => {
    const db = openDiariaSubscribersDb(":memory:");
    resolveOrCreateBeehiivSubscriber(db, { externalId: "uuid-3", email: "c@x.com" });
    resolveOrCreateBeehiivSubscriber(db, { externalId: "uuid-4", email: "d@x.com" });
    assert.equal(getStoreCounts(db).subscribers, 2);
    db.close();
  });

  it("ingestPostEngagement: 2 registros do mesmo post com subscriber_id igual e email divergente não duplicam subscriber", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const records: BeehiivEngagementRecord[] = [
      { subscriber_id: "s1", email: "a@x.com", status: "delivered" },
      { subscriber_id: "s1", email: null, status: "opened" },
    ];
    const r = ingestPostEngagement(db, "post_abc", records);
    assert.equal(r.recordsProcessed, 2);
    assert.equal(r.subscribersTouched, 1);
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });
});

describe("guard anti-fantasma (#7181) — subscriber_id opaco sem e-mail nunca vira subscriber", () => {
  it("registro stub (só subscriber_id, sem e-mail em lugar nenhum) NÃO cria subscriber", () => {
    // Reproduz classe A do backup local de engajamento contaminado
    // (`{"subscriber_id":"s1"}`, 768 linhas em 9 arquivos, 02/09/2026) —
    // é o teste de regressão exigido pela issue #7181.
    const db = openDiariaSubscribersDb(":memory:");
    const r = ingestPostEngagement(db, "post_stub", [{ subscriber_id: "s1", status: "delivered" }]);
    assert.equal(r.recordsProcessed, 0);
    assert.equal(r.recordsSkippedNoIdentity, 1);
    assert.equal(r.subscribersTouched, 0);
    assert.equal(r.newEvents, 0);
    assert.equal(getStoreCounts(db).subscribers, 0, "nenhum subscriber fantasma criado");
    assert.equal(getStoreCounts(db).events, 0, "nenhum evento gravado pro registro sem identidade real");
    db.close();
  });

  it("registro classe C (e-mail gravado em subscriber_id) É aceito — remap, não descarte", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const r = ingestPostEngagement(db, "post_c", [{ subscriber_id: "leitor@x.com", status: "delivered" }]);
    assert.equal(r.recordsProcessed, 1);
    assert.equal(r.recordsSkippedNoIdentity, 0);
    assert.equal(getStoreCounts(db).subscribers, 1);

    const [subId] = findSubscriberIdsByEmail(db, "leitor@x.com");
    assert.ok(subId, "alias resolvido pelo e-mail recuperado de subscriber_id");
    db.close();
  });

  it("subscriber_id opaco sem e-mail, mas JÁ conhecido de outra linha (mesmo alias), continua fundindo — não reintroduz o split do #7135", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const records: BeehiivEngagementRecord[] = [
      { subscriber_id: "s1", email: "a@x.com", status: "delivered" },
      { subscriber_id: "s1", status: "opened" }, // 2ª linha: só subscriber_id, sem email
    ];
    const r = ingestPostEngagement(db, "post_merge", records);
    assert.equal(r.recordsProcessed, 2, "a 2ª linha funde com o alias já resolvido pela 1ª, não é descartada");
    assert.equal(r.subscribersTouched, 1);
    assert.equal(getStoreCounts(db).subscribers, 1, "nenhum subscriber a mais — nem fantasma, nem split");
    db.close();
  });

  it("misto: registro stub puro é pulado, registro com e-mail é gravado normalmente", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const records: BeehiivEngagementRecord[] = [
      { subscriber_id: "s1", status: "delivered" }, // stub — descartado
      { subscriber_id: "s2", email: "b@x.com", status: "delivered" }, // real
    ];
    const r = ingestPostEngagement(db, "post_mix", records);
    assert.equal(r.recordsProcessed, 1);
    assert.equal(r.recordsSkippedNoIdentity, 1);
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
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
      // email presente pra não cair no guard anti-fantasma do #7181 —
      // não é o que este teste cobre (ver describe "guard anti-fantasma"
      // abaixo pro caso sem e-mail).
      [{ subscriber_id: "s1", email: "a@x.com", status: "delivered" }],
      "2026-01-01T00:00:00.000Z",
    );
    const row = db.prepare("SELECT ts FROM event LIMIT 1").get() as { ts: string };
    assert.equal(row.ts, "2026-01-01T00:00:00.000Z");
    db.close();
  });

  // -------------------------------------------------------------------------
  // click-identity records (#7206) — list_post_click_subscribers mesclado no
  // MESMO jsonl. Antes deste fix: virava "delivered" fabricado, url perdida.
  // -------------------------------------------------------------------------

  it("click-identity FLAT: grava 'click' com url, NUNCA 'delivered' fabricado", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const records: BeehiivEngagementRecord[] = [
      { subscription_id: "s1", email: "a@x.com", url: "https://diar.ia.br/x", url_hash: "h1", clicked_at: "2026-08-01T10:00:00Z" },
    ];
    const r = ingestPostEngagement(db, "post_abc", records);
    assert.equal(r.recordsProcessed, 1);
    assert.equal(r.newEvents, 1, "só 1 evento — nunca 'delivered' + 'click'");

    const [subId] = findSubscriberIdsByEmail(db, "a@x.com");
    const timeline = getSubscriberTimeline(db, subId);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].type, "click");
    assert.equal(timeline[0].url, "https://diar.ia.br/x");
    assert.equal(timeline[0].ts, "2026-08-01T10:00:00Z");
    assert.ok(!timeline.some((e) => e.type === "delivered"), "delivered nunca fabricado a partir de click-identity");
    db.close();
  });

  it("click-identity NESTED (clicks[]): grava 1 'click' POR LINK", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const records: BeehiivEngagementRecord[] = [
      {
        subscriber_id: "s1",
        email: "a@x.com",
        clicks: [
          { url: "https://a", clicked_at: "2026-08-01T10:00:00Z" },
          { url: "https://b", clicked_at: "2026-08-01T11:00:00Z" },
        ],
      },
    ];
    const r = ingestPostEngagement(db, "post_abc", records);
    assert.equal(r.newEvents, 2);
    const [subId] = findSubscriberIdsByEmail(db, "a@x.com");
    const timeline = getSubscriberTimeline(db, subId);
    assert.equal(timeline.length, 2);
    assert.deepEqual(timeline.map((e) => e.url).sort(), ["https://a", "https://b"]);
    assert.ok(timeline.every((e) => e.type === "click"));
    db.close();
  });

  it("post com AMBOS engagement genérico (com status) e click-identity (sem status) do mesmo assinante: cada linha tratada pelo seu caminho", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const records: BeehiivEngagementRecord[] = [
      { subscriber_id: "s1", email: "a@x.com", status: "opened", timestamp: "2026-08-01T09:00:00Z" },
      { subscriber_id: "s1", email: "a@x.com", url: "https://a", clicked_at: "2026-08-01T10:00:00Z" },
    ];
    const r = ingestPostEngagement(db, "post_abc", records);
    // delivered + open (engagement) + click com url (click-identity) = 3
    assert.equal(r.newEvents, 3);
    const [subId] = findSubscriberIdsByEmail(db, "a@x.com");
    const timeline = getSubscriberTimeline(db, subId);
    assert.deepEqual(timeline.map((e) => e.type).sort(), ["click", "delivered", "open"]);
    const click = timeline.find((e) => e.type === "click")!;
    assert.equal(click.url, "https://a");
    db.close();
  });

  it("re-ingerir o mesmo click-identity record não duplica (idempotente)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const records: BeehiivEngagementRecord[] = [
      { subscription_id: "s1", email: "a@x.com", url: "https://a", clicked_at: "2026-08-01T10:00:00Z" },
    ];
    ingestPostEngagement(db, "post_abc", records);
    const r2 = ingestPostEngagement(db, "post_abc", records);
    assert.equal(r2.newEvents, 0);
    assert.equal(r2.alreadyKnown, 1);
    assert.equal(getStoreCounts(db).events, 1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// ingestBeehiivRoster (#7229) — popula a dimensão `subscription`
// ---------------------------------------------------------------------------

function makeRosterSub(overrides: Partial<BeehiivBackupSubscriber> = {}): BeehiivBackupSubscriber {
  return {
    id: "sub_1",
    email: "leitor@example.com",
    status: "active",
    created: 1756800000, // 2025-09-02T09:20:00.000Z
    utm_source: "linkedin",
    utm_medium: "social",
    utm_campaign: "organico",
    referring_site: "www.linkedin.com",
    ...overrides,
  };
}

describe("ingestBeehiivRoster", () => {
  it("grava 1 subscriber + 1 subscription + 1 evento subscribe por assinante novo — subscription deixa de ser 0 (#7229)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestBeehiivRoster(db, [makeRosterSub()], "2026-09-02T04:25:00.000Z");
    assert.equal(result.processed, 1);
    assert.equal(result.subscriptionsWritten, 1);
    assert.equal(result.subscribeEvents.newEvents, 1);
    assert.equal(getStoreCounts(db).subscribers, 1);
    assert.equal(getStoreCounts(db).subscriptions, 1, "a dimensão subscription passa a ter linha — o buraco da #7229");
    db.close();
  });

  it("entered_at vem de created (Unix seg → ISO); status vem de status; external_id vem de id; source/UTM de topo, nunca de attribution", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBeehiivRoster(
      db,
      [
        makeRosterSub({
          id: "sub_42",
          created: 1756800000,
          utm_source: "sparkloop-upscribe",
          utm_medium: "referral",
          utm_campaign: "onda-3",
          referring_site: "www.alquimiaoperativa.news",
        }),
      ],
      "2026-09-02T04:25:00.000Z",
    );
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_42", "leitor@example.com");
    assert.notEqual(subscriberId, null);
    const [sub] = getSubscriptionsForSubscriber(db, subscriberId!);
    assert.equal(sub.status, "active");
    assert.equal(sub.entered_at, new Date(1756800000 * 1000).toISOString());
    assert.equal(sub.exited_at, null);
    assert.equal(sub.source, "sparkloop-upscribe");
    assert.equal(sub.utm_medium, "referral");
    assert.equal(sub.utm_campaign, "onda-3");
    assert.equal(sub.referring_site, "www.alquimiaoperativa.news");
    db.close();
  });

  it("#7207: custom field origem_original tem precedência sobre os campos de topo (mesma regra de build-origem-map.ts #5842)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBeehiivRoster(
      db,
      [
        makeRosterSub({
          // Campos de topo já foram SOBRESCRITOS por uma reativação
          // promocional — cenário que motivou o #5231/#5842.
          utm_source: "brevo-diaria",
          utm_medium: "reativacao",
          utm_campaign: "score-alto",
          referring_site: "",
          custom_fields: [
            {
              name: "origem_original",
              value: JSON.stringify({
                utm_source: "instagram",
                utm_medium: "bio-link",
                utm_campaign: "lancamento",
                referring_site: "www.instagram.com",
                created: 1700000000,
              }),
            },
          ],
        }),
      ],
      "2026-09-02T04:25:00.000Z",
    );
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");
    const [sub] = getSubscriptionsForSubscriber(db, subscriberId!);
    assert.equal(sub.utm_source, "instagram", "origem_original vence sobre o utm_source promocional de topo");
    assert.equal(sub.source, "instagram", "legado `source` acompanha a mesma resolução");
    assert.equal(sub.utm_medium, "bio-link");
    assert.equal(sub.utm_campaign, "lancamento");
    assert.equal(sub.referring_site, "www.instagram.com");
    db.close();
  });

  it("#7207: sem origem_original, cai pros campos de topo (comportamento pré-#7207 preservado)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBeehiivRoster(db, [makeRosterSub({ utm_source: "linkedin" })], "2026-09-02T04:25:00.000Z");
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");
    const [sub] = getSubscriptionsForSubscriber(db, subscriberId!);
    assert.equal(sub.utm_source, "linkedin");
    db.close();
  });

  it("#7207: sem origem_original NEM utm_source de topo, acquisition_source é o último fallback", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBeehiivRoster(
      db,
      [makeRosterSub({ utm_source: "", acquisition_source: "referral-program" })],
      "2026-09-02T04:25:00.000Z",
    );
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");
    const [sub] = getSubscriptionsForSubscriber(db, subscriberId!);
    assert.equal(sub.utm_source, "referral-program");
    db.close();
  });

  it("#7207: acquisition_channel popula utm_channel (Beehiiv não tem campo utm_channel nativo)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBeehiivRoster(db, [makeRosterSub({ acquisition_channel: "paid-social" })], "2026-09-02T04:25:00.000Z");
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");
    const [sub] = getSubscriptionsForSubscriber(db, subscriberId!);
    assert.equal(sub.utm_channel, "paid-social");
    db.close();
  });

  it("status inactive grava exitedAt e emite evento unsub", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestBeehiivRoster(db, [makeRosterSub({ status: "inactive" })], "2026-09-02T04:25:00.000Z");
    assert.equal(result.unsubEvents.newEvents, 1);
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");
    const [sub] = getSubscriptionsForSubscriber(db, subscriberId!);
    assert.equal(sub.status, "inactive");
    assert.notEqual(sub.exited_at, null);
    db.close();
  });

  it("re-execução no MESMO dia não duplica subscription nem event (idempotente)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBeehiivRoster(db, [makeRosterSub()], "2026-09-02T04:25:00.000Z");
    ingestBeehiivRoster(db, [makeRosterSub()], "2026-09-02T09:00:00.000Z");
    assert.equal(getStoreCounts(db).subscribers, 1);
    assert.equal(getStoreCounts(db).subscriptions, 1);
    assert.equal(getStoreCounts(db).events, 1, "1 evento subscribe, nunca duplicado por re-execução no mesmo dia");
    db.close();
  });

  it("3+ execuções consecutivas com o MESMO status inactive só gravam 1 evento unsub (mesmo padrão do #7222 finding 1, agora para Beehiiv)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const day1 = ingestBeehiivRoster(db, [makeRosterSub({ status: "inactive" })], "2026-09-02T04:25:00.000Z");
    const day2 = ingestBeehiivRoster(db, [makeRosterSub({ status: "inactive" })], "2026-09-03T04:25:00.000Z");
    const day3 = ingestBeehiivRoster(db, [makeRosterSub({ status: "inactive" })], "2026-09-04T04:25:00.000Z");
    assert.equal(day1.unsubEvents.newEvents, 1, "1ª rodada: transição active→inactive, evento novo");
    assert.equal(day2.unsubEvents.newEvents, 0, "2ª rodada: já estava exited, sem transição, sem evento novo");
    assert.equal(day3.unsubEvents.newEvents, 0, "3ª rodada: mesma coisa — nunca reinsere por dia de captura");
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");
    const timeline = getSubscriberTimeline(db, subscriberId!);
    assert.equal(
      timeline.filter((e) => e.type === "unsub").length,
      1,
      "30 dias inactive não pode virar 30 eventos unsub — só 1, na transição",
    );
    db.close();
  });

  it("funde com um subscriber já criado pela ingestão de engajamento (mesma identidade, plataforma beehiiv)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    // Assinante já existe no store via o passo de ENGAJAMENTO por post.
    ingestPostEngagement(db, "post_1", [{ subscriber_id: "sub_1", email: "leitor@example.com", status: "delivered" }]);
    assert.equal(getStoreCounts(db).subscribers, 1);
    // Roster chega DEPOIS, mesmo subscriber_id/email — não pode criar um 2º subscriber.
    const result = ingestBeehiivRoster(db, [makeRosterSub()], "2026-09-02T04:25:00.000Z");
    assert.equal(result.subscriptionsWritten, 1);
    assert.equal(getStoreCounts(db).subscribers, 1, "funde com o subscriber já existente, não duplica");
    db.close();
  });

  it("email vazio é ignorado, não vira subscriber fantasma", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestBeehiivRoster(db, [makeRosterSub({ email: "  " })], "2026-09-02T04:25:00.000Z");
    assert.equal(result.subscriptionsWritten, 0);
    assert.equal(result.recordsSkippedNoEmail, 1);
    assert.equal(getStoreCounts(db).subscribers, 0);
    db.close();
  });

  describe("classificação dos 5 estados observados no snapshot real (#7233 finding 1)", () => {
    // `data/beehiiv-backup/2026-08-30/subscribers.jsonl` (1495 linhas) tem
    // active/pending/inactive/invalid/paused — não só active/inactive como
    // o comentário antigo de `BEEHIIV_EXITED_STATES` afirmava.
    const cases: Array<{ status: string; exited: boolean; why: string }> = [
      { status: "active", exited: false, why: "assinante normal" },
      { status: "inactive", exited: true, why: "sinal original (#7229) — descadastro/promoção fora da Beehiiv" },
      { status: "invalid", exited: true, why: "e-mail inválido/bounce não recebe mais a newsletter" },
      { status: "paused", exited: false, why: "reversível por desenho — não é saída" },
      { status: "pending", exited: false, why: "nunca chegou a entrar — cadastro travado sem confirmação" },
    ];

    for (const { status, exited, why } of cases) {
      it(`status "${status}" → exitedAt ${exited ? "gravado" : "null"} (${why})`, () => {
        const db = openDiariaSubscribersDb(":memory:");
        ingestBeehiivRoster(db, [makeRosterSub({ status })], "2026-09-02T04:25:00.000Z");
        const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");
        const [sub] = getSubscriptionsForSubscriber(db, subscriberId!);
        assert.equal(sub.status, status);
        if (exited) {
          assert.notEqual(sub.exited_at, null);
        } else {
          assert.equal(sub.exited_at, null);
        }
        db.close();
      });
    }
  });

  it("mudança de status gera evento novo sem apagar o anterior", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBeehiivRoster(db, [makeRosterSub({ status: "active" })], "2026-09-02T04:25:00.000Z");
    ingestBeehiivRoster(db, [makeRosterSub({ status: "inactive" })], "2026-09-03T04:25:00.000Z");
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");
    const timeline = getSubscriberTimeline(db, subscriberId!);
    assert.equal(timeline.filter((e) => e.type === "subscribe").length, 1);
    assert.equal(timeline.filter((e) => e.type === "unsub").length, 1);
    db.close();
  });

  describe("unsub de post-engagement + unsub de roster para o MESMO fato (#7233 finding 2)", () => {
    it("as 2 fontes gravam linhas SEPARADAS (chaves naturais diferentes de propósito — não é bug)", () => {
      const db = openDiariaSubscribersDb(":memory:");
      // Fonte 1: engajamento por post — subscriber já aparece "unsubscribed"
      // num post específico.
      ingestPostEngagement(db, "post_1", [
        { subscriber_id: "sub_1", email: "leitor@example.com", status: "unsubscribed" },
      ]);
      // Fonte 2: roster — o MESMO assinante, mesmo descadastro real,
      // capturado pela transição active→inactive do snapshot semanal.
      ingestBeehiivRoster(db, [makeRosterSub({ status: "inactive" })], "2026-09-02T04:25:00.000Z");

      const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");
      const timeline = getSubscriberTimeline(db, subscriberId!);
      const unsubEvents = timeline.filter((e) => e.type === "unsub");
      assert.equal(
        unsubEvents.length,
        2,
        "2 linhas type='unsub' — granularidades diferentes (por post vs. por transição de roster), esperado",
      );
      assert.notEqual(
        unsubEvents[0].external_event_id,
        unsubEvents[1].external_event_id,
        "chaves naturais diferentes de propósito — não deduplicam entre si",
      );
      db.close();
    });

    it("hasSubscriberEventOfType não duplica — responde 'já se descadastrou' 1x, independente de quantas fontes gravaram", () => {
      const db = openDiariaSubscribersDb(":memory:");
      ingestPostEngagement(db, "post_1", [
        { subscriber_id: "sub_1", email: "leitor@example.com", status: "unsubscribed" },
      ]);
      ingestBeehiivRoster(db, [makeRosterSub({ status: "inactive" })], "2026-09-02T04:25:00.000Z");
      const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");

      assert.equal(hasSubscriberEventOfType(db, subscriberId!, "unsub"), true);
      // Um assinante que NUNCA aparece com status unsubscribed/inactive em
      // nenhuma fonte não deve reportar unsub nenhum.
      ingestBeehiivRoster(db, [makeRosterSub({ id: "sub_2", email: "outro@example.com", status: "active" })], "2026-09-02T04:25:00.000Z");
      const otherSubscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_2", "outro@example.com");
      assert.equal(hasSubscriberEventOfType(db, otherSubscriberId!, "unsub"), false);
      db.close();
    });
  });
});

// ---------------------------------------------------------------------------
// extractBeehiivCustomFieldAttributes / atributos no roster (#7202)
// ---------------------------------------------------------------------------

describe("extractBeehiivCustomFieldAttributes", () => {
  it("extrai name/value de custom_fields, incluindo apoio_nivel e resposta de survey", () => {
    const out = extractBeehiivCustomFieldAttributes({
      custom_fields: [
        { name: "apoio_nivel", value: "mantenedor" },
        { name: "Setor 1", value: "Tecnologia" },
      ],
    });
    assert.deepEqual(out, [
      { key: "apoio_nivel", value: "mantenedor" },
      { key: "Setor 1", value: "Tecnologia" },
    ]);
  });

  it("entry sem name utilizável é ignorada", () => {
    assert.deepEqual(extractBeehiivCustomFieldAttributes({ custom_fields: [{ value: "x" }] }), []);
  });

  it("entry com value null/vazio é ausência, não gravada (#7202 — dimensão ausente ≠ zero silencioso)", () => {
    assert.deepEqual(
      extractBeehiivCustomFieldAttributes({
        custom_fields: [
          { name: "poll_sig", value: null },
          { name: "RH_parceiro", value: "" },
        ],
      }),
      [],
    );
  });

  it("custom_fields ausente/não-array devolve []", () => {
    assert.deepEqual(extractBeehiivCustomFieldAttributes({}), []);
  });
});

describe("ingestBeehiivRoster — atributos (#7202)", () => {
  it("grava subscriber_attribute a partir de custom_fields e reporta attributesWritten", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestBeehiivRoster(
      db,
      [
        makeRosterSub({
          custom_fields: [
            { name: "apoio_nivel", value: "amigo" },
            { name: "Setor 1", value: "Educação" },
          ],
        }),
      ],
      "2026-09-02T04:25:00.000Z",
    );
    assert.equal(result.attributesWritten, 2);
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");
    const attrs = getAttributesForSubscriber(db, subscriberId!);
    assert.equal(attrs.length, 2);
    assert.ok(attrs.some((a) => a.key === "apoio_nivel" && a.value === "amigo"));
    db.close();
  });

  it("sem custom_fields não grava atributo nenhum — attributesWritten: 0", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = ingestBeehiivRoster(db, [makeRosterSub()], "2026-09-02T04:25:00.000Z");
    assert.equal(result.attributesWritten, 0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// findExistingBeehiivSubscriberId / applyBeehiivExitHistory (#7248)
// ---------------------------------------------------------------------------

describe("findExistingBeehiivSubscriberId", () => {
  it("null quando nenhum alias existe pra essa identidade", () => {
    const db = openDiariaSubscribersDb(":memory:");
    assert.equal(findExistingBeehiivSubscriberId(db, { externalId: "sub_1", email: null }), null);
    db.close();
  });

  it("acha por externalId — nunca cria (diferente de resolveOrCreateBeehiivSubscriber)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBeehiivRoster(db, [makeRosterSub()], "2026-09-02T04:25:00.000Z");
    const id = findExistingBeehiivSubscriberId(db, { externalId: "sub_1", email: null });
    assert.notEqual(id, null);
    assert.equal(getStoreCounts(db).subscribers, 1, "busca não cria subscriber a mais");
    db.close();
  });

  it("acha por email quando externalId não casa", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBeehiivRoster(db, [makeRosterSub()], "2026-09-02T04:25:00.000Z");
    const id = findExistingBeehiivSubscriberId(db, { externalId: null, email: "leitor@example.com" });
    assert.notEqual(id, null);
    db.close();
  });
});

describe("applyBeehiivExitHistory", () => {
  it("substitui a aproximação por um exited_at REAL, mais preciso — o bug central da #7248", () => {
    const db = openDiariaSubscribersDb(":memory:");
    // Roster detecta a transição no dia da CAPTURA (aproximação) — bem
    // depois da saída real, que só a MCP list_subscriptions confirma.
    ingestBeehiivRoster(db, [makeRosterSub({ status: "inactive" })], "2026-09-07T00:00:00.000Z");
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");
    const before = getSubscriptionsForSubscriber(db, subscriberId!)[0];
    assert.equal(before.exited_at, "2026-09-07T00:00:00.000Z", "aproximação = data da captura, não a real");

    const result = applyBeehiivExitHistory(
      db,
      [{ externalId: "sub_1", email: "leitor@example.com", unsubscribedOn: "2026-09-04T01:19:07Z" }],
      "2026-09-08T00:00:00.000Z",
    );
    assert.equal(result.updated, 1);
    assert.equal(result.processed, 1);

    const after = getSubscriptionsForSubscriber(db, subscriberId!)[0];
    assert.equal(after.exited_at, "2026-09-04T01:19:07Z", "exited_at agora é o timestamp REAL da MCP, não a aproximação");
    // Nenhum outro campo da subscription se move — só exited_at.
    assert.equal(after.status, before.status);
    assert.equal(after.entered_at, before.entered_at);
    assert.equal(after.source, before.source);
    assert.equal(after.utm_campaign, before.utm_campaign);
    db.close();
  });

  it("reaplicar o MESMO registro é idempotente — unchanged, nunca reescreve", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBeehiivRoster(db, [makeRosterSub({ status: "inactive" })], "2026-09-07T00:00:00.000Z");
    const record = { externalId: "sub_1", email: "leitor@example.com", unsubscribedOn: "2026-09-04T01:19:07Z" };
    applyBeehiivExitHistory(db, [record], "2026-09-08T00:00:00.000Z");
    const result2 = applyBeehiivExitHistory(db, [record], "2026-09-09T00:00:00.000Z");
    assert.equal(result2.updated, 0);
    assert.equal(result2.unchanged, 1);
    db.close();
  });

  it("subscriber sem subscription(beehiiv) alguma → skippedNoSubscription, nunca cria uma", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = applyBeehiivExitHistory(db, [
      { externalId: "sub_999", email: "nunca-visto@example.com", unsubscribedOn: "2026-09-04T01:19:07Z" },
    ]);
    assert.equal(result.processed, 1);
    assert.equal(result.skippedNoSubscription, 1);
    assert.equal(result.updated, 0);
    assert.equal(getStoreCounts(db).subscribers, 0, "exit-history nunca cria subscriber novo");
    assert.equal(getStoreCounts(db).subscriptions, 0);
    db.close();
  });

  it("subscription com status ATUAL diferente de inactive → skippedStatusMismatch, nunca sobrescreve", () => {
    const db = openDiariaSubscribersDb(":memory:");
    // Assinante voltou a active DEPOIS da captura que gerou o registro de
    // exit-history (race entre fontes capturadas em momentos diferentes).
    ingestBeehiivRoster(db, [makeRosterSub({ status: "active" })], "2026-09-08T00:00:00.000Z");
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");

    const result = applyBeehiivExitHistory(db, [
      { externalId: "sub_1", email: "leitor@example.com", unsubscribedOn: "2026-09-04T01:19:07Z" },
    ]);
    assert.equal(result.skippedStatusMismatch, 1);
    assert.equal(result.updated, 0);

    const sub = getSubscriptionsForSubscriber(db, subscriberId!)[0];
    assert.equal(sub.exited_at, null, "status active não é tocado por um registro de exit-history desatualizado");
    db.close();
  });

  it("registro sem externalId nem email → skippedNoIdentity", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const result = applyBeehiivExitHistory(db, [{ externalId: null, email: null, unsubscribedOn: "2026-09-04T01:19:07Z" }]);
    assert.equal(result.skippedNoIdentity, 1);
    db.close();
  });

  it("a coorte invalid nunca é tocada — status gravado 'invalid' nunca bate o guard 'inactive' (#7248, MCP não cobre essa coorte)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBeehiivRoster(db, [makeRosterSub({ status: "invalid" })], "2026-09-07T00:00:00.000Z");
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");
    const before = getSubscriptionsForSubscriber(db, subscriberId!)[0];
    assert.notEqual(before.exited_at, null, "invalid já é aproximado como saída pelo roster (#7233 finding 1)");

    // Mesmo que um registro chegasse por engano pra essa identidade (não
    // deveria — a MCP não expõe invalid, ver beehiiv-exit-history.ts), o
    // guard de status rejeita: subscription gravada é status="invalid",
    // nunca "inactive".
    const result = applyBeehiivExitHistory(db, [
      { externalId: "sub_1", email: "leitor@example.com", unsubscribedOn: "2026-09-04T01:19:07Z" },
    ]);
    assert.equal(result.skippedStatusMismatch, 1);

    const after = getSubscriptionsForSubscriber(db, subscriberId!)[0];
    assert.equal(after.exited_at, before.exited_at, "aproximação do roster permanece intocada pra invalid");
    db.close();
  });

  it("funde por email quando o registro de exit-history só tem email (sem externalId)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    ingestBeehiivRoster(db, [makeRosterSub({ status: "inactive" })], "2026-09-07T00:00:00.000Z");
    const subscriberId = findSubscriberIdByAlias(db, "beehiiv", "sub_1", "leitor@example.com");

    const result = applyBeehiivExitHistory(db, [
      { externalId: null, email: "leitor@example.com", unsubscribedOn: "2026-09-04T01:19:07Z" },
    ]);
    assert.equal(result.updated, 1);
    const after = getSubscriptionsForSubscriber(db, subscriberId!)[0];
    assert.equal(after.exited_at, "2026-09-04T01:19:07Z");
    db.close();
  });
});
