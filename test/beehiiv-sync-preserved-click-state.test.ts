/**
 * test/beehiiv-sync-preserved-click-state.test.ts (#4836 item 3)
 *
 * `resolvePreservedClickState` decide o que `syncBeehiiv()` carrega adiante
 * pra `stats.clicks`/`stats.enrichment_state` ao re-buscar o detalhe de um
 * post — extraída pra ser testável sem mockar `fetch`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePreservedClickState } from "../scripts/beehiiv-sync.ts";

describe("resolvePreservedClickState", () => {
  it("sem cache anterior (post novo) → clicks vazio, never_enriched", () => {
    const got = resolvePreservedClickState(undefined);
    assert.deepEqual(got, { clicks: [], enrichment_state: "never_enriched" });
  });

  it("cache anterior legado (sem stats.enrichment_state) + clicks vazio → never_enriched", () => {
    const raw = JSON.stringify({ stats: { clicks: [] } });
    const got = resolvePreservedClickState(raw);
    assert.deepEqual(got, { clicks: [], enrichment_state: "never_enriched" });
  });

  it("cache anterior legado + clicks não-vazio → enriched_n (dado real preservado, rótulo derivado)", () => {
    const raw = JSON.stringify({ stats: { clicks: [{ url: "https://a.com/" }] } });
    const got = resolvePreservedClickState(raw);
    assert.equal(got.clicks.length, 1);
    assert.equal(got.enrichment_state, "enriched_n");
  });

  it("cache anterior com enrichment_state=enriched_zero explícito → carregado adiante intacto", () => {
    const raw = JSON.stringify({ stats: { clicks: [], enrichment_state: "enriched_zero" } });
    const got = resolvePreservedClickState(raw);
    assert.deepEqual(got, { clicks: [], enrichment_state: "enriched_zero" });
  });

  it("cache anterior com enrichment_state=enriched_n e clicks preservados → carregado adiante intacto", () => {
    const raw = JSON.stringify({
      stats: { clicks: [{ url: "https://a.com/" }, { url: "https://b.com/" }], enrichment_state: "enriched_n" },
    });
    const got = resolvePreservedClickState(raw);
    assert.equal(got.clicks.length, 2);
    assert.equal(got.enrichment_state, "enriched_n");
  });

  it("JSON corrompido → trata como sem cache anterior (never_enriched, não lança)", () => {
    const got = resolvePreservedClickState("{ isto não é json válido");
    assert.deepEqual(got, { clicks: [], enrichment_state: "never_enriched" });
  });
});
