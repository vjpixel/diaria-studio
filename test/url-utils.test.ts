/**
 * url-utils.test.ts
 *
 * Tests for scripts/lib/url-utils.ts (#523)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, extractHost, urlsMatch } from "../scripts/lib/url-utils.ts";

describe("canonicalize", () => {
  it("remove utm_* tracking params", () => {
    assert.equal(
      canonicalize("https://example.com/article?utm_source=twitter&utm_medium=social&id=42"),
      "https://example.com/article?id=42",
    );
  });

  it("remove ref e ref_src tracking params", () => {
    assert.equal(
      canonicalize("https://example.com/article?ref=newsletter&ref_src=twsrc"),
      "https://example.com/article",
    );
  });

  it("preserva outros query params", () => {
    assert.equal(
      canonicalize("https://example.com/article?id=1&tag=ai"),
      "https://example.com/article?id=1&tag=ai",
    );
  });

  it("remove hash fragment", () => {
    assert.equal(
      canonicalize("https://example.com/article#section-1"),
      "https://example.com/article",
    );
  });

  it("remove hash e tracking params juntos", () => {
    assert.equal(
      canonicalize("https://example.com/article?utm_campaign=x#top"),
      "https://example.com/article",
    );
  });

  it("remove trailing slash no pathname (nao root)", () => {
    assert.equal(
      canonicalize("https://example.com/article/"),
      "https://example.com/article",
    );
  });

  it("preserva trailing slash em root", () => {
    assert.equal(
      canonicalize("https://example.com/"),
      "https://example.com/",
    );
  });

  it("normaliza arxiv /pdf/ para /abs/", () => {
    assert.equal(
      canonicalize("https://arxiv.org/pdf/2401.12345.pdf"),
      "https://arxiv.org/abs/2401.12345",
    );
  });

  it("lowercasa scheme e hostname", () => {
    assert.equal(
      canonicalize("HTTPS://EXAMPLE.COM/Article"),
      "https://example.com/Article",
    );
  });

  it("retorna URL original se invalida (sem lancar excecao)", () => {
    assert.equal(canonicalize("not a url"), "not a url");
    assert.equal(canonicalize(""), "");
  });
});

describe("extractHost", () => {
  it("retorna hostname sem www", () => {
    assert.equal(extractHost("https://www.example.com/path"), "example.com");
  });

  it("retorna hostname sem www para subdomain diferente", () => {
    assert.equal(extractHost("https://blog.example.com/post"), "blog.example.com");
  });

  it("retorna hostname simples sem www", () => {
    assert.equal(extractHost("https://example.com/path"), "example.com");
  });

  it("retorna null para URL invalida", () => {
    assert.equal(extractHost("not a url"), null);
    assert.equal(extractHost(""), null);
  });
});

describe("urlsMatch", () => {
  it("URLs identicas fazem match", () => {
    assert.ok(urlsMatch("https://example.com/article", "https://example.com/article"));
  });

  it("URLs com tracking params diferentes fazem match", () => {
    assert.ok(urlsMatch(
      "https://example.com/article?utm_source=twitter",
      "https://example.com/article?utm_medium=social",
    ));
  });

  it("URL com tracking vs sem tracking fazem match", () => {
    assert.ok(urlsMatch(
      "https://example.com/article?utm_source=newsletter&ref=abc",
      "https://example.com/article",
    ));
  });

  it("URL com trailing slash faz match com sem trailing slash", () => {
    assert.ok(urlsMatch(
      "https://example.com/article/",
      "https://example.com/article",
    ));
  });

  it("URLs com hash diferente fazem match", () => {
    assert.ok(urlsMatch(
      "https://example.com/article#intro",
      "https://example.com/article#conclusion",
    ));
  });

  it("URLs de dominios diferentes nao fazem match", () => {
    assert.ok(!urlsMatch("https://example.com/article", "https://other.com/article"));
  });

  it("URLs com paths diferentes nao fazem match", () => {
    assert.ok(!urlsMatch("https://example.com/a", "https://example.com/b"));
  });
});

import { stripUrlTrailingPunct, extractUrls as extractUrlsFromText, URL_REGEX_RAW } from "../scripts/lib/url-utils.ts";

describe("stripUrlTrailingPunct (#626)", () => {
  it("preserva ')' em URL Wikipedia balanceada", () => {
    assert.equal(
      stripUrlTrailingPunct("https://en.wikipedia.org/wiki/Foo_(bar)"),
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
  });

  it("preserva multiple parens balanceados", () => {
    assert.equal(
      stripUrlTrailingPunct("https://x.com/a(b)c(d)"),
      "https://x.com/a(b)c(d)",
    );
  });

  it("strip ')' não-balanceado vindo de prose", () => {
    assert.equal(
      stripUrlTrailingPunct("https://x.com/y)"),
      "https://x.com/y",
    );
  });

  it("strip ponto final sentence", () => {
    assert.equal(
      stripUrlTrailingPunct("https://x.com/y."),
      "https://x.com/y",
    );
  });

  it("strip vírgula + ponto", () => {
    assert.equal(
      stripUrlTrailingPunct("https://x.com/y,."),
      "https://x.com/y",
    );
  });

  it("preserva ')' balanceado mesmo com prose punctuation atrás", () => {
    assert.equal(
      stripUrlTrailingPunct("https://en.wikipedia.org/wiki/H%C3%A4feli_DH-5_(military),"),
      "https://en.wikipedia.org/wiki/H%C3%A4feli_DH-5_(military)",
    );
  });

  it("URL sem pontuação fica inalterada", () => {
    assert.equal(
      stripUrlTrailingPunct("https://x.com/y"),
      "https://x.com/y",
    );
  });
});

describe("extractUrls (#626)", () => {
  it("extrai múltiplas URLs preservando parens balanceados", () => {
    const text = "Veja https://en.wikipedia.org/wiki/Foo_(bar) e https://x.com/y.";
    assert.deepEqual(
      extractUrlsFromText(text),
      ["https://en.wikipedia.org/wiki/Foo_(bar)", "https://x.com/y"],
    );
  });

  it("descarta URLs muito curtas (< 11 chars)", () => {
    assert.deepEqual(
      extractUrlsFromText("http://x"),
      [],
    );
  });
});
