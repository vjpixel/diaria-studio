/** Regressão #10479: fila completa de elegíveis por onda + verificador de ordem. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main } from "../scripts/clarice-build-segment.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";
import { buildEligibleQueueCsv, verifyEligibleQueueCsv } from "../scripts/lib/clarice-daily-eligible-queue.ts";

test("verificador: fila ordenada passa; incluído com score menor que excluído falha", () => {
  const q = [
    { email: "a@x.com", priority_points: 50, created: "2026-01-01" },
    { email: "b@x.com", priority_points: 10, created: "2026-01-02" },
    { email: "c@x.com", priority_points: 5, created: "2026-01-03" },
  ];
  assert.deepEqual(verifyEligibleQueueCsv(buildEligibleQueueCsv(q, 2)), []);
  const ruim = buildEligibleQueueCsv([q[2], q[0], q[1]], 1);
  const v = verifyEligibleQueueCsv(ruim);
  assert.equal(v.length, 1);
  assert.equal(v[0].included_email, "c@x.com");
  assert.equal(v[0].excluded_score, 50);
});

test("main --daily grava daily-eligible-queue.csv com TODOS os elegíveis (incluídos e deixados de fora)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "daily-elig-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  const ins = db.prepare(
    `INSERT INTO clarice_users (email, name, cohort, priority_points, sends_count, send_eligible, mv_bucket, created)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  ins.run("alto@gmail.com", "Alto", null, 80, 3, 1, null, "2026-01-01T00:00:00Z");
  ins.run("medio@gmail.com", "Medio", null, 40, 3, 1, null, "2026-01-02T00:00:00Z");
  ins.run("baixo@gmail.com", "Baixo", null, 10, 3, 1, null, "2026-01-03T00:00:00Z");
  db.close();
  const prevKey = process.env.BREVO_CLARICE_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.BREVO_CLARICE_API_KEY = "test-fake-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ campaigns: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const log = console.log;
  const real = process.exit; process.exit = ((c?: number) => { throw new Error("exit " + c); }) as typeof process.exit; console.log = () => {};
  try {
    await main(["--cycle", "2608-09", "--db", dbPath, "--data-root", dir, "--daily", "--budget", "2", "--send-date", "2026-09-05"]);
  } finally {
    process.exit = real; console.log = log;
    globalThis.fetch = prevFetch;
    if (prevKey !== undefined) process.env.BREVO_CLARICE_API_KEY = prevKey;
    else delete process.env.BREVO_CLARICE_API_KEY;
  }
  const f = resolve(clariceSegmentsDir("2608-09", dir), "daily-eligible-queue-2026-09-05.csv");
  assert.ok(existsSync(f));
  const csv = readFileSync(f, "utf8");
  const linhas = csv.trim().split(/\r?\n/);
  assert.equal(linhas.length, 4, "header + 3 elegíveis");
  assert.match(linhas[1], /alto@gmail.com,80,.*,1$/);
  assert.match(linhas[3], /baixo@gmail.com,10,.*,0$/);
  assert.deepEqual(verifyEligibleQueueCsv(csv), []);
});
