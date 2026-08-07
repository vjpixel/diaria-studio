import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Papa from "papaparse";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";
import { runMvOnDemandPlan } from "../scripts/clarice-mv-ondemand.ts";
import { mvOutputBase } from "../scripts/verify-emails-mv.ts";
import type { MvOnDemandPlan } from "../scripts/lib/clarice-wave-plan.ts";

/**
 * Seeda um store SQLite real em disco (não `:memory:` — `runMvOnDemandPlan`
 * abre sua PRÓPRIA conexão via `dbPath`, e conexões `:memory:` separadas não
 * compartilham dado; mesmo motivo pelo qual `test/verify-emails-mv.test.ts`
 * usa `mkdtempSync` pros testes de `main()`/CSV em disco).
 */
function seedStore(
  dbPath: string,
  rows: Array<{ email: string; name?: string | null; cohort: string; mv_bucket?: string | null }>,
): void {
  const db = openClariceDb(dbPath);
  const insert = db.prepare(`INSERT INTO clarice_users (email, name, cohort, mv_bucket) VALUES (?, ?, ?, ?)`);
  for (const r of rows) insert.run(r.email, r.name ?? null, r.cohort, r.mv_bucket ?? null);
  db.close();
}

/** Mock de fetch: todo email volta "ok" (verified). */
function mockFetchAllOk(): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    const email = url.searchParams.get("email") ?? "";
    return new Response(JSON.stringify({ email, result: "ok", resultcode: 1, quality: "good", credits: 999 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("runMvOnDemandPlan (#4659) — executa o plano contra o store, cohort por cohort", () => {
  it("verifica cada cohort do plano respeitando o LIMIT alocado (nunca o cohort inteiro)", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mv-ondemand-"));
    const dbPath = resolve(dir, "clarice.db");
    seedStore(dbPath, [
      { email: "a1@x.com", cohort: "ex-assinantes" },
      { email: "a2@x.com", cohort: "ex-assinantes" },
      { email: "a3@x.com", cohort: "ex-assinantes" }, // sobra — fora do limit do plano
      { email: "b1@x.com", cohort: "leads-2026-06" },
    ]);

    const plan: MvOnDemandPlan = {
      deficit: 3,
      targetVerifyCount: 3,
      byCohort: [
        { cohort: "ex-assinantes", count: 2 },
        { cohort: "leads-2026-06", count: 1 },
      ],
      totalPlanned: 3,
      backlogInsufficient: false,
      estimatedCostUsd: 3 * 0.0019,
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchAllOk();
    try {
      const summary = await runMvOnDemandPlan({
        apiKey: "fake-key",
        dbPath,
        cycleDir: dir,
        plan,
        concurrency: 2,
        timeout: 5,
      });

      assert.equal(summary.perCohort.length, 2, "1 CohortVerifySummary por entrada do plano, na MESMA ordem");
      assert.equal(summary.perCohort[0].cohort, "ex-assinantes");
      assert.equal(
        summary.perCohort[0].processed_this_run,
        2,
        "respeita alloc.count como limit — não verifica os 3 candidatos disponíveis do cohort",
      );
      assert.equal(summary.perCohort[1].cohort, "leads-2026-06");
      assert.equal(summary.perCohort[1].processed_this_run, 1);
      assert.equal(summary.totalVerifiedNow, 3);
      assert.equal(summary.approvalRate, 1, "todo mundo voltou 'ok' → 100% de aprovação");

      // REGRESSÃO: o 3º contato de ex-assinantes (fora do limit) nunca foi tocado.
      const base = mvOutputBase("ex-assinantes");
      const verifiedCsv = Papa.parse<Record<string, string>>(
        readFileSync(resolve(dir, `${base}-verified.csv`), "utf-8"),
        { header: true, skipEmptyLines: true },
      ).data;
      assert.equal(verifiedCsv.length, 2);
      assert.ok(!verifiedCsv.some((r) => r.email === "a3@x.com"), "candidato fora do limit não devia ser verificado");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("plano vazio (déficit zero) → nenhum cohort tocado, summary zerado", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mv-ondemand-empty-"));
    const dbPath = resolve(dir, "clarice.db");
    seedStore(dbPath, [{ email: "a@x.com", cohort: "ex-assinantes" }]);

    const emptyPlan: MvOnDemandPlan = {
      deficit: 0,
      targetVerifyCount: 0,
      byCohort: [],
      totalPlanned: 0,
      backlogInsufficient: false,
      estimatedCostUsd: 0,
    };

    // Sem mock de fetch — se `runMvOnDemandPlan` tentar chamar a API MV aqui,
    // o teste falha por rede real indisponível/erro, o que já denunciaria a
    // regressão (plano vazio nunca deveria gastar crédito).
    const summary = await runMvOnDemandPlan({
      apiKey: "fake-key",
      dbPath,
      cycleDir: dir,
      plan: emptyPlan,
      concurrency: 2,
      timeout: 5,
    });
    assert.equal(summary.perCohort.length, 0);
    assert.equal(summary.totalVerifiedNow, 0);
    assert.equal(summary.approvalRate, null, "nada decidido ainda → taxa de aprovação null, nunca 0 ou NaN");
  });

  it("aprovação mista (verified + rejected) calcula a taxa correta, 'unknown' fica fora do denominador", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mv-ondemand-mixed-"));
    const dbPath = resolve(dir, "clarice.db");
    seedStore(dbPath, [
      { email: "ok@x.com", cohort: "ex-assinantes" },
      { email: "bad@x.com", cohort: "ex-assinantes" },
    ]);
    const plan: MvOnDemandPlan = {
      deficit: 2,
      targetVerifyCount: 2,
      byCohort: [{ cohort: "ex-assinantes", count: 2 }],
      totalPlanned: 2,
      backlogInsufficient: false,
      estimatedCostUsd: 2 * 0.0019,
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      const email = url.searchParams.get("email") ?? "";
      const result = email === "ok@x.com" ? "ok" : "invalid";
      return new Response(JSON.stringify({ email, result, resultcode: 1, quality: "x", credits: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const summary = await runMvOnDemandPlan({
        apiKey: "fake-key",
        dbPath,
        cycleDir: dir,
        plan,
        concurrency: 2,
        timeout: 5,
      });
      assert.equal(summary.approvalRate, 0.5);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
