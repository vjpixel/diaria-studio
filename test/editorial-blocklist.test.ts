/**
 * editorial-blocklist.test.ts (#1760)
 *
 * Blacklist editorial de fontes — domínios que o editor decidiu não incluir.
 * Regressão: artigo de simonwillison.net é bloqueado (host exato + subdomínio),
 * outras fontes passam.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isEditoriallyBlocked,
  EDITORIAL_BLOCKLIST,
} from "../scripts/lib/editorial-blocklist.ts";

describe("isEditoriallyBlocked (#1760)", () => {
  it("bloqueia simonwillison.net (host exato)", () => {
    assert.equal(isEditoriallyBlocked("https://simonwillison.net/2026/Jun/1/pasted-file-editor/"), true);
  });

  it("bloqueia www.simonwillison.net", () => {
    assert.equal(isEditoriallyBlocked("https://www.simonwillison.net/x"), true);
  });

  it("bloqueia subdomínio (blog.simonwillison.net)", () => {
    assert.equal(isEditoriallyBlocked("https://blog.simonwillison.net/post"), true);
  });

  it("NÃO bloqueia outras fontes", () => {
    assert.equal(isEditoriallyBlocked("https://openai.com/index/x"), false);
    assert.equal(isEditoriallyBlocked("https://cookbook.openai.com/y"), false);
  });

  it("NÃO bloqueia domínio que apenas contém a string (não-subdomínio)", () => {
    // notsimonwillison.net e simonwillison.net.evil.com não devem casar
    assert.equal(isEditoriallyBlocked("https://notsimonwillison.net/x"), false);
    assert.equal(isEditoriallyBlocked("https://simonwillison.net.evil.com/x"), false);
  });

  it("URL inválida → false (defensivo)", () => {
    assert.equal(isEditoriallyBlocked("not a url"), false);
    assert.equal(isEditoriallyBlocked(""), false);
  });

  it("a lista contém simonwillison.net (#1760)", () => {
    assert.ok(EDITORIAL_BLOCKLIST.has("simonwillison.net"));
  });
});
