/**
 * test/amazon-affiliate.test.ts (#8059)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DIARIA_AMAZON_TAG,
  CLARICE_AMAZON_TAG,
  PRIMARY_AMAZON_TAG,
  isAmazonProductUrl,
  isAmazonShortenerUrl,
  isAmazonStorefrontUrl,
  rewriteAmazonAffiliateTag,
  rewriteAmazonAffiliateTagsInText,
  findAmazonAffiliateTagIssues,
} from "../scripts/lib/amazon-affiliate.ts";

describe("isAmazonProductUrl / isAmazonShortenerUrl / isAmazonStorefrontUrl", () => {
  it("reconhece amazon.com.br e amazon.com como produto", () => {
    assert.equal(isAmazonProductUrl("https://www.amazon.com.br/dp/B0DGZ46G88?tag=diaria-20"), true);
    assert.equal(isAmazonProductUrl("https://amazon.com/dp/B0DGZ46G88"), true);
  });

  it("não confunde outros domínios com Amazon", () => {
    assert.equal(isAmazonProductUrl("https://example.com/dp/B0DGZ46G88"), false);
    assert.equal(isAmazonProductUrl("not a url"), false);
  });

  it("reconhece encurtadores (amzn.to/link.amazon/amzlinks.in)", () => {
    assert.equal(isAmazonShortenerUrl("https://amzn.to/4qDeYvz"), true);
    assert.equal(isAmazonShortenerUrl("https://link.amazon.com.br/xyz"), false); // host real é link.amazon, não link.amazon.com.br
    assert.equal(isAmazonShortenerUrl("https://link.amazon/xyz"), true);
    assert.equal(isAmazonShortenerUrl("https://www.amzlinks.in/abc"), true);
    assert.equal(isAmazonShortenerUrl("https://www.amazon.com.br/dp/B0DGZ46G88"), false);
  });

  it("reconhece a vitrine /shop/vjpixel", () => {
    assert.equal(isAmazonStorefrontUrl("https://www.amazon.com.br/shop/vjpixel"), true);
    assert.equal(isAmazonStorefrontUrl("https://www.amazon.com.br/shop/vjpixel?ref=x"), true);
    assert.equal(isAmazonStorefrontUrl("https://www.amazon.com.br/shop/vjpixel/lista"), true);
    assert.equal(isAmazonStorefrontUrl("https://www.amazon.com.br/dp/B0DGZ46G88"), false);
  });

  it("NÃO confunde /shop/vjpixel-outra-coisa (prefixo de string, não segmento de path) com a vitrine", () => {
    assert.equal(isAmazonStorefrontUrl("https://www.amazon.com.br/shop/vjpixel-outra-coisa"), false);
  });
});

describe("rewriteAmazonAffiliateTag", () => {
  it("define tag=diaria-20 num link de produto sem tag", () => {
    const out = rewriteAmazonAffiliateTag("https://www.amazon.com.br/dp/B0DGZ46G88", "diaria");
    const u = new URL(out);
    assert.equal(u.searchParams.get("tag"), DIARIA_AMAZON_TAG);
  });

  it("SOBRESCREVE tag existente de outra audiência", () => {
    const out = rewriteAmazonAffiliateTag("https://www.amazon.com.br/dp/B0DGZ46G88?tag=diaria-20", "clarice");
    const u = new URL(out);
    assert.equal(u.searchParams.get("tag"), CLARICE_AMAZON_TAG);
  });

  it("NÃO reescreve encurtador amzn.to (não verificável/reescrevível)", () => {
    const url = "https://amzn.to/4qDeYvz";
    assert.equal(rewriteAmazonAffiliateTag(url, "clarice"), url);
  });

  it("NÃO reescreve a vitrine /shop/vjpixel — exceção documentada", () => {
    const url = "https://www.amazon.com.br/shop/vjpixel?tag=vjpixel-20";
    assert.equal(rewriteAmazonAffiliateTag(url, "clarice"), url);
  });

  it("URL não-Amazon é NO-OP", () => {
    const url = "https://example.com/x";
    assert.equal(rewriteAmazonAffiliateTag(url, "diaria"), url);
  });
});

describe("rewriteAmazonAffiliateTagsInText", () => {
  it("reescreve todo link de produto Amazon num texto/HTML pra tag da audiência de destino", () => {
    const html =
      `<a href="https://www.amazon.com.br/dp/B0DGZ46G88?tag=${DIARIA_AMAZON_TAG}">livro</a> ` +
      `e <a href="https://www.amazon.com.br/dp/8550818380">outro</a>.`;
    const out = rewriteAmazonAffiliateTagsInText(html, "clarice");
    assert.match(out, new RegExp(`dp/B0DGZ46G88\\?tag=${CLARICE_AMAZON_TAG}`));
    assert.match(out, new RegExp(`dp/8550818380\\?tag=${CLARICE_AMAZON_TAG}`));
  });

  it("é idempotente — rodar 2x com a mesma audiência não muda o resultado", () => {
    const html = `https://www.amazon.com.br/dp/B0DGZ46G88?tag=${DIARIA_AMAZON_TAG}`;
    const once = rewriteAmazonAffiliateTagsInText(html, "clarice");
    const twice = rewriteAmazonAffiliateTagsInText(once, "clarice");
    assert.equal(once, twice);
  });

  it("preserva pontuação de fim de frase fora da URL", () => {
    const html = `Veja: https://www.amazon.com.br/dp/B0DGZ46G88.`;
    const out = rewriteAmazonAffiliateTagsInText(html, "diaria");
    assert.equal(out.endsWith("."), true);
    assert.match(out, new RegExp(`tag=${DIARIA_AMAZON_TAG}\\.$`));
  });

  it("não toca encurtador nem vitrine dentro do texto", () => {
    const html =
      `https://amzn.to/4qDeYvz e https://www.amazon.com.br/shop/vjpixel?tag=${PRIMARY_AMAZON_TAG}`;
    const out = rewriteAmazonAffiliateTagsInText(html, "clarice");
    assert.equal(out, html);
  });
});

describe("findAmazonAffiliateTagIssues", () => {
  it("sem issues quando todo link já tem a tag esperada", () => {
    const text = `https://www.amazon.com.br/dp/B0DGZ46G88?tag=${DIARIA_AMAZON_TAG}`;
    assert.deepEqual(findAmazonAffiliateTagIssues(text, "diaria"), []);
  });

  it("missing_tag quando o link de produto não tem tag=", () => {
    const text = "https://www.amazon.com.br/dp/B0DGZ46G88";
    const issues = findAmazonAffiliateTagIssues(text, "diaria");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].issue, "missing_tag");
    assert.equal(issues[0].expected_tag, DIARIA_AMAZON_TAG);
  });

  it("wrong_tag quando a tag é da OUTRA audiência (o caso central da issue)", () => {
    const text = `https://www.amazon.com.br/dp/B0DGZ46G88?tag=${CLARICE_AMAZON_TAG}`;
    const issues = findAmazonAffiliateTagIssues(text, "diaria");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].issue, "wrong_tag");
    assert.equal(issues[0].found_tag, CLARICE_AMAZON_TAG);
    assert.equal(issues[0].expected_tag, DIARIA_AMAZON_TAG);
  });

  it("shortener_untaggable pra amzn.to/link.amazon, independente de audiência", () => {
    const text = "https://amzn.to/4qDeYvz https://link.amazon/xyz";
    const issues = findAmazonAffiliateTagIssues(text, "diaria");
    assert.equal(issues.length, 2);
    assert.deepEqual(issues.map((i) => i.issue), ["shortener_untaggable", "shortener_untaggable"]);
  });

  it("vitrine /shop/vjpixel nunca é issue, mesmo com a tag principal", () => {
    const text = `https://www.amazon.com.br/shop/vjpixel?tag=${PRIMARY_AMAZON_TAG}`;
    assert.deepEqual(findAmazonAffiliateTagIssues(text, "diaria"), []);
    assert.deepEqual(findAmazonAffiliateTagIssues(text, "clarice"), []);
  });

  it("dedup por URL exata", () => {
    const text = "https://amzn.to/4qDeYvz e de novo https://amzn.to/4qDeYvz";
    assert.equal(findAmazonAffiliateTagIssues(text, "diaria").length, 1);
  });
});
