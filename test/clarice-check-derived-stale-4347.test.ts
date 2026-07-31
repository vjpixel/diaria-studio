/**
 * test/clarice-check-derived-stale-4347.test.ts (#4347 Etapa 4, Passo 0)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkDerivedStale } from "../scripts/clarice-check-derived-stale.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";

test("checkDerivedStale: store fresco pós-recompute -> 'fresh'", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "check-stale-fresh-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare("INSERT INTO clarice_users (email, tier, sends_count, opens_count) VALUES ('a@x.com', 2, 3, 3)").run();
  recomputeDerived(db);
  db.close();
  assert.equal(checkDerivedStale(dbPath), "fresh");
});

test("checkDerivedStale: brevo_modified_at mais recente que o último recompute -> 'stale'", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "check-stale-stale-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare("INSERT INTO clarice_users (email, tier, sends_count, opens_count) VALUES ('a@x.com', 2, 3, 3)").run();
  recomputeDerived(db);
  const future = new Date(Date.now() + 60_000).toISOString();
  db.prepare("UPDATE clarice_users SET brevo_modified_at = ? WHERE email = 'a@x.com'").run(future);
  db.close();
  assert.equal(checkDerivedStale(dbPath), "stale");
});
