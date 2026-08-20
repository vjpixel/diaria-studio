/**
 * test/brevo-diaria-max-add-5772.test.ts (#5772)
 *
 * Cobre `scripts/lib/brevo-diaria-max-add.ts` — a fórmula determinística de
 * `--max-add N` do dispatch automático do canal Brevo diária na Etapa 5
 * (N = max(0, targetTotal - totalAtual)).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeStage5MaxAdd, resolveStage5MaxAdd } from "../scripts/lib/brevo-diaria-max-add.ts";

describe("computeStage5MaxAdd (#5772)", () => {
  it("totalAtual abaixo do teto → completa exatamente até o teto", () => {
    assert.equal(computeStage5MaxAdd(100, 290), 190);
  });

  it("totalAtual no teto → 0", () => {
    assert.equal(computeStage5MaxAdd(290, 290), 0);
  });

  it("totalAtual acima do teto → 0 (nunca negativo)", () => {
    assert.equal(computeStage5MaxAdd(310, 290), 0);
  });

  it("totalAtual zero → N = targetTotal", () => {
    assert.equal(computeStage5MaxAdd(0, 290), 290);
  });
});

describe("resolveStage5MaxAdd (#5772)", () => {
  it("store ausente → skip com motivo, nunca assume 0 nem o teto cheio", () => {
    const r = resolveStage5MaxAdd({ storeExists: false, currentActiveCount: 0, targetTotal: 290 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /store ausente/);
  });

  it("targetTotal ausente (undefined) → skip com motivo", () => {
    const r = resolveStage5MaxAdd({ storeExists: true, currentActiveCount: 100, targetTotal: undefined });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /stage5_target_total/);
  });

  it("targetTotal null → skip com motivo", () => {
    const r = resolveStage5MaxAdd({ storeExists: true, currentActiveCount: 100, targetTotal: null });
    assert.equal(r.ok, false);
  });

  it("targetTotal negativo → skip com motivo", () => {
    const r = resolveStage5MaxAdd({ storeExists: true, currentActiveCount: 100, targetTotal: -1 });
    assert.equal(r.ok, false);
  });

  it("inputs válidos → maxAdd calculado, totalAtual/targetTotal ecoados", () => {
    const r = resolveStage5MaxAdd({ storeExists: true, currentActiveCount: 150, targetTotal: 290 });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.totalAtual, 150);
      assert.equal(r.targetTotal, 290);
      assert.equal(r.maxAdd, 140);
    }
  });

  it("total_atual acima do teto → maxAdd 0, resultado ainda ok (#5772 comentário do editor)", () => {
    const r = resolveStage5MaxAdd({ storeExists: true, currentActiveCount: 300, targetTotal: 290 });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.maxAdd, 0);
  });
});
