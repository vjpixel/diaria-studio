/**
 * test/monthly-preview-cloudflare.test.ts (#1914, #1962)
 *
 * Cobre a derivação da key da URL do preview mensal.
 *
 * #1914: key original `m{YYMM}` (não colide com diárias AAMMDD).
 * #1962: key nova `m{YYMM}-{MM}` para ciclos {conteúdo}-{envio}.
 *        Compat: YYMM legado ainda devolve `m{YYMM}` (retrocompat de leitura).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { monthlyPreviewKey } from "../scripts/monthly-preview-cloudflare.ts";

describe("monthlyPreviewKey (#1914, #1962)", () => {
  it("ciclo novo: m{YYMM}-{MM} (ex: m2605-06) — formato preferido #1962", () => {
    assert.equal(monthlyPreviewKey("2605-06"), "m2605-06");
    assert.equal(monthlyPreviewKey("2604-05"), "m2604-05");
    assert.equal(monthlyPreviewKey("2612-01"), "m2612-01");
  });

  it("YYMM legado: m{YYMM} (retrocompat de leitura)", () => {
    assert.equal(monthlyPreviewKey("2605"), "m2605");
    assert.equal(monthlyPreviewKey("2604"), "m2604");
  });

  it("key nova não colide com diária (AAMMDD sem prefixo m)", () => {
    assert.notEqual(monthlyPreviewKey("2605-06"), "260501");
    assert.match(monthlyPreviewKey("2605-06"), /^m\d{4}-\d{2}$/);
  });

  it("key nova não colide com key legada", () => {
    // m2605-06 ≠ m2605 (key legada)
    assert.notEqual(monthlyPreviewKey("2605-06"), monthlyPreviewKey("2605"));
  });

  it("YYMM legado mantém formato m{YYMM} (não deriva m{YYMM}-{MM})", () => {
    // Por design: compat de leitura. Worker tenta nova key, fallback legada.
    assert.match(monthlyPreviewKey("2605"), /^m\d{4}$/);
  });
});
