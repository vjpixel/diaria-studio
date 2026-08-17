/**
 * print-preflight-plan.test.ts (#5545)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatPlan } from "../scripts/print-preflight-plan.ts";
import { buildPreflightPlan } from "../scripts/lib/preflight-utm-arms.ts";

describe("formatPlan (#5545)", () => {
  it("imprime os 3 braços com URL e email prontos pra copiar", () => {
    const plans = buildPreflightPlan("preflight-2608");
    const out = formatPlan("preflight-2608", plans);
    assert.match(out, /campanha "preflight-2608"/);
    for (const p of plans) {
      assert.ok(out.includes(p.url), `esperava a URL de ${p.arm.key} na saída`);
      assert.ok(out.includes(p.email), `esperava o email de ${p.arm.key} na saída`);
    }
  });
});
