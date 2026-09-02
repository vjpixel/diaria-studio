/**
 * studio-subscribers.test.ts (#6464 fatia 6 — #6590)
 *
 * Cobre `scripts/studio-ui/studio-subscribers.ts`: busca por e-mail →
 * timeline unificada, coorte por migração, fail-soft sem `data/`/sem
 * store, e a presença da nota de piso em TODA resposta (#6589).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  openDiariaSubscribersDb,
  ensureSubscriber,
  upsertSubscription,
  recordEvent,
} from "../scripts/lib/diaria-subscribers-db.ts";
import { CROSS_PLATFORM_FLOOR_NOTE } from "../scripts/lib/diaria-subscribers-identity-resolve.ts";
import {
  searchSubscribersByEmail,
  buildSubscribersCohortData,
} from "../scripts/studio-ui/studio-subscribers.ts";

const NOW = "2026-09-01T12:00:00.000Z";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "studio-subscribers-test-"));
  mkdirSync(join(root, "data"), { recursive: true });
  return root;
}

function dbPathFor(root: string): string {
  const dbPath = resolve(root, "data", "diaria-subscribers", "diaria-subscribers.db");
  mkdirSync(join(root, "data", "diaria-subscribers"), { recursive: true });
  return dbPath;
}

// ---------------------------------------------------------------------------
// Fail-soft: sem data/, ou sem store ainda
// ---------------------------------------------------------------------------

describe("fail-soft — sem data/ ou sem store", () => {
  it("rootDir sem data/ inteiro: hasDataDir false, available false, nunca lança", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-subscribers-nodata-"));
    try {
      const result = searchSubscribersByEmail(root, "a@x.com");
      assert.equal(result.db.hasDataDir, false);
      assert.equal(result.db.available, false);
      assert.equal(result.subscribers.length, 0);
      assert.equal(result.note, CROSS_PLATFORM_FLOOR_NOTE);

      const cohort = buildSubscribersCohortData(root);
      assert.equal(cohort.db.available, false);
      assert.equal(cohort.totalSubscribers, 0);
      assert.equal(cohort.unmatched, null);
      assert.equal(cohort.note, CROSS_PLATFORM_FLOOR_NOTE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("data/ existe mas diaria-subscribers/ ainda não (nenhuma ingestão rodou): available false", () => {
    const root = makeRoot();
    try {
      const result = searchSubscribersByEmail(root, "a@x.com");
      assert.equal(result.db.hasDataDir, true);
      assert.equal(result.db.available, false);
      assert.ok(result.db.error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Busca por e-mail → timeline unificada
// ---------------------------------------------------------------------------

describe("searchSubscribersByEmail", () => {
  it("email desconhecido: subscribers vazio, mas db.available true (store existe, só não achou)", () => {
    const root = makeRoot();
    try {
      const dbPath = dbPathFor(root);
      const db = openDiariaSubscribersDb(dbPath);
      db.close();

      const result = searchSubscribersByEmail(root, "ninguem@x.com");
      assert.equal(result.db.available, true);
      assert.equal(result.subscribers.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("email conhecido: devolve aliases + subscriptions + timeline ordenada + leitor-v1", () => {
    const root = makeRoot();
    try {
      const dbPath = dbPathFor(root);
      const db = openDiariaSubscribersDb(dbPath);
      const id = ensureSubscriber(db, "kit", null, "leitor@x.com", NOW);
      upsertSubscription(db, id, "kit", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);
      recordEvent(db, { subscriberId: id, platform: "kit", type: "subscribe", externalEventId: "sub1", ts: "2026-01-01T00:00:00.000Z" });
      recordEvent(db, { subscriberId: id, platform: "kit", type: "click", externalEventId: "click1", edicao: "ed1", ts: "2026-02-01T00:00:00.000Z" });
      db.close();

      const result = searchSubscribersByEmail(root, "LEITOR@X.com"); // case-insensitive, mesma normalização de findSubscriberIdsByEmail
      assert.equal(result.subscribers.length, 1);
      const sub = result.subscribers[0];
      assert.equal(sub.subscriberId, id);
      assert.equal(sub.aliases.length, 1);
      assert.equal(sub.aliases[0].platform, "kit");
      assert.equal(sub.subscriptions.length, 1);
      assert.equal(sub.subscriptions[0].status, "active");
      assert.equal(sub.timeline.length, 2);
      // ordenado por ts ascendente (getSubscriberTimeline)
      assert.ok(sub.timeline[0].ts < sub.timeline[1].ts);
      assert.equal(sub.leitor.subscriberId, id);
      assert.equal(typeof sub.leitor.isLeitor, "boolean");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("2 subscribers pré-resolução de identidade (mesmo email, plataformas diferentes): a busca devolve os 2, nunca funde", () => {
    const root = makeRoot();
    try {
      const dbPath = dbPathFor(root);
      const db = openDiariaSubscribersDb(dbPath);
      ensureSubscriber(db, "beehiiv", "bh-1", "dois@x.com", NOW);
      ensureSubscriber(db, "kit", null, "dois@x.com", NOW);
      db.close();

      const result = searchSubscribersByEmail(root, "dois@x.com");
      assert.equal(result.subscribers.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Coorte por migração
// ---------------------------------------------------------------------------

describe("buildSubscribersCohortData", () => {
  it("store vazio: zeros em tudo, byPlatform lista as 4 plataformas com total 0", () => {
    const root = makeRoot();
    try {
      const dbPath = dbPathFor(root);
      const db = openDiariaSubscribersDb(dbPath);
      db.close();

      const cohort = buildSubscribersCohortData(root);
      assert.equal(cohort.totalSubscribers, 0);
      assert.equal(cohort.byPlatform.length, 4);
      for (const p of cohort.byPlatform) assert.equal(p.total, 0);
      assert.deepEqual(cohort.migrations, []);
      assert.equal(cohort.reactivation.count, 0);
      assert.ok(cohort.unmatched);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("conta byPlatform e migrações pairwise (Beehiiv->Kit, Beehiiv->Brevo diária)", () => {
    const root = makeRoot();
    try {
      const dbPath = dbPathFor(root);
      const db = openDiariaSubscribersDb(dbPath);

      // Subscriber 1: presente em beehiiv + kit (migrou).
      const s1 = ensureSubscriber(db, "beehiiv", "bh-1", "um@x.com", NOW);
      db.prepare(
        "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'kit', NULL, ?, ?)",
      ).run(s1, "um@x.com", NOW);

      // Subscriber 2: só beehiiv (nunca migrou).
      ensureSubscriber(db, "beehiiv", "bh-2", "dois@x.com", NOW);

      // Subscriber 3: beehiiv + brevo_diaria.
      const s3 = ensureSubscriber(db, "beehiiv", "bh-3", "tres@x.com", NOW);
      db.prepare(
        "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'brevo_diaria', ?, ?, ?)",
      ).run(s3, "brevo-3", "tres@x.com", NOW);

      db.close();

      const cohort = buildSubscribersCohortData(root);
      assert.equal(cohort.totalSubscribers, 3);
      const beehiivCount = cohort.byPlatform.find((p) => p.platform === "beehiiv")!.total;
      assert.equal(beehiivCount, 3);
      const kitCount = cohort.byPlatform.find((p) => p.platform === "kit")!.total;
      assert.equal(kitCount, 1);

      const bhKit = cohort.migrations.find((m) => (m.a === "beehiiv" && m.b === "kit") || (m.a === "kit" && m.b === "beehiiv"));
      assert.ok(bhKit, "esperava par beehiiv/kit nas migrações");
      assert.equal(bhKit!.count, 1);

      const bhBrevo = cohort.migrations.find(
        (m) => (m.a === "beehiiv" && m.b === "brevo_diaria") || (m.a === "brevo_diaria" && m.b === "beehiiv"),
      );
      assert.ok(bhBrevo, "esperava par beehiiv/brevo_diaria nas migrações");
      assert.equal(bhBrevo!.count, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reativação: brevo_diaria ativo + histórico em outra plataforma conta; brevo_diaria sozinho ou inativo não conta", () => {
    const root = makeRoot();
    try {
      const dbPath = dbPathFor(root);
      const db = openDiariaSubscribersDb(dbPath);

      // Reativou e ficou: beehiiv (velho) + brevo_diaria ativo.
      const reativado = ensureSubscriber(db, "beehiiv", "bh-1", "reativou@x.com", NOW);
      db.prepare(
        "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'brevo_diaria', ?, ?, ?)",
      ).run(reativado, "brevo-1", "reativou@x.com", NOW);
      upsertSubscription(db, reativado, "brevo_diaria", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);

      // Brevo diária ativo mas SEM histórico em outra plataforma — cadastro
      // novo direto na Brevo, não é "reativação" (nunca existiu alhures).
      const novo = ensureSubscriber(db, "brevo_diaria", "brevo-2", "novo@x.com", NOW);
      upsertSubscription(db, novo, "brevo_diaria", { status: "active", enteredAt: NOW, exitedAt: null, source: null }, NOW);

      // Tentou reativar mas não ficou: subscription inativa.
      const naoFicou = ensureSubscriber(db, "beehiiv", "bh-3", "naoficou@x.com", NOW);
      db.prepare(
        "INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'brevo_diaria', ?, ?, ?)",
      ).run(naoFicou, "brevo-3", "naoficou@x.com", NOW);
      upsertSubscription(db, naoFicou, "brevo_diaria", { status: "unsubscribed", enteredAt: NOW, exitedAt: NOW, source: null }, NOW);

      db.close();

      const cohort = buildSubscribersCohortData(root);
      assert.equal(cohort.reactivation.count, 1);
      assert.match(cohort.reactivation.note, /aproxima/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("toda resposta carrega a nota de piso, mesmo com dado real presente", () => {
    const root = makeRoot();
    try {
      const dbPath = dbPathFor(root);
      const db = openDiariaSubscribersDb(dbPath);
      ensureSubscriber(db, "kit", null, "a@x.com", NOW);
      db.close();

      const cohort = buildSubscribersCohortData(root);
      assert.equal(cohort.note, CROSS_PLATFORM_FLOOR_NOTE);
      assert.equal(cohort.unmatched!.note, CROSS_PLATFORM_FLOOR_NOTE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
