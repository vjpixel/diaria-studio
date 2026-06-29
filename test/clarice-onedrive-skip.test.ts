import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildUniverse } from "../scripts/merge-clarice-subscribers.ts";
import { ingestMv } from "../scripts/clarice-build-db.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";

// Regressão (#2654): um CSV ilegível (placeholder OneDrive não-hidratado) não
// pode crashar o build. Simulamos "ilegível" com um DIRETÓRIO de nome *.csv —
// readFileSync nele lança EISDIR de forma portável (Win/macOS/Linux), exercitando
// o mesmo caminho de skip que o erro UNKNOWN do OneDrive.

function tmp(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

test("buildUniverse: pula CSV-fonte ilegível sem crashar (skippedFiles)", () => {
  const dir = tmp("cu-uni-");
  writeFileSync(
    resolve(dir, "stripe-customers-ok.csv"),
    "id,Email,Name,Created (UTC),Status\ncus_1,ana@gmail.com,Ana,2026-01-01 10:00:00,active\n",
  );
  mkdirSync(resolve(dir, "stripe-customers-bad.csv")); // dir-as-csv → EISDIR no readFileSync

  const u = buildUniverse(dir, new Date());
  assert.ok(
    u.skippedFiles.includes("stripe-customers-bad.csv"),
    "o arquivo ilegível deve aparecer em skippedFiles",
  );
  assert.equal(u.kept.length, 1, "o CSV válido ainda é ingerido");
});

test("ingestMv: pula MV ilegível sem abortar a transação (skipped)", () => {
  const dir = tmp("cu-mv-");
  const cyc = resolve(dir, "2605-06"); // ciclo válido (envio = conteúdo+1)
  mkdirSync(cyc);
  writeFileSync(
    resolve(cyc, "mv-export-t02-verified.csv"),
    "email,MV_RESULT,MV_QUALITY,MV_CODE\nbob@gmail.com,ok,good,1\n",
  );
  mkdirSync(resolve(cyc, "mv-export-bad-verified.csv")); // dir-as-csv → EISDIR

  const db = openClariceDb(":memory:");
  const r = ingestMv(db, dir);
  assert.ok(
    r.skipped.includes("2605-06/mv-export-bad-verified.csv"),
    "o MV ilegível deve aparecer em skipped",
  );
  assert.equal(r.rows, 1, "o MV válido ainda é ingerido (transação commitada)");
  // confirma durabilidade: a linha do MV bom está no DB
  const n = (
    db.prepare("SELECT COUNT(*) AS n FROM clarice_users WHERE mv_result = 'ok'").get() as {
      n: number;
    }
  ).n;
  assert.equal(n, 1);
  db.close();
});
