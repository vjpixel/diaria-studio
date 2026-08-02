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
import { diffCohorts, allWithinTolerance, formatCohortsDiff } from "../scripts/compare-cohorts.ts";
import type { EngagementCohorts } from "../scripts/lib/dashboard-kv-types.ts";

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
  const rows = diffCohorts(a, b);
  assert.equal(rows.length, 9);
  for (const r of rows) {
    assert.equal(r.absDiff, 0);
    assert.equal(r.withinTolerance, true);
  }
  assert.equal(allWithinTolerance(rows), true);
});

test("diffCohorts: diferença pequena (dentro de 2%) ainda passa", () => {
  const a = makeCohorts({ universe: 1000 });
  const b = makeCohorts({ universe: 1015 }); // 1.5% de diferença
  const rows = diffCohorts(a, b, 0.02);
  const universeRow = rows.find((r) => r.field === "universe")!;
  assert.equal(universeRow.absDiff, 15);
  assert.equal(universeRow.withinTolerance, true);
  assert.equal(allWithinTolerance(rows), true);
});

test("diffCohorts: diferença grande (fora de 2%) falha só naquele campo", () => {
  const a = makeCohorts({ universe: 1000, opened1: 200 });
  const b = makeCohorts({ universe: 1200, opened1: 200 }); // 20% de diferença em universe
  const rows = diffCohorts(a, b, 0.02);
  const universeRow = rows.find((r) => r.field === "universe")!;
  const opened1Row = rows.find((r) => r.field === "opened1")!;
  assert.equal(universeRow.withinTolerance, false);
  assert.equal(opened1Row.withinTolerance, true);
  assert.equal(allWithinTolerance(rows), false);
});

test("diffCohorts: tolerância mínima é 1 unidade (campo pequeno não exige bater exato)", () => {
  const a = makeCohorts({ exitsBreakdown: { bounced: 1, optedOut: 30 } });
  const b = makeCohorts({ exitsBreakdown: { bounced: 2, optedOut: 30 } });
  const rows = diffCohorts(a, b, 0.02); // 2% de 1 arredonda pra 0, mas o piso é 1
  const bouncedRow = rows.find((r) => r.field === "exitsBreakdown.bounced")!;
  assert.equal(bouncedRow.tolerance, 1);
  assert.equal(bouncedRow.withinTolerance, true);
});

test("diffCohorts: cobre os 9 campos documentados (inclusive exitsBreakdown.* e maxReceived)", () => {
  const rows = diffCohorts(makeCohorts(), makeCohorts());
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
  const rows = diffCohorts(makeCohorts(), makeCohorts({ universe: 1200 }));
  const out = formatCohortsDiff(rows);
  const lines = out.split("\n");
  assert.equal(lines.length, 1 + rows.length);
  assert.ok(out.includes("universe"));
  assert.ok(out.includes("❌ FORA DA TOLERÂNCIA")); // universe diverge
  assert.ok(out.includes("✅ OK")); // os outros 8 campos batem
});
