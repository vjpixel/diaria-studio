/**
 * test/monthly-preview-cloudflare.test.ts (#1914)
 *
 * Cobre a derivação da key da URL do preview mensal — `m{YYMM}`, distinta da
 * diária (AAMMDD), pra não colidir no worker draft.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { monthlyPreviewKey } from "../scripts/monthly-preview-cloudflare.ts";

describe("monthlyPreviewKey (#1914)", () => {
  it("prefixa o mês com m → m{YYMM}", () => {
    assert.equal(monthlyPreviewKey("2605"), "m2605");
    assert.equal(monthlyPreviewKey("2604"), "m2604");
  });
  it("não colide com uma key diária de 6 dígitos (AAMMDD)", () => {
    // Diária usa 6 dígitos; mensal começa com 'm' + 4 dígitos → namespaces
    // distintos no mesmo worker draft.
    assert.notEqual(monthlyPreviewKey("2605"), "260501");
    assert.match(monthlyPreviewKey("2605"), /^m\d{4}$/);
  });
});
