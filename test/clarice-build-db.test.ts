import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main as buildDb } from "../scripts/clarice-build-db.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";

// ---------------------------------------------------------------------------
// #2873 — backfill automático de cohort pra linhas nuas (mv-exports/sends/
// Brevo) cujo email existe nos CSVs Stripe do root mas foi EXCLUÍDO da
// ingestão Stripe pela auditoria de qualidade de email (role/test/estudante),
// depois RE-ENTROU no store por caminho secundário sem `stripe_ids`/`created`.
//
// Fixture (per o incidente real 260702): CSV Stripe com email role-account
// (`contato@empresa.com`, excluído por `isLowQualityEmail` → reason
// "role_account") + um mv-export do mesmo email num ciclo válido — o ciclo
// insere a linha nua (INSERT OR IGNORE, stripe_ids NULL) que `ingestStripe`
// nunca tocou (nem kept nem disputed). `recomputeDerived` deve resolver o
// email contra `buildUniverse().merged` (que retém o registro mesmo excluído)
// e backfillar `cohort` a partir do `created` do CSV.
// ---------------------------------------------------------------------------

function tmp(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

function cohortRow(dbPath: string, email: string) {
  const db = openClariceDb(dbPath);
  const row = db
    .prepare(
      "SELECT cohort, stripe_ids, mv_bucket FROM clarice_users WHERE email = ?",
    )
    .get(email) as
    | { cohort: string | null; stripe_ids: string | null; mv_bucket: string | null }
    | undefined;
  db.close();
  return row;
}

test("clarice-build-db main(): linha nua re-entrada via MV ganha cohort correto a partir de membership no CSV Stripe que a auditoria excluiu (#2873)", () => {
  const dataDir = tmp("cbd-2873-");
  const dbDir = tmp("cbd-2873-db-");
  const dbPath = resolve(dbDir, "clarice-users.db");

  // CSV-fonte Stripe: contato@empresa.com é role account (prefixo "contato")
  // → isLowQualityEmail exclui da ingestão (buildUniverse().excluded), MAS o
  // registro persiste em buildUniverse().merged com created=2026-06-10.
  writeFileSync(
    resolve(dataDir, "stripe-customers-role.csv"),
    "id,Email,Name,Created (UTC),Status\n" +
      "cus_role,contato@empresa.com,Empresa Ltda,2026-06-10 10:00,active\n",
  );

  // mv-export do MESMO email, num ciclo válido — caminho secundário que
  // re-insere a linha nua (stripe_ids NULL) no store via ingestMv.
  const cycleDir = resolve(dataDir, "2605-06");
  mkdirSync(cycleDir);
  writeFileSync(
    resolve(cycleDir, "mv-export-contato-verified.csv"),
    "email,MV_RESULT,MV_QUALITY,MV_CODE\ncontato@empresa.com,ok,good,1\n" +
      // email só-de-MV/Brevo, SEM presença nenhuma no CSV Stripe do root —
      // deve permanecer com cohort NULL (nenhum membership pra resolver).
      "leitora-sem-stripe@gmail.com,ok,good,1\n",
  );

  buildDb(["--db", dbPath, "--data-dir", dataDir]);

  const contato = cohortRow(dbPath, "contato@empresa.com");
  assert.ok(contato, "linha da conta role deve existir no store (via ingestMv)");
  assert.equal(
    contato!.stripe_ids,
    null,
    "nunca tocada por ingestStripe (excluída pela auditoria) — stripe_ids permanece NULL",
  );
  assert.equal(contato!.mv_bucket, "verified");
  assert.equal(
    contato!.cohort,
    "leads-2026-06",
    "backfill via membership no CSV Stripe (created 2026-06) — mesma regra computeCohort",
  );

  const semStripe = cohortRow(dbPath, "leitora-sem-stripe@gmail.com");
  assert.ok(semStripe, "linha só-de-MV deve existir no store");
  assert.equal(semStripe!.stripe_ids, null);
  assert.equal(
    semStripe!.cohort,
    null,
    "email sem NENHUM membership no CSV Stripe → cohort permanece NULL (não inventa)",
  );

  // Idempotência (#2857 preserve-then-backfill): rodar de novo não duplica
  // nem perde o cohort já backfillado, nem promove a linha sem-match.
  buildDb(["--db", dbPath, "--data-dir", dataDir]);
  const contato2 = cohortRow(dbPath, "contato@empresa.com");
  const semStripe2 = cohortRow(dbPath, "leitora-sem-stripe@gmail.com");
  assert.equal(contato2!.cohort, "leads-2026-06", "2ª rodada é idempotente — sem drift");
  assert.equal(semStripe2!.cohort, null, "2ª rodada — segue NULL, sem drift");
});
