/**
 * test/meta-capi-fbc-from-cookie-10230.test.ts (#10230)
 *
 * Cadastro por anúncio Meta que assina em página SEM fbclid na URL: o
 * `click_id` do form vem vazio, mas o `_fbc` do cookie preserva o clique.
 * `deriveClickIdFromFbc` o converte pra `fbclid:XXXX`, que o
 * `SubscriptionConfirmed` já sabe transformar de volta em fbc.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFbcFromClickId, deriveClickIdFromFbc } from "../scripts/lib/shared/meta-capi.ts";

describe("deriveClickIdFromFbc (#10230)", () => {
  it("_fbc canônico vira click_id fbclid:", () => {
    assert.equal(deriveClickIdFromFbc("fb.1.1700000000000.AbC-123_x"), "fbclid:AbC-123_x");
  });

  it("fbclid com ponto é preservado inteiro", () => {
    assert.equal(deriveClickIdFromFbc("fb.1.1700000000000.AbC.def"), "fbclid:AbC.def");
  });

  it("ida e volta com buildFbcFromClickId", () => {
    const clickId = deriveClickIdFromFbc("fb.1.1700000000000.IwAR0xyz");
    assert.equal(buildFbcFromClickId(clickId, 1700000000000), "fb.1.1700000000000.IwAR0xyz");
  });

  it("ausente, vazio ou fora da forma canônica devolve undefined", () => {
    assert.equal(deriveClickIdFromFbc(undefined), undefined);
    assert.equal(deriveClickIdFromFbc(""), undefined);
    assert.equal(deriveClickIdFromFbc("lixo"), undefined);
    assert.equal(deriveClickIdFromFbc("fb.1.abc.xyz"), undefined);
    assert.equal(deriveClickIdFromFbc("fb.1.1700000000000.<script>"), undefined);
  });
});
