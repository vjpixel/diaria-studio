import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  openDiariaSubscribersDb,
  openDiariaSubscribersDbSafe,
  ensureSubscriber,
  upsertSubscription,
  recordEvent,
  getSubscriberTimeline,
  findSubscriberIdByAlias,
  findSubscriberIdsByEmail,
  getCohortEventCounts,
  getStoreCounts,
  isPlatform,
  isEventType,
  type Platform,
} from "../scripts/lib/diaria-subscribers-db.ts";

// ---------------------------------------------------------------------------
// Schema + índices
// ---------------------------------------------------------------------------

describe("openDiariaSubscribersDb — schema", () => {
  it("cria as 4 tabelas (subscriber, identity_alias, subscription, event)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of ["subscriber", "identity_alias", "subscription", "event"]) {
      assert.ok(tables.includes(t), `esperava tabela ${t}`);
    }
    db.close();
  });

  it("cria os índices das duas consultas que importam (timeline + coorte)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    assert.ok(indexes.includes("idx_event_subscriber_ts"));
    assert.ok(indexes.includes("idx_event_platform_ts"));
    db.close();
  });

  it("define busy_timeout = 5000 (mesmo padrão de clarice-db.ts)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    assert.equal(row.timeout, 5000);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Fail-soft com data/ ausente
// ---------------------------------------------------------------------------

describe("openDiariaSubscribersDbSafe — fail-soft com data/ ausente", () => {
  it("retorna null (nunca lança) quando o diretório do DB não existe", () => {
    const bogusPath = resolve(
      tmpdir(),
      `diaria-subscribers-db-test-${Date.now()}`,
      "nao-existe",
      "diaria-subscribers.db",
    );
    const db = openDiariaSubscribersDbSafe(bogusPath);
    assert.equal(db, null);
  });

  it("openDiariaSubscribersDb (não-safe) lança nesse mesmo cenário — confirma que a variante safe está de fato absorvendo o erro", () => {
    const bogusPath = resolve(
      tmpdir(),
      `diaria-subscribers-db-test-${Date.now()}`,
      "nao-existe",
      "diaria-subscribers.db",
    );
    assert.throws(() => openDiariaSubscribersDb(bogusPath));
  });

  it("abre normalmente quando o diretório existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-subscribers-db-test-"));
    const dbPath = resolve(dir, "diaria-subscribers.db");
    const db = openDiariaSubscribersDbSafe(dbPath);
    assert.notEqual(db, null);
    db?.close();
  });
});

// ---------------------------------------------------------------------------
// Fixture das 3 plataformas (Beehiiv, Brevo, Kit) + idempotência
// ---------------------------------------------------------------------------

describe("ensureSubscriber / upsertSubscription / recordEvent — fixture 3 plataformas", () => {
  it("ingestão fresca cria 1 subscriber por identidade, 1 subscription por (subscriber x platform), e todos os eventos", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const now = "2026-08-28T12:00:00.000Z";

    const beehiivId = ensureSubscriber(
      db,
      "beehiiv",
      "beehiiv-ext-1",
      "leitor@example.com",
      now,
    );
    const brevoId = ensureSubscriber(
      db,
      "brevo_diaria",
      "brevo-ext-1",
      "leitor@example.com",
      now,
    );
    const kitId = ensureSubscriber(
      db,
      "kit",
      "kit-ext-1",
      "leitor@example.com",
      now,
    );

    // Sem merge cross-plataforma (fatia 5 fora de escopo) — 3 identidades
    // distintas viram 3 subscriber_id distintos por hoje.
    assert.notEqual(beehiivId, brevoId);
    assert.notEqual(brevoId, kitId);

    upsertSubscription(
      db,
      beehiivId,
      "beehiiv",
      { status: "active", enteredAt: "2025-01-01", exitedAt: null, source: "organic" },
      now,
    );
    upsertSubscription(
      db,
      brevoId,
      "brevo_diaria",
      { status: "pending", enteredAt: "2025-06-01", exitedAt: null, source: "reativacao" },
      now,
    );
    upsertSubscription(
      db,
      kitId,
      "kit",
      { status: "active", enteredAt: "2026-08-01", exitedAt: null, source: "migracao" },
      now,
    );

    recordEvent(db, {
      subscriberId: beehiivId,
      platform: "beehiiv",
      type: "open",
      externalEventId: "beehiiv-post-1:leitor@example.com",
      edicao: "260101",
      ts: "2025-01-05T10:00:00.000Z",
    });
    recordEvent(db, {
      subscriberId: brevoId,
      platform: "brevo_diaria",
      type: "click",
      externalEventId: "brevo-campaign-9:leitor@example.com",
      edicao: "brevo-campaign-9",
      url: "https://diar.ia.br/x",
      ts: "2025-06-10T10:00:00.000Z",
    });
    recordEvent(db, {
      subscriberId: kitId,
      platform: "kit",
      type: "click",
      externalEventId: "kit-broadcast-5:kit-ext-1",
      edicao: "kit-broadcast-5",
      ts: "2026-08-15T10:00:00.000Z",
    });

    const counts = getStoreCounts(db);
    assert.equal(counts.subscribers, 3);
    assert.equal(counts.identity_aliases, 3);
    assert.equal(counts.subscriptions, 3);
    assert.equal(counts.events, 3);

    db.close();
  });

  it("builder é idempotente — re-rodar a mesma ingestão não duplica subscriber, subscription nem event", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const now = "2026-08-28T12:00:00.000Z";

    function ingestOnce(): void {
      const subscriberId = ensureSubscriber(
        db,
        "kit",
        "kit-ext-42",
        "reingerido@example.com",
        now,
      );
      upsertSubscription(
        db,
        subscriberId,
        "kit",
        { status: "active", enteredAt: "2026-08-01", exitedAt: null, source: "migracao" },
        now,
      );
      recordEvent(db, {
        subscriberId,
        platform: "kit",
        type: "open",
        externalEventId: "kit-broadcast-1:kit-ext-42",
        edicao: "kit-broadcast-1",
        ts: "2026-08-02T09:00:00.000Z",
      });
    }

    ingestOnce();
    const afterFirst = getStoreCounts(db);

    // Re-rodar 3x — simula 3 execuções do builder sobre o mesmo dado de origem.
    ingestOnce();
    ingestOnce();
    ingestOnce();
    const afterRepeat = getStoreCounts(db);

    assert.deepEqual(afterRepeat, afterFirst);
    assert.equal(afterFirst.subscribers, 1);
    assert.equal(afterFirst.subscriptions, 1);
    assert.equal(afterFirst.events, 1);

    db.close();
  });

  it("recordEvent retorna inserted:false quando o evento já existia (mesma chave natural)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const subscriberId = ensureSubscriber(db, "brevo_diaria", "brevo-1", "a@example.com");
    const first = recordEvent(db, {
      subscriberId,
      platform: "brevo_diaria",
      type: "sent",
      externalEventId: "campanha-1:a@example.com",
      ts: "2026-08-01T00:00:00.000Z",
    });
    const second = recordEvent(db, {
      subscriberId,
      platform: "brevo_diaria",
      type: "sent",
      externalEventId: "campanha-1:a@example.com",
      ts: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    db.close();
  });

  it("event aceita subscriber cuja subscription ainda não foi ingerida (fatias 3/4 em ordem indeterminada)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const subscriberId = ensureSubscriber(db, "kit", "kit-99", "sem-subscription@example.com");
    // Nenhum upsertSubscription rodou para este subscriber ainda.
    const result = recordEvent(db, {
      subscriberId,
      platform: "kit",
      type: "open",
      externalEventId: "kit-broadcast-7:kit-99",
      ts: "2026-08-20T00:00:00.000Z",
    });
    assert.equal(result.inserted, true);
    const timeline = getSubscriberTimeline(db, subscriberId);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].type, "open");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// As duas consultas que importam
// ---------------------------------------------------------------------------

describe("getSubscriberTimeline — timeline de 1 assinante", () => {
  it("retorna eventos de múltiplas plataformas na mesma timeline, ordenados por ts", () => {
    const db = openDiariaSubscribersDb(":memory:");
    // Caso concreto do épico: assinou na Beehiiv, clicou, esfriou, entrou na
    // reativação pelo Brevo, clicou lá, migrou pro Kit e clicou de novo —
    // aqui simulado como 3 identidades JÁ resolvidas pro mesmo subscriber
    // (a resolução automática é fatia 5; usamos ensureSubscriber 1x e
    // reaproveitamos o id pra simular o pós-merge).
    const subscriberId = ensureSubscriber(db, "beehiiv", "b-1", "jornada@example.com");

    recordEvent(db, {
      subscriberId,
      platform: "beehiiv",
      type: "subscribe",
      externalEventId: "beehiiv-sub:b-1",
      ts: "2025-01-01T00:00:00.000Z",
    });
    recordEvent(db, {
      subscriberId,
      platform: "beehiiv",
      type: "click",
      externalEventId: "beehiiv-post-3:b-1",
      ts: "2025-02-01T00:00:00.000Z",
    });
    recordEvent(db, {
      subscriberId,
      platform: "brevo_diaria",
      type: "click",
      externalEventId: "brevo-campaign-2:jornada@example.com",
      ts: "2025-08-01T00:00:00.000Z",
    });
    recordEvent(db, {
      subscriberId,
      platform: "kit",
      type: "click",
      externalEventId: "kit-broadcast-1:kit-jornada",
      ts: "2026-08-15T00:00:00.000Z",
    });

    const timeline = getSubscriberTimeline(db, subscriberId);
    assert.equal(timeline.length, 4);
    assert.deepEqual(
      timeline.map((e) => e.platform),
      ["beehiiv", "beehiiv", "brevo_diaria", "kit"],
    );
    // ordenado por ts asc
    for (let i = 1; i < timeline.length; i++) {
      assert.ok(timeline[i].ts >= timeline[i - 1].ts);
    }
    db.close();
  });
});

describe("getCohortEventCounts — coorte por plataforma/período", () => {
  it("conta eventos por tipo, restrito a uma plataforma e um intervalo de datas", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const s1 = ensureSubscriber(db, "kit", "kit-1", "a@example.com");
    const s2 = ensureSubscriber(db, "kit", "kit-2", "b@example.com");
    const s3 = ensureSubscriber(db, "brevo_diaria", "brevo-1", "c@example.com");

    recordEvent(db, {
      subscriberId: s1,
      platform: "kit",
      type: "open",
      externalEventId: "kit-b1:kit-1",
      ts: "2026-08-10T00:00:00.000Z",
    });
    recordEvent(db, {
      subscriberId: s2,
      platform: "kit",
      type: "open",
      externalEventId: "kit-b1:kit-2",
      ts: "2026-08-11T00:00:00.000Z",
    });
    recordEvent(db, {
      subscriberId: s2,
      platform: "kit",
      type: "click",
      externalEventId: "kit-b1:kit-2:click",
      ts: "2026-08-11T01:00:00.000Z",
    });
    // fora do período — não deve contar.
    recordEvent(db, {
      subscriberId: s1,
      platform: "kit",
      type: "open",
      externalEventId: "kit-b2:kit-1",
      ts: "2026-07-01T00:00:00.000Z",
    });
    // outra plataforma — não deve contar na coorte "kit".
    recordEvent(db, {
      subscriberId: s3,
      platform: "brevo_diaria",
      type: "open",
      externalEventId: "brevo-c1:c@example.com",
      ts: "2026-08-10T00:00:00.000Z",
    });

    const cohort = getCohortEventCounts(
      db,
      "kit",
      "2026-08-01T00:00:00.000Z",
      "2026-08-31T23:59:59.000Z",
    );
    const byType = Object.fromEntries(cohort.map((c) => [c.type, c.count]));
    assert.equal(byType.open, 2);
    assert.equal(byType.click, 1);
    db.close();
  });
});

describe("findSubscriberIdByAlias / findSubscriberIdsByEmail", () => {
  it("resolve subscriber_id a partir de um alias conhecido, e via busca por e-mail", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = ensureSubscriber(db, "brevo_diaria", "ext-x", "busca@example.com");
    assert.equal(findSubscriberIdByAlias(db, "brevo_diaria", "ext-x", "busca@example.com"), id);
    assert.equal(findSubscriberIdByAlias(db, "brevo_diaria", "outro-ext", "busca@example.com"), null);
    assert.deepEqual(findSubscriberIdsByEmail(db, "busca@example.com"), [id]);
    assert.deepEqual(findSubscriberIdsByEmail(db, "BUSCA@example.com"), [id]);
    db.close();
  });
});

describe("isPlatform / isEventType", () => {
  it("valida os 4 valores de plataforma e os 8 tipos de evento do épico", () => {
    for (const p of ["beehiiv", "brevo_diaria", "brevo_clarice", "kit"] as Platform[]) {
      assert.ok(isPlatform(p));
    }
    assert.equal(isPlatform("brevo"), false); // #6587: "brevo" genérico foi substituído pelas 2 contas
    assert.equal(isPlatform("mailchimp"), false);
    for (const t of [
      "sent",
      "delivered", // #6586: eixo de 1ª classe do Kit
      "open",
      "click",
      "subscribe",
      "unsub",
      "bounce",
      "complaint",
    ]) {
      assert.ok(isEventType(t));
    }
    assert.equal(isEventType("unknown-type"), false);
  });
});
