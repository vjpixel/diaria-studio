/**
 * test/validate-amazon-affiliate-tags.test.ts (#8059)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAmazonAffiliateTags } from "../scripts/validate-amazon-affiliate-tags.ts";
import { DIARIA_AMAZON_TAG, CLARICE_AMAZON_TAG } from "../scripts/lib/amazon-affiliate.ts";

describe("validateAmazonAffiliateTags", () => {
  it("ok=true quando todo link Amazon tem a tag esperada", () => {
    const md = `Recomendo [este livro](https://www.amazon.com.br/dp/B0DGZ46G88?tag=${DIARIA_AMAZON_TAG}).`;
    const report = validateAmazonAffiliateTags(md, "diaria");
    assert.equal(report.ok, true);
    assert.equal(report.issues.length, 0);
  });

  it("ok=false quando o link carrega a tag da OUTRA audiência (Clarice num render diária)", () => {
    const md = `[link](https://www.amazon.com.br/dp/B0DGZ46G88?tag=${CLARICE_AMAZON_TAG})`;
    const report = validateAmazonAffiliateTags(md, "diaria");
    assert.equal(report.ok, false);
    assert.equal(report.issues[0].issue, "wrong_tag");
  });

  it("ok=false quando o link não tem tag= nenhuma", () => {
    const md = `[link](https://www.amazon.com.br/dp/B0DGZ46G88)`;
    const report = validateAmazonAffiliateTags(md, "clarice");
    assert.equal(report.ok, false);
    assert.equal(report.issues[0].issue, "missing_tag");
    assert.equal(report.issues[0].expected_tag, CLARICE_AMAZON_TAG);
  });

  it("ok=false quando o link é um encurtador amzn.to", () => {
    const md = `[link](https://amzn.to/4qDeYvz)`;
    const report = validateAmazonAffiliateTags(md, "diaria");
    assert.equal(report.ok, false);
    assert.equal(report.issues[0].issue, "shortener_untaggable");
  });

  it("a vitrine /shop/vjpixel nunca falha, em nenhuma audiência", () => {
    const md = `[loja](https://www.amazon.com.br/shop/vjpixel)`;
    assert.equal(validateAmazonAffiliateTags(md, "diaria").ok, true);
    assert.equal(validateAmazonAffiliateTags(md, "clarice").ok, true);
  });

  it("texto sem nenhum link Amazon → ok", () => {
    assert.equal(validateAmazonAffiliateTags("nada aqui, só https://example.com", "diaria").ok, true);
  });
});
