/**
 * test/verify-emails-mv-since-4347.test.ts (#4347 Etapa 2d)
 *
 * Modo `--since` do verify-emails-mv.ts — particiona o recorte por cohort
 * (cadastro novo, laço Stripe→MV→envio da skill `/diaria-clarice-novos`) +
 * guard de custo (D8). Cobre: distinctCohortsSince, readStoreCandidatesSince
 * (respeitando "skip forever"), planSinceVerification (isenção MV com custo
 * zero), checkMvCostGuard (501 sem --confirm aborta sem gastar crédito; 500
 * passa), e `main()` end-to-end sem NENHUMA chamada de rede quando o guard
 * aborta.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  distinctCohortsSince,
  readStoreCandidatesSince,
  planSinceVerification,
  checkMvCostGuard,
  estimateMvCostUsd,
  MV_COST_GUARD_THRESHOLD,
  main,
  type SinceCohortPlan,
} from "../scripts/verify-emails-mv.ts";
import { SCHEMA } from "../scripts/lib/clarice-db.ts";
import { COHORT_ASSINANTES_ATIVOS } from "../scripts/lib/cohorts.ts";

function seedDb(
  rows: Array<{
    email: string;
    name?: string | null;
    cohort: string | null;
    created?: string | null;
    mv_bucket?: string | null;
  }>,
): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const insert = db.prepare(
    `INSERT INTO clarice_users (email, name, cohort, created, mv_bucket) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(r.email, r.name ?? null, r.cohort, r.created ?? null, r.mv_bucket ?? null);
  }
  return db;
}

// ---------------------------------------------------------------------------
// distinctCohortsSince
// ---------------------------------------------------------------------------

test("distinctCohortsSince: cohorts distintos com created >= since; ignora null/anterior à janela", () => {
  const db = seedDb([
    { email: "a@x.com", cohort: "leads-2026-07", created: "2026-07-10T00:00:00Z" },
    { email: "b@x.com", cohort: "leads-2026-07", created: "2026-07-20T00:00:00Z" }, // mesmo cohort, não duplica
    { email: "c@x.com", cohort: COHORT_ASSINANTES_ATIVOS, created: "2026-07-05T00:00:00Z" },
    { email: "d@x.com", cohort: "leads-2026-06", created: "2026-06-15T00:00:00Z" }, // antes da janela
    { email: "e@x.com", cohort: null, created: "2026-07-15T00:00:00Z" }, // sem cohort — ignorado
  ]);
  try {
    assert.deepEqual(distinctCohortsSince(db, "2026-07-01"), [COHORT_ASSINANTES_ATIVOS, "leads-2026-07"]);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// readStoreCandidatesSince — "skip forever" continua valendo
// ---------------------------------------------------------------------------

test("readStoreCandidatesSince: só created>=since E nunca-verificado (skip forever)", () => {
  const db = seedDb([
    { email: "novo@x.com", cohort: "leads-2026-07", created: "2026-07-10T00:00:00Z", mv_bucket: null },
    { email: "antigo@x.com", cohort: "leads-2026-07", created: "2026-06-01T00:00:00Z", mv_bucket: null }, // antes da janela
    { email: "ja-verificado@x.com", cohort: "leads-2026-07", created: "2026-07-15T00:00:00Z", mv_bucket: "verified" }, // skip forever
  ]);
  try {
    const { rows } = readStoreCandidatesSince(db, "leads-2026-07", "2026-07-01");
    assert.deepEqual(rows.map((r) => r.email), ["novo@x.com"]);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// planSinceVerification — isenção MV com custo zero (D2/G4)
// ---------------------------------------------------------------------------

test("planSinceVerification: cohort MV-isento (assinantes-ativos) entra com exempt=true, todoCount=0, custo zero", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "mv-since-plan-exempt-"));
  const db = seedDb([
    { email: "payer@x.com", cohort: COHORT_ASSINANTES_ATIVOS, created: "2026-07-10T00:00:00Z", mv_bucket: null },
    { email: "lead@x.com", cohort: "leads-2026-07", created: "2026-07-10T00:00:00Z", mv_bucket: null },
  ]);
  try {
    const plan = planSinceVerification(db, "2026-07-01", dir, null);
    const payer = plan.find((p) => p.cohort === COHORT_ASSINANTES_ATIVOS)!;
    const lead = plan.find((p) => p.cohort === "leads-2026-07")!;
    assert.equal(payer.exempt, true);
    assert.equal(payer.todoCount, 0);
    assert.equal(payer.candidates.length, 0);
    assert.equal(lead.exempt, false);
    assert.equal(lead.todoCount, 1);
  } finally {
    db.close();
  }
});

test("planSinceVerification: --limit aplica por cohort no todoCount", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "mv-since-plan-limit-"));
  const db = seedDb([
    { email: "a@x.com", cohort: "leads-2026-07", created: "2026-07-10T00:00:00Z", mv_bucket: null },
    { email: "b@x.com", cohort: "leads-2026-07", created: "2026-07-11T00:00:00Z", mv_bucket: null },
    { email: "c@x.com", cohort: "leads-2026-07", created: "2026-07-12T00:00:00Z", mv_bucket: null },
  ]);
  try {
    const plan = planSinceVerification(db, "2026-07-01", dir, 2);
    assert.equal(plan[0].todoCount, 2);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// checkMvCostGuard (D8)
// ---------------------------------------------------------------------------

test("checkMvCostGuard: exatamente no teto (500) passa sem --confirm", () => {
  assert.deepEqual(checkMvCostGuard(MV_COST_GUARD_THRESHOLD, false), { ok: true });
});

test("REGRESSÃO (#4347 D8): 501 e-mails sem --confirm aborta", () => {
  const result = checkMvCostGuard(MV_COST_GUARD_THRESHOLD + 1, false);
  assert.equal(result.ok, false);
});

test("checkMvCostGuard: 501 e-mails COM --confirm passa", () => {
  assert.deepEqual(checkMvCostGuard(MV_COST_GUARD_THRESHOLD + 1, true), { ok: true });
});

test("estimateMvCostUsd: ~US$1,90/1000 e-mails", () => {
  assert.equal(estimateMvCostUsd(1000), 1.9);
  assert.equal(estimateMvCostUsd(500), 0.95);
});

// ---------------------------------------------------------------------------
// main() --since end-to-end — guard de custo aborta SEM gastar crédito
// (nenhuma chamada de rede) e o modo funciona com um cohort isento + um não.
// ---------------------------------------------------------------------------

function captureAll(fn: () => Promise<void>): Promise<{ logs: string[]; errs: string[] }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  return fn().finally(() => {
    console.log = origLog;
    console.error = origErr;
  }).then(() => ({ logs, errs }));
}

test("REGRESSÃO (#4347 D8): main() --since com 501 e-mails a verificar aborta SEM nenhuma chamada de rede (fetch nunca chamado)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "mv-since-e2e-cap-"));
  const dbPath = resolve(dir, "store.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const insert = db.prepare(`INSERT INTO clarice_users (email, name, cohort, created, mv_bucket) VALUES (?, ?, ?, ?, NULL)`);
  for (let i = 0; i < MV_COST_GUARD_THRESHOLD + 1; i++) {
    insert.run(`novo${i}@x.com`, `Novo ${i}`, "leads-2026-07", "2026-07-10T00:00:00Z");
  }
  db.close();

  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls++; throw new Error("fetch NUNCA deveria ser chamado"); }) as typeof fetch;
  const origExit = process.exit;
  let exitCode: number | undefined;
  // @ts-expect-error stub
  process.exit = (code?: number) => { exitCode = code; throw Object.assign(new Error("mock-exit"), { __mockExit: true }); };
  process.env.MILLION_VERIFIER_API_KEY = "fake-key-test";

  try {
    await captureAll(() =>
      main(["--since", "2026-07-01", "--cycle", "2606-07", "--db", dbPath, "--data-root", dir]).catch((e) => {
        if (!(e instanceof Error && (e as Error & { __mockExit?: boolean }).__mockExit)) throw e;
      }),
    );
  } finally {
    globalThis.fetch = origFetch;
    process.exit = origExit;
    delete process.env.MILLION_VERIFIER_API_KEY;
  }
  assert.equal(fetchCalls, 0, "nenhuma chamada de rede — crédito zero gasto");
  assert.equal(exitCode, 1);
});

test("main() --since: cohort isento pulado + cohort não-isento verificado, CSVs escritos por cohort", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "mv-since-e2e-ok-"));
  const dbPath = resolve(dir, "store.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO clarice_users (email, name, cohort, created, mv_bucket) VALUES (?, ?, ?, ?, NULL)`)
    .run("payer@x.com", "Payer", COHORT_ASSINANTES_ATIVOS, "2026-07-10T00:00:00Z");
  db.prepare(`INSERT INTO clarice_users (email, name, cohort, created, mv_bucket) VALUES (?, ?, ?, ?, NULL)`)
    .run("lead@x.com", "Lead", "leads-2026-07", "2026-07-10T00:00:00Z");
  db.close();

  const cycleDir = resolve(dir, "2606-07");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ email: "lead@x.com", result: "ok", resultcode: 1, quality: "good", credits: 999 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  process.env.MILLION_VERIFIER_API_KEY = "fake-key-test";

  let logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    await main(["--since", "2026-07-01", "--cycle", "2606-07", "--db", dbPath, "--data-root", dir]);
  } finally {
    console.log = origLog;
    globalThis.fetch = origFetch;
    delete process.env.MILLION_VERIFIER_API_KEY;
  }
  const out = JSON.parse(logs.join("\n"));
  assert.deepEqual(out.exempt_cohorts, [COHORT_ASSINANTES_ATIVOS]);
  assert.equal(out.cohorts.length, 1);
  assert.equal(out.cohorts[0].cohort, "leads-2026-07");
  assert.equal(out.cohorts[0].processed_this_run, 1);
  assert.ok(existsSync(resolve(cycleDir, "mv-export-leads-2026-07-verified.csv")));
});
