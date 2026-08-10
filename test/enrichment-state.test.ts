/**
 * test/enrichment-state.test.ts (#4836 item 3)
 *
 * `resolveEnrichmentState` é a única fonte de verdade de como o campo
 * persistido `stats.enrichment_state` (ou a ausência dele, em cache legado)
 * vira um dos 3 estados: `never_enriched` | `enriched_zero` | `enriched_n`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveEnrichmentState } from "../scripts/lib/shared/enrichment-state.ts";

describe("resolveEnrichmentState — cache legado (sem campo persistido)", () => {
  it("sem campo + array vazio → never_enriched (conservador, não inventa zero confirmado)", () => {
    assert.equal(resolveEnrichmentState(undefined, 0), "never_enriched");
    assert.equal(resolveEnrichmentState(null, 0), "never_enriched");
  });

  it("sem campo + array não-vazio → enriched_n (o array não mente, mesmo sem o rótulo)", () => {
    assert.equal(resolveEnrichmentState(undefined, 5), "enriched_n");
  });
});

describe("resolveEnrichmentState — campo persistido válido e consistente", () => {
  it("never_enriched + array vazio → mantém never_enriched", () => {
    assert.equal(resolveEnrichmentState("never_enriched", 0), "never_enriched");
  });

  it("enriched_zero + array vazio → mantém enriched_zero", () => {
    assert.equal(resolveEnrichmentState("enriched_zero", 0), "enriched_zero");
  });

  it("enriched_n + array não-vazio → mantém enriched_n", () => {
    assert.equal(resolveEnrichmentState("enriched_n", 3), "enriched_n");
  });
});

describe("resolveEnrichmentState — campo persistido CONTRADIZ o array real (#4836)", () => {
  it("enriched_n rotulado mas array vazio → cai pra never_enriched (não pode ter N>0 sem linhas)", () => {
    assert.equal(resolveEnrichmentState("enriched_n", 0), "never_enriched");
  });

  it("never_enriched rotulado mas array não-vazio → sobe pra enriched_n (o dado real vence)", () => {
    assert.equal(resolveEnrichmentState("never_enriched", 4), "enriched_n");
  });

  it("enriched_zero rotulado mas array não-vazio → sobe pra enriched_n", () => {
    assert.equal(resolveEnrichmentState("enriched_zero", 7), "enriched_n");
  });
});

describe("resolveEnrichmentState — valor persistido inválido", () => {
  it("string desconhecida → cai no fallback derivado do array, igual a campo ausente", () => {
    assert.equal(resolveEnrichmentState("bogus_state", 0), "never_enriched");
    assert.equal(resolveEnrichmentState("bogus_state", 2), "enriched_n");
  });

  it("tipo não-string (número, objeto) → cai no fallback derivado do array", () => {
    assert.equal(resolveEnrichmentState(42, 0), "never_enriched");
    assert.equal(resolveEnrichmentState({}, 1), "enriched_n");
  });
});
