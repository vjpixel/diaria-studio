/**
 * validate-feeds-should-fail.test.ts (#8110)
 *
 * Anti-regressão pro limiar de "maioria dos feeds falhou" em
 * scripts/validate-feeds.ts — flakiness externa pontual (alguns publishers
 * fora do ar) não deve derrubar o workflow agendado, só problema sistêmico
 * (maioria quebrada) deve.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldFail } from "../scripts/validate-feeds.ts";

describe("validate-feeds shouldFail (#8110)", () => {
  it("minoria falhando (flakiness pontual) NÃO falha o job", () => {
    assert.equal(shouldFail(5, 28), false, "5/28 falhando é o caso real observado — não deve derrubar o workflow");
    assert.equal(shouldFail(1, 30), false);
  });

  it("exatamente metade NÃO falha (limiar é estritamente > metade)", () => {
    assert.equal(shouldFail(15, 30), false);
  });

  it("maioria falhando FALHA o job (sinal de problema sistêmico)", () => {
    assert.equal(shouldFail(16, 30), true);
    assert.equal(shouldFail(30, 30), true, "todos falhando (ex: sem rede) deve falhar");
  });

  it("zero feeds configurados não é chamado (main() retorna cedo), mas a função não quebra", () => {
    assert.equal(shouldFail(0, 0), false);
  });
});
