/**
 * test/studio-utms-medium-breakdown-12116.test.ts (#12116) — cobertura da
 * regra do corte por utm_medium da página /utms (`mediumBreakdownText`,
 * `scripts/studio-ui/public/utms-sort.js`), que até o #12116 vivia sem teste
 * dentro de `utms.js` (que toca `document`). Também trava o alias
 * `normalizeUtmValue` = `normalizeUtmSource`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mediumBreakdownText } from "../scripts/studio-ui/public/utms-sort.js";
import { normalizeUtmSource, normalizeUtmValue } from "../scripts/count-subscriptions-by-utm.ts";

const tpl = (subscribersByMedium: unknown) => ({ medium: "{medium}", subscribersByMedium });

describe("mediumBreakdownText (#12116)", () => {
  it("lista os mediums em ordem decrescente e 'sem medium' no fim", () => {
    assert.equal(
      mediumBreakdownText(tpl({ rodape: 1, __none__: 2, topo: 4 })),
      "topo 4 · rodape 1 · sem medium 2",
    );
  });

  it("omite 'sem medium' quando __none__ é 0 ou ausente", () => {
    assert.equal(mediumBreakdownText(tpl({ topo: 3, rodape: 1, __none__: 0 })), "topo 3 · rodape 1");
    assert.equal(mediumBreakdownText(tpl({ topo: 3, rodape: 1 })), "topo 3 · rodape 1");
  });

  it("esconde com menos de 2 mediums nomeados (__none__ não conta)", () => {
    assert.equal(mediumBreakdownText(tpl({ topo: 5 })), "");
    assert.equal(mediumBreakdownText(tpl({ topo: 5, __none__: 9 })), "");
    assert.equal(mediumBreakdownText(tpl({})), "");
  });

  it("só aparece em emissor com medium template", () => {
    assert.equal(
      mediumBreakdownText({ medium: "email", subscribersByMedium: { topo: 4, rodape: 1 } }),
      "",
    );
  });

  it("subscribersByMedium null/ausente (fetch falhou) não mostra nada", () => {
    assert.equal(mediumBreakdownText(tpl(null)), "");
    assert.equal(mediumBreakdownText({ medium: "{medium}" }), "");
  });

  it("devolve texto cru: o escape é do chamador (utms.js)", () => {
    assert.equal(mediumBreakdownText(tpl({ "<b>": 2, a: 1 })), "<b> 2 · a 1");
  });
});

describe("normalizeUtmValue (#12116)", () => {
  it("é o mesmo normalizador de normalizeUtmSource", () => {
    assert.equal(normalizeUtmSource, normalizeUtmValue);
    assert.equal(normalizeUtmValue("  TOPO "), "topo");
    assert.equal(normalizeUtmValue(""), "__none__");
    assert.equal(normalizeUtmValue(null), "__none__");
  });
});
