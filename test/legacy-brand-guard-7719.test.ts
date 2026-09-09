/**
 * test/legacy-brand-guard-7719.test.ts (#7719)
 *
 * `scripts/lib/shared/legacy-brand-guard.ts` — três estados (ok /
 * legacy-brand-found / cannot-verify), nunca dois. `cannot-verify` é tratado
 * IGUAL a `legacy-brand-found` por `assertNoLegacyBrand`: fonte ausente/vazia
 * nunca passa verde por omissão (#7776 — a classe de defeito é "deixar de
 * olhar", não só "olhar e errar").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertNoLegacyBrand, checkLegacyBrand } from "../scripts/lib/shared/legacy-brand-guard.ts";

describe("checkLegacyBrand (#7719)", () => {
  it("grafia correta 'diar.ia.br' (minúsculo) → ok", () => {
    assert.deepEqual(checkLegacyBrand("diar.ia.br — a marca certa"), { status: "ok" });
  });

  it("texto sem menção à marca → ok", () => {
    assert.deepEqual(checkLegacyBrand("um texto qualquer sem marca nenhuma"), { status: "ok" });
  });

  it("marca legada 'Diar.ia' → legacy-brand-found com o(s) match(es)", () => {
    // Texto exato que saiu ao vivo em retrospectiva.diar.ia.br/2607 (#7719).
    const result = checkLegacyBrand("Diar.ia | Julho 2026 — Agentes saem do controle");
    assert.equal(result.status, "legacy-brand-found");
    if (result.status === "legacy-brand-found") assert.deepEqual(result.matches, ["Diar.ia"]);
  });

  it("null → cannot-verify (nunca 'ok' por omissão)", () => {
    assert.equal(checkLegacyBrand(null).status, "cannot-verify");
  });

  it("undefined → cannot-verify", () => {
    assert.equal(checkLegacyBrand(undefined).status, "cannot-verify");
  });

  it("string vazia/só espaço → cannot-verify", () => {
    assert.equal(checkLegacyBrand("").status, "cannot-verify");
    assert.equal(checkLegacyBrand("   \n  ").status, "cannot-verify");
  });
});

describe("assertNoLegacyBrand — found e cannot-verify tratados IGUAL, nunca passam verde (#7719)", () => {
  it("ok → não lança", () => {
    assert.doesNotThrow(() => assertNoLegacyBrand(checkLegacyBrand("diar.ia.br"), "ctx"));
  });

  it("legacy-brand-found → lança citando a marca legada", () => {
    assert.throws(
      () => assertNoLegacyBrand(checkLegacyBrand("Diar.ia | Julho 2026 — Agentes saem do controle"), "artigo do ciclo 2607-08"),
      /artigo do ciclo 2607-08.*Diar\.ia/s,
    );
  });

  it("cannot-verify (texto ausente) → lança recusando publicar, não deixa passar", () => {
    assert.throws(() => assertNoLegacyBrand(checkLegacyBrand(null), "artigo do ciclo 2607-08"), /não conseguiu verificar/);
  });
});
