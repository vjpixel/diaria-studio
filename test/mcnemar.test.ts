/**
 * test/mcnemar.test.ts (#8413)
 *
 * Cobre `scripts/lib/mcnemar.ts` contra o caso citado no #8211
 * (b=8, c=0 → p=0,008, mencionado na issue original do tie-breaker
 * semântico) e casos degenerados.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mcnemarTest } from "../scripts/lib/mcnemar.ts";

describe("mcnemarTest", () => {
  it("sem discordância (b=c=0) → p=1, chiSquare NaN", () => {
    const r = mcnemarTest({ aCorrectBWrong: 0, aWrongBCorrect: 0 });
    assert.equal(r.pValueChiSquare, 1);
    assert.equal(r.pValueExact, 1);
    assert.ok(Number.isNaN(r.chiSquare));
  });

  it("discordância totalmente unilateral (8 vs 0) — significativo (p < 0.01), reproduz a direção do #8211", () => {
    const r = mcnemarTest({ aCorrectBWrong: 0, aWrongBCorrect: 8 });
    assert.ok(r.pValueExact < 0.01, `esperava p<0.01, veio ${r.pValueExact}`);
    assert.ok(r.pValueChiSquare < 0.05, `esperava p<0.05, veio ${r.pValueChiSquare}`);
  });

  it("discordância balanceada (5 vs 5) — não significativo", () => {
    const r = mcnemarTest({ aCorrectBWrong: 5, aWrongBCorrect: 5 });
    assert.ok(r.pValueExact > 0.5, `esperava p alto, veio ${r.pValueExact}`);
  });

  it("é simétrico em b/c (trocar os papéis não muda o p-valor)", () => {
    const r1 = mcnemarTest({ aCorrectBWrong: 2, aWrongBCorrect: 9 });
    const r2 = mcnemarTest({ aCorrectBWrong: 9, aWrongBCorrect: 2 });
    assert.equal(r1.pValueExact, r2.pValueExact);
    assert.equal(r1.pValueChiSquare, r2.pValueChiSquare);
  });

  it("p-valor exato nunca excede 1", () => {
    const r = mcnemarTest({ aCorrectBWrong: 50, aWrongBCorrect: 50 });
    assert.ok(r.pValueExact <= 1);
  });
});
