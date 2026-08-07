/**
 * compare-cohorts.test.ts (#4451 Fase 2/3 — tooling de validação empírica)
 *
 * Testes PUROS, sem I/O (#633) — cobrem diffCohorts/allWithinTolerance/
 * formatCohortsDiff. A EXECUÇÃO empírica (comparar v1 × v2 reais) não é
 * testada aqui — depende de rodar as duas contra a Brevo ao vivo, fora do
 * escopo desta sessão (ver comentário de topo de scripts/compare-cohorts.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { diffCohorts, formatCohortsDiff, main } from "../scripts/compare-cohorts.ts";
import type { EngagementCohorts } from "../scripts/lib/dashboard-kv-types.ts";
import type { CohortsV2Artifact } from "../scripts/lib/cohorts-v2-artifact.ts";

const GEN = "2026-08-02T00:00:00.000Z";

function makeCohorts(overrides: Partial<EngagementCohorts> = {}): EngagementCohorts {
  return {
    generatedAt: GEN,
    universe: 1000,
    opened2plus: 400,
    opened1: 200,
    received1_opened0: 150,
    received2_opened0: 200,
    exits: 50,
    exitsBreakdown: { bounced: 20, optedOut: 30 },
    maxReceived: 12,
    ...overrides,
  };
}

test("diffCohorts: coortes idênticas → todos os campos withinTolerance, absDiff=0", () => {
  const a = makeCohorts();
  const b = makeCohorts();
  const { rows, allWithinTolerance } = diffCohorts(a, b);
  assert.equal(rows.length, 9);
  for (const r of rows) {
    assert.equal(r.absDiff, 0);
    assert.equal(r.withinTolerance, true);
  }
  assert.equal(allWithinTolerance, true);
});

test("diffCohorts: diferença pequena (dentro de 2%) ainda passa", () => {
  const a = makeCohorts({ universe: 1000 });
  const b = makeCohorts({ universe: 1015 }); // 1.5% de diferença
  const { rows, allWithinTolerance } = diffCohorts(a, b, 0.02);
  const universeRow = rows.find((r) => r.field === "universe")!;
  assert.equal(universeRow.absDiff, 15);
  assert.equal(universeRow.withinTolerance, true);
  assert.equal(allWithinTolerance, true);
});

test("diffCohorts: diferença grande (fora de 2%) falha só naquele campo", () => {
  const a = makeCohorts({ universe: 1000, opened1: 200 });
  const b = makeCohorts({ universe: 1200, opened1: 200 }); // 20% de diferença em universe
  const { rows, allWithinTolerance } = diffCohorts(a, b, 0.02);
  const universeRow = rows.find((r) => r.field === "universe")!;
  const opened1Row = rows.find((r) => r.field === "opened1")!;
  assert.equal(universeRow.withinTolerance, false);
  assert.equal(opened1Row.withinTolerance, true);
  assert.equal(allWithinTolerance, false);
});

test("diffCohorts: tolerância mínima é 1 unidade (campo pequeno não exige bater exato)", () => {
  const a = makeCohorts({ exitsBreakdown: { bounced: 1, optedOut: 30 } });
  const b = makeCohorts({ exitsBreakdown: { bounced: 2, optedOut: 30 } });
  const { rows } = diffCohorts(a, b, 0.02); // 2% de 1 arredonda pra 0, mas o piso é 1
  const bouncedRow = rows.find((r) => r.field === "exitsBreakdown.bounced")!;
  assert.equal(bouncedRow.tolerance, 1);
  assert.equal(bouncedRow.withinTolerance, true);
});

test("diffCohorts: campo ausente/undefined de um dos lados falha fechado (withinTolerance:false, nunca lança nem passa silenciosamente)", () => {
  const a = makeCohorts();
  const b = { ...makeCohorts(), universe: undefined } as unknown as EngagementCohorts;
  const { rows, allWithinTolerance } = diffCohorts(a, b);
  const universeRow = rows.find((r) => r.field === "universe")!;
  assert.equal(universeRow.withinTolerance, false);
  assert.equal(allWithinTolerance, false);
});

test("diffCohorts: cobre os 9 campos documentados (inclusive exitsBreakdown.* e maxReceived)", () => {
  const { rows } = diffCohorts(makeCohorts(), makeCohorts());
  const fields = rows.map((r) => r.field);
  assert.deepEqual(fields, [
    "universe",
    "opened2plus",
    "opened1",
    "received1_opened0",
    "received2_opened0",
    "exits",
    "exitsBreakdown.bounced",
    "exitsBreakdown.optedOut",
    "maxReceived",
  ]);
});

test("formatCohortsDiff: produz 1 linha de header + 1 linha por campo, sem lançar", () => {
  const { rows } = diffCohorts(makeCohorts(), makeCohorts({ universe: 1200 }));
  const out = formatCohortsDiff(rows);
  const lines = out.split("\n");
  assert.equal(lines.length, 1 + rows.length);
  assert.ok(out.includes("universe"));
  assert.ok(out.includes("❌ FORA DA TOLERÂNCIA")); // universe diverge
  assert.ok(out.includes("✅ OK")); // os outros 8 campos batem
});

// ─── main() — gate de sinal degradado end-to-end (#4451 achado 6) ────────

function withTmpFiles<T>(files: Record<string, unknown>, fn: (paths: Record<string, string>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "compare-cohorts-"));
  try {
    const paths: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
      const p = resolve(dir, name);
      writeFileSync(p, JSON.stringify(content));
      paths[name] = p;
    }
    return fn(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Mocka process.exit pra capturar o exit code sem matar o processo de teste. */
async function runMainCapturingExit(argv: string[]): Promise<{ exitCode: number | undefined; threw: boolean }> {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  // @ts-expect-error — mock de process.exit só para este teste
  process.exit = (code?: number) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  try {
    await main(argv);
    return { exitCode: undefined, threw: false };
  } catch (e) {
    if (e instanceof Error && e.message === "__exit__") return { exitCode, threw: true };
    throw e;
  } finally {
    process.exit = originalExit;
  }
}

test("main: v1 (cru) × v2 wrapper com adminOptOutsAvailable=true → compara normalmente, sem bloquear", async () => {
  const v2Artifact: CohortsV2Artifact = {
    cohorts: makeCohorts(),
    diagnostics: {
      campaignsTotal: 5,
      campaignsFromCache: 5,
      campaignsFetched: 0,
      campaignsFailedCount: 0,
      adminOptOutsAvailable: true,
      adminOptOutsApplied: 3,
    },
  };
  await withTmpFiles({ "v1.json": makeCohorts(), "v2.json": v2Artifact }, async (paths) => {
    const { exitCode, threw } = await runMainCapturingExit(["--a", paths["v1.json"], "--b", paths["v2.json"]]);
    assert.equal(threw, false); // coortes idênticas → allWithinTolerance → não chama process.exit
    assert.equal(exitCode, undefined);
  });
});

test("main: v2 wrapper com adminOptOutsAvailable=false → BLOQUEIA (exit 1) antes do diff, sem --allow-degraded", async () => {
  const v2Artifact: CohortsV2Artifact = {
    cohorts: makeCohorts(),
    diagnostics: {
      campaignsTotal: 5,
      campaignsFromCache: 5,
      campaignsFetched: 0,
      campaignsFailedCount: 0,
      adminOptOutsAvailable: false,
      adminOptOutsApplied: 0,
      adminOptOutsUnavailableReason: "store não encontrado",
    },
  };
  await withTmpFiles({ "v1.json": makeCohorts(), "v2.json": v2Artifact }, async (paths) => {
    const { exitCode, threw } = await runMainCapturingExit(["--a", paths["v1.json"], "--b", paths["v2.json"]]);
    assert.equal(threw, true);
    assert.equal(exitCode, 1);
  });
});

test("main: v2 wrapper degradado + --allow-degraded → NÃO bloqueia, segue pro diff normal", async () => {
  const v2Artifact: CohortsV2Artifact = {
    cohorts: makeCohorts(),
    diagnostics: {
      campaignsTotal: 5,
      campaignsFromCache: 5,
      campaignsFetched: 0,
      campaignsFailedCount: 0,
      adminOptOutsAvailable: false,
      adminOptOutsApplied: 0,
      adminOptOutsUnavailableReason: "store não encontrado",
    },
  };
  await withTmpFiles({ "v1.json": makeCohorts(), "v2.json": v2Artifact }, async (paths) => {
    const { exitCode, threw } = await runMainCapturingExit([
      "--a",
      paths["v1.json"],
      "--b",
      paths["v2.json"],
      "--allow-degraded",
    ]);
    // coortes idênticas (só diagnostics degradado) → allWithinTolerance → não chama process.exit
    assert.equal(threw, false);
    assert.equal(exitCode, undefined);
  });
});

test("main: v1 × v2-antigo (sem wrapper, EngagementCohorts cru dos 2 lados) → sem diagnostics, nunca bloqueia por sinal degradado", async () => {
  await withTmpFiles({ "v1.json": makeCohorts(), "v2.json": makeCohorts() }, async (paths) => {
    const { exitCode, threw } = await runMainCapturingExit(["--a", paths["v1.json"], "--b", paths["v2.json"]]);
    assert.equal(threw, false);
    assert.equal(exitCode, undefined);
  });
});
