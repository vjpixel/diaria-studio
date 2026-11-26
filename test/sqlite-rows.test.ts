import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { allRows, getRow } from "../scripts/lib/sqlite-rows.ts";

describe("typed SQLite reads", () => {
  it("forwards positional and named bindings and preserves empty results", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE sample (id INTEGER, label TEXT, optional TEXT); INSERT INTO sample VALUES (1, 'first', NULL), (2, 'second', 'value')");
      type Row = { id: number; label: string; optional: string | null };
      const stmt = db.prepare("SELECT * FROM sample WHERE id >= ? ORDER BY id");
      assert.deepEqual(allRows<Row>(stmt, 2), stmt.all(2));
      assert.deepEqual(allRows<Row>(stmt, 3), []);
      const named = db.prepare("SELECT * FROM sample WHERE id = :id");
      assert.deepEqual(getRow<Row>(named, { id: 1 }), named.get({ id: 1 }));
      assert.equal(getRow<Row>(named, { id: 1 })?.optional, null);
      assert.equal(getRow<Row>(named, { id: 3 }), undefined);
      assert.equal(allRows<{ total: number }>(db.prepare("SELECT COUNT(*) AS total FROM sample"))[0].total, 2);
    } finally {
      db.close();
    }
  });

  it("propagates SQLite binding errors", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const stmt = db.prepare("SELECT ? AS value");
      assert.throws(() => allRows(stmt, { missing: 1 }));
      assert.throws(() => getRow(stmt, { missing: 1 }));
    } finally {
      db.close();
    }
  });
});
