/**
 * test/clarice-sunset-damage-report.test.ts (#5401)
 *
 * `computeSunsetDamageReport` é READ-ONLY: só SELECT, nenhuma escrita no
 * store. Trava que ele conta corretamente os contatos cortados por
 * `sunset_non_opener` agrupados pelo mês de `last_sent_at` — mesma forma da
 * tabela usada no corpo da issue #5401 pra medir o dano.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { computeSunsetDamageReport } from "../scripts/clarice-sunset-damage-report.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";

function makeDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "sunset-damage-report-"));
  return openClariceDb(resolve(dir, "store.db"));
}

test("computeSunsetDamageReport: conta só sunset_non_opener, agrupado por mês de last_sent_at", () => {
  const db = makeDb();
  const insert = (email: string, reason: string | null, eligible: 0 | 1, lastSentAt: string | null) => {
    db.prepare(
      `INSERT INTO clarice_users (email, tier, send_eligible, ineligible_reason, last_sent_at)
       VALUES (?, 2, ?, ?, ?)`,
    ).run(email, eligible, reason, lastSentAt);
  };

  insert("a@x.com", "sunset_non_opener", 0, "2026-07-20T07:15:07.000Z");
  insert("b@x.com", "sunset_non_opener", 0, "2026-07-28T07:38:12.000Z");
  insert("c@x.com", "sunset_non_opener", 0, "2026-08-09T06:41:18.000Z");
  insert("d@x.com", "hard_bounce", 0, "2026-07-20T07:15:07.000Z"); // outro motivo — não conta
  insert("e@x.com", null, 1, "2026-08-01T00:00:00.000Z"); // elegível — não conta
  insert("f@x.com", "sunset_non_opener", 0, null); // sem last_sent_at — "(null)"

  const report = computeSunsetDamageReport(db);
  db.close();

  assert.equal(report.total_sunset_cut, 4);
  assert.deepEqual(report.by_last_sent_month, {
    "2026-07": 2,
    "2026-08": 1,
    "(null)": 1,
  });
});

test("computeSunsetDamageReport: store sem nenhum corte de sunset → total 0, mapa vazio", () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO clarice_users (email, tier, send_eligible, ineligible_reason) VALUES ('a@x.com', 2, 1, NULL)`,
  ).run();
  const report = computeSunsetDamageReport(db);
  db.close();

  assert.equal(report.total_sunset_cut, 0);
  assert.deepEqual(report.by_last_sent_month, {});
});
