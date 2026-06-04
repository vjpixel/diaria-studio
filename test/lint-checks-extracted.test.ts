/**
 * test/lint-checks-extracted.test.ts (#1737 item 2)
 *
 * Guarda a extração dos checks de lint-newsletter-md.ts pra módulos por-check
 * em scripts/lib/lint-checks/. Garante que (a) os módulos são auto-contidos e
 * importáveis direto, e (b) o re-export de back-compat de lint-newsletter-md.ts
 * aponta pra MESMA função (não uma cópia divergente).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  lintMultilineLinks as mlDirect,
} from "../scripts/lib/lint-checks/multiline-links.ts";
import {
  lintRelativeTime as rtDirect,
} from "../scripts/lib/lint-checks/relative-time.ts";
import {
  lintMultilineLinks as mlReexport,
  lintRelativeTime as rtReexport,
} from "../scripts/lint-newsletter-md.ts";

describe("lint-checks extraídos (#1737 item 2)", () => {
  it("re-export de lint-newsletter-md é a MESMA função do módulo", () => {
    assert.strictEqual(mlReexport, mlDirect);
    assert.strictEqual(rtReexport, rtDirect);
  });

  it("multiline-links: módulo auto-contido funciona standalone", () => {
    const broken = "[Label](\nhttps://example.com\n)";
    assert.equal(mlDirect(broken).ok, false);
    assert.equal(mlDirect("[Label](https://example.com)").ok, true);
  });

  it("relative-time: módulo auto-contido funciona standalone", () => {
    const r = rtDirect("A OpenAI lançou ontem o modelo.");
    assert.equal(r.ok, false);
    assert.equal(r.matches[0].word.toLowerCase(), "ontem");
    assert.equal(rtDirect("A OpenAI lançou em 1º de junho.").ok, true);
  });
});
