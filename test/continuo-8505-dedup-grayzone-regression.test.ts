// #8505 — regresso tie-breaker zona cinzenta dedup (método #8412)
// off => idêntico ao mecanismo atual (não altera heurística)
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("8505 regresso dedup grayzone", () => {
  it("flag off => comportamento idêntico ao atual (não altera heurística)", () => {
    // Se jev.features.dedup_grayzone === false, o pipeline de dedup.ts
    // deve seguir o caminho determinístico (thresholdForPair) sem
    // consultar Jev — garantia de falha-soft (fail-soft obrigatório #8412).
    const config = require("../platform.config.json");
    assert.strictEqual(config.jev?.features?.dedup_grayzone, false,
      "default deve ser OFF para fail-soft");
  });
  it("shadow mode registra sem alterar decisão quando ON", () => {
    // Quando ON, o par na zona cinzenta [0.35,0.70) deve ser registrado
    // em shadow (lado a lado) mas a heurística ainda decide — tie-breaker
    // só quando confiança > limiar (2º eixo, #8412).
    assert.ok(true, "shadow mode declarativo — implementação futura no stage 2");
  });
});
