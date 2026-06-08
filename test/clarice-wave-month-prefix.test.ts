/**
 * test/clarice-wave-month-prefix.test.ts
 *
 * Trava o namespacing por mês das waves Clarice/Brevo: sem o prefixo do mês,
 * o T1-W1 deste mês sobrescrevia o do mês passado (nomes eram fixos:
 * t1-openers.csv, t2-w3.csv, …). Agora cada wave é `{YYMM}-{base}`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waveName, currentYYMM } from "../scripts/clarice-build-waves.ts";
import { parseArgs } from "../scripts/clarice-import-waves.ts";

describe("waves Clarice — prefixo de mês (#wave-month-prefix)", () => {
  it("waveName prefixa o mês do envio", () => {
    assert.equal(waveName("2606", "t1-openers.csv"), "2606-t1-openers.csv");
    assert.equal(waveName("2605", "t2-w3.csv"), "2605-t2-w3.csv");
    // Junho não colide com maio:
    assert.notEqual(waveName("2606", "t1-openers.csv"), waveName("2605", "t1-openers.csv"));
  });

  it("currentYYMM retorna YYMM de 4 dígitos", () => {
    assert.equal(currentYYMM(new Date(2026, 5, 8)), "2606"); // junho/2026
    assert.equal(currentYYMM(new Date(2026, 0, 1)), "2601"); // janeiro
    assert.match(currentYYMM(), /^\d{4}$/);
  });

  it("import-waves: --month é obrigatório (parseArgs não inventa default)", () => {
    assert.equal(parseArgs(["--month", "2606"]).month, "2606");
    assert.equal(parseArgs([]).month, ""); // ausente → vazio (main aborta)
    assert.equal(parseArgs(["--month", "lixo"]).month, ""); // inválido → vazio
  });
});
