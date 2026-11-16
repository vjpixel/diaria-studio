/**
 * #13268: a ingestão do Kit passou de ~11 min para ~3h20 quando `data/` foi
 * para o HD SATA do `300` (1m42s de CPU em 3h24 de relógio: espera de disco).
 * Cada INSERT/UPDATE era uma transação própria, com um fsync por commit. A
 * correção põe cada lote numa transação (`runInTransaction`, SAVEPOINT para
 * aninhar com o `ensureSubscriber`).
 *
 * O teste de regressão instrumenta `db.prepare`: toda escrita feita pelas
 * funções de ingestão precisa rodar com `db.isTransaction === true` aberto por
 * fora dela, ou seja, nenhuma escrita em autocommit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  openDiariaSubscribersDb,
  ensureSubscriber,
  runInTransaction,
  getStoreCounts,
} from "../scripts/lib/diaria-subscribers-db.ts";
import {
  ingestBroadcastAudience,
  ingestBroadcastUrlClicks,
  ingestKitRoster,
} from "../scripts/lib/kit-subscribers-ingest.ts";
import type { KitSubscriberSummary } from "../scripts/lib/kit-subscribers.ts";

/** Registra, para cada `run()` de INSERT/UPDATE, se havia transação aberta. */
function trackAutocommitWrites(db: DatabaseSync): { autocommit: string[]; writes: number } {
  const state = { autocommit: [] as string[], writes: 0 };
  const origPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => StatementSync }).prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    if (!/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return stmt;
    const origRun = stmt.run.bind(stmt);
    (stmt as unknown as { run: (...a: unknown[]) => unknown }).run = (...args: unknown[]) => {
      state.writes++;
      if (!db.isTransaction) state.autocommit.push(sql.trim().split("\n")[0]);
      return (origRun as (...a: unknown[]) => unknown)(...args);
    };
    return stmt;
  };
  return state;
}

describe("runInTransaction (#13268)", () => {
  it("aninha com ensureSubscriber (SAVEPOINT, nunca BEGIN dentro de BEGIN)", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const id = runInTransaction(db, () => ensureSubscriber(db, "kit", null, "a@x.com", "2026-11-16T00:00:00.000Z"));
    assert.ok(id > 0);
    assert.equal(db.isTransaction, false, "transação fechada ao sair");
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });

  it("exceção desfaz o que fn gravou e é relançada", () => {
    const db = openDiariaSubscribersDb(":memory:");
    assert.throws(
      () =>
        runInTransaction(db, () => {
          ensureSubscriber(db, "kit", null, "a@x.com");
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(db.isTransaction, false);
    assert.equal(getStoreCounts(db).subscribers, 0);
    db.close();
  });

  it("aninhada: falha interna desfaz só o bloco interno", () => {
    const db = openDiariaSubscribersDb(":memory:");
    runInTransaction(db, () => {
      ensureSubscriber(db, "kit", null, "a@x.com");
      assert.throws(() =>
        runInTransaction(db, () => {
          ensureSubscriber(db, "kit", null, "b@x.com");
          throw new Error("interno");
        }),
      );
    });
    assert.equal(getStoreCounts(db).subscribers, 1);
    db.close();
  });

  it("recusa fn assíncrona", () => {
    const db = openDiariaSubscribersDb(":memory:");
    assert.throws(() => runInTransaction(db, (async () => undefined) as unknown as () => void), /síncrona/);
    assert.equal(db.isTransaction, false);
    db.close();
  });
});

describe("ingestão do Kit sem escrita em autocommit (regressão #13268)", () => {
  const emails = ["a@x.com", "b@x.com", "c@x.com"];

  it("ingestBroadcastAudience", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const t = trackAutocommitWrites(db);
    const r = ingestBroadcastAudience(db, 1, "sent", emails, "2026-11-01T09:00:00.000Z");
    assert.equal(r.newEvents, 3);
    assert.ok(t.writes > 0);
    assert.deepEqual(t.autocommit, []);
    db.close();
  });

  it("ingestBroadcastUrlClicks", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const t = trackAutocommitWrites(db);
    const r = ingestBroadcastUrlClicks(db, 1, "https://diar.ia.br/x", emails, "2026-11-01T09:00:00.000Z");
    assert.equal(r.newEvents, 3);
    assert.ok(t.writes > 0);
    assert.deepEqual(t.autocommit, []);
    db.close();
  });

  it("ingestKitRoster", () => {
    const db = openDiariaSubscribersDb(":memory:");
    const t = trackAutocommitWrites(db);
    const roster = emails.map(
      (email_address, i) =>
        ({
          id: i + 1,
          email_address,
          state: "active",
          created_at: "2026-10-01T00:00:00Z",
          fields: { apoio_nivel: "Mantenedor" },
        }) as unknown as KitSubscriberSummary,
    );
    const r = ingestKitRoster(db, roster, "2026-11-16T07:25:00.000Z");
    assert.equal(r.processed, 3);
    assert.ok(t.writes > 0);
    assert.deepEqual(t.autocommit, []);
    db.close();
  });
});
