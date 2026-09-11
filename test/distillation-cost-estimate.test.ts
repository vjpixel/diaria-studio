/**
 * test/distillation-cost-estimate.test.ts (#7981)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateDistillationCost, SONNET_INPUT_USD_PER_MTOK, SONNET_OUTPUT_USD_PER_MTOK } from "../scripts/lib/distillation-cost-estimate.ts";

describe("estimateDistillationCost (#7981)", () => {
  it("multiplica por votes (default 3)", () => {
    const est = estimateDistillationCost(1000, 200);
    assert.equal(est.votes, 3);
    assert.equal(est.estimated_input_tokens_total, 3000);
    assert.equal(est.estimated_output_tokens_total, 600);
  });

  it("calcula USD a partir do preço documentado", () => {
    const est = estimateDistillationCost(1_000_000, 1_000_000, 1);
    assert.equal(est.estimated_usd, SONNET_INPUT_USD_PER_MTOK + SONNET_OUTPUT_USD_PER_MTOK);
  });

  it("lança em entrada negativa ou votes < 1", () => {
    assert.throws(() => estimateDistillationCost(-1, 100));
    assert.throws(() => estimateDistillationCost(100, -1));
    assert.throws(() => estimateDistillationCost(100, 100, 0));
  });

  it("votes customizado", () => {
    const est = estimateDistillationCost(100, 50, 5);
    assert.equal(est.estimated_input_tokens_total, 500);
    assert.equal(est.estimated_output_tokens_total, 250);
  });
});
