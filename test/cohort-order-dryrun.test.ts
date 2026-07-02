import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  compareOrders,
  firstSendByTier,
  firstSendByCohort,
  renderComparisonReport,
  main,
} from "../scripts/cohort-order-dryrun.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";
import { loadStoreRows, type StoreRow } from "../scripts/lib/clarice-segment.ts";
import { cohortFromTier } from "../scripts/lib/cohorts.ts";

function row(p: Partial<StoreRow> & { email: string }): StoreRow {
  const tier = p.tier ?? null;
  return {
    tier,
    cohort: cohortFromTier(tier),
    priority_points: 0,
    send_eligible: 1,
    ineligible_reason: null,
    sends_count: 0,
    ...p,
  };
}

test("firstSendByTier / firstSendByCohort: filtram só firstSend (elegível, nunca enviado)", () => {
  const rows: StoreRow[] = [
    row({ email: "elig@x.com", tier: 1 }),
    row({ email: "cortado@x.com", tier: 1, send_eligible: 0, ineligible_reason: "unsubscribed" }),
    row({ email: "reenvio@x.com", tier: 1, sends_count: 3, priority_points: 10 }),
  ];
  assert.deepEqual(firstSendByTier(rows).map((r) => r.email), ["elig@x.com"]);
  assert.deepEqual(firstSendByCohort(rows).map((r) => r.email), ["elig@x.com"]);
});

test("compareOrders: sem safras, diffCount=0 e as duas ordens são idênticas", () => {
  const rows: StoreRow[] = [
    row({ email: "a1@x.com", tier: 1 }),
    row({ email: "a2@x.com", tier: 2 }),
    row({ email: "a3@x.com", tier: 5 }),
    row({ email: "a4@x.com", tier: null }),
  ];
  const cmp = compareOrders(rows, 10);
  assert.equal(cmp.firstSendTotal, 4);
  assert.equal(cmp.diffCount, 0);
  assert.deepEqual(cmp.tierOrderTop, cmp.cohortOrderTop);
  assert.deepEqual(cmp.sampleDiffs, []);
});

test("compareOrders: com safras, a diferença documentada aparece nos diffs (posição + email dos 2 lados)", () => {
  const rows: StoreRow[] = [
    row({ email: "a-janabr@x.com", tier: 3, cohort: "leads-2026-jan-abr" }),
    row({ email: "b-mai@x.com", tier: 3, cohort: "leads-2026-05" }),
    row({ email: "c-jun@x.com", tier: 3, cohort: "leads-2026-06" }),
  ];
  const cmp = compareOrders(rows, 10);
  assert.equal(cmp.firstSendTotal, 3);
  // tier-order (empate por tier=3, desempate alfabético): a, b, c.
  assert.deepEqual(cmp.tierOrderTop, ["a-janabr@x.com", "b-mai@x.com", "c-jun@x.com"]);
  // cohort-order (recência): c (jun) > b (mai) > a (jan-abr).
  assert.deepEqual(cmp.cohortOrderTop, ["c-jun@x.com", "b-mai@x.com", "a-janabr@x.com"]);
  // posições 1 e 3 divergem (a↔c trocam de lugar); posição 2 (b-mai) é a MESMA
  // em ambas as ordens — não deveria contar como diff.
  assert.equal(cmp.diffCount, 2);
  assert.deepEqual(cmp.sampleDiffs, [
    { position: 1, tierOrderEmail: "a-janabr@x.com", cohortOrderEmail: "c-jun@x.com" },
    { position: 3, tierOrderEmail: "c-jun@x.com", cohortOrderEmail: "a-janabr@x.com" },
  ]);
});

test("compareOrders: `top` limita o que é REPORTADO, não o que é comparado (diffCount cobre a fila inteira)", () => {
  const rows: StoreRow[] = Array.from({ length: 20 }, (_, i) =>
    row({ email: `t${String(i).padStart(2, "0")}@x.com`, tier: (i % 10) + 1 }),
  );
  const cmp = compareOrders(rows, 3);
  assert.equal(cmp.firstSendTotal, 20);
  assert.equal(cmp.tierOrderTop.length, 3);
  assert.equal(cmp.cohortOrderTop.length, 3);
});

test("renderComparisonReport: contém o resumo, a tabela lado a lado e a amostra de diffs", () => {
  const rows: StoreRow[] = [
    row({ email: "a-janabr@x.com", tier: 3, cohort: "leads-2026-jan-abr" }),
    row({ email: "c-jun@x.com", tier: 3, cohort: "leads-2026-06" }),
  ];
  const cmp = compareOrders(rows, 10);
  const md = renderComparisonReport(cmp, 10);
  assert.match(md, /Dry-run comparativo/);
  assert.match(md, /READ-ONLY/);
  assert.match(md, /PII/);
  assert.match(md, /a-janabr@x\.com/);
  assert.match(md, /c-jun@x\.com/);
  assert.match(md, /100\.0%/, "diffCount=2 de firstSendTotal=2 → 100%");
});

test("renderComparisonReport: sem firstSend (universo vazio) não lança e mostra placeholder", () => {
  const cmp = compareOrders([], 10);
  assert.doesNotThrow(() => renderComparisonReport(cmp, 10));
  const md = renderComparisonReport(cmp, 10);
  assert.match(md, /nenhum contato firstSend/);
});

test("main: smoke sobre store seedado — imprime relatório sem lançar, store vazio aborta com erro claro", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cohort-dryrun-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, status, tier, created) VALUES ('a@x.com','A','active',1,'2025-01-01T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO clarice_users (email, name, status, tier, created) VALUES ('b@x.com','B',NULL,4,'2025-01-01T00:00:00Z')",
  ).run();
  recomputeDerived(db);
  db.close();

  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    assert.doesNotThrow(() => main(["--db", dbPath, "--top", "5"]));
  } finally {
    console.log = orig;
  }
  assert.match(logs.join("\n"), /Dry-run comparativo/);

  // store vazio (path novo, schema criado mas 0 linhas) — deve abortar, não
  // reportar "0 divergências" como se fosse seguro.
  const emptyDbPath = resolve(dir, "empty.db");
  const errors: string[] = [];
  const origErr = console.error;
  const origExit = process.exit;
  console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
  // @ts-expect-error — stub de process.exit pra capturar sem matar o test runner
  process.exit = (code?: number) => { throw new Error(`exit:${code}`); };
  try {
    assert.throws(() => main(["--db", emptyDbPath]), /exit:1/);
  } finally {
    console.error = origErr;
    process.exit = origExit;
  }
  assert.ok(errors.some((e) => /store vazio/.test(e)));
});

// loadStoreRows re-exportado só pra garantir que o script usa a MESMA leitura
// que segmentFromStore (não uma query duplicada) — smoke leve, não duplica
// cobertura de test/clarice-segment.test.ts.
test("compareOrders: opera sobre StoreRow[] vindo de loadStoreRows (integração leve)", () => {
  const db = openClariceDb(":memory:");
  db.prepare("INSERT INTO clarice_users (email, tier, created) VALUES ('x@x.com', 1, '2025-01-01T00:00:00Z')").run();
  recomputeDerived(db);
  const rows = loadStoreRows(db);
  db.close();
  const cmp = compareOrders(rows, 5);
  assert.equal(cmp.firstSendTotal, 1);
});
