import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateCandidates,
  extractFeedsFromHtml,
  shouldSkipHost,
} from "../scripts/discover-rss.ts";

describe("generateCandidates", () => {
  it("gera candidatos a partir de URL com path (tag/categoria)", () => {
    const c = generateCandidates(
      "https://canaltech.com.br/inteligencia-artificial/",
    );
    assert.ok(c.includes("https://canaltech.com.br/inteligencia-artificial/feed"));
    assert.ok(c.includes("https://canaltech.com.br/inteligencia-artificial/feed/"));
    assert.ok(c.includes("https://canaltech.com.br/feed"));
    assert.ok(c.includes("https://canaltech.com.br/feed/"));
  });

  it("gera candidatos a partir de URL apenas com origin", () => {
    const c = generateCandidates("https://example.com/");
    assert.ok(c.includes("https://example.com/feed"));
    assert.ok(c.includes("https://example.com/atom.xml"));
    assert.ok(c.includes("https://example.com/index.xml"));
  });

  it("ordena tag-page candidates antes de origin candidates", () => {
    const c = generateCandidates(
      "https://exame.com/inteligencia-artificial/",
    );
    const tagFeedIdx = c.indexOf("https://exame.com/inteligencia-artificial/feed");
    const originFeedIdx = c.indexOf("https://exame.com/feed");
    assert.ok(tagFeedIdx !== -1);
    assert.ok(originFeedIdx !== -1);
    assert.ok(
      tagFeedIdx < originFeedIdx,
      "tag-page candidates devem vir antes de origin candidates",
    );
  });

  it("URL inválida → array vazio", () => {
    assert.deepEqual(generateCandidates("not-a-url"), []);
  });

  it("dedup preserva ordem", () => {
    const c = generateCandidates("https://example.com/");
    assert.equal(new Set(c).size, c.length, "sem duplicatas");
  });
});

describe("extractFeedsFromHtml", () => {
  it("extrai feed RSS announced via <link rel=alternate>", () => {
    const html = `
      <html><head>
        <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="Feed">
      </head></html>
    `;
    const feeds = extractFeedsFromHtml(html, "https://example.com/blog/");
    assert.deepEqual(feeds, ["https://example.com/feed.xml"]);
  });

  it("extrai feed Atom também", () => {
    const html = `
      <link rel="alternate" type="application/atom+xml" href="https://example.com/atom.xml">
    `;
    const feeds = extractFeedsFromHtml(html, "https://example.com/");
    assert.deepEqual(feeds, ["https://example.com/atom.xml"]);
  });

  it("extrai múltiplos feeds (RSS + Atom + per-category)", () => {
    const html = `
      <link rel="alternate" type="application/rss+xml" href="/feed">
      <link rel="alternate" type="application/atom+xml" href="/atom.xml">
      <link rel="alternate" type="application/rss+xml" href="/category/ai/feed">
    `;
    const feeds = extractFeedsFromHtml(html, "https://example.com/");
    assert.equal(feeds.length, 3);
    assert.ok(feeds.includes("https://example.com/feed"));
    assert.ok(feeds.includes("https://example.com/atom.xml"));
    assert.ok(feeds.includes("https://example.com/category/ai/feed"));
  });

  it("ignora links que não são feed (rel=stylesheet etc)", () => {
    const html = `
      <link rel="stylesheet" type="text/css" href="/style.css">
      <link rel="canonical" href="/page">
    `;
    assert.deepEqual(extractFeedsFromHtml(html, "https://example.com/"), []);
  });

  it("ignora <link> sem href", () => {
    const html = `<link rel="alternate" type="application/rss+xml">`;
    assert.deepEqual(extractFeedsFromHtml(html, "https://example.com/"), []);
  });

  it("href absoluto é preservado", () => {
    const html = `
      <link rel="alternate" type="application/rss+xml" href="https://feeds.feedburner.com/example">
    `;
    const feeds = extractFeedsFromHtml(html, "https://example.com/");
    assert.deepEqual(feeds, ["https://feeds.feedburner.com/example"]);
  });

  it("dedup feeds duplicados", () => {
    const html = `
      <link rel="alternate" type="application/rss+xml" href="/feed">
      <link rel="alternate" type="application/rss+xml" href="/feed">
    `;
    const feeds = extractFeedsFromHtml(html, "https://example.com/");
    assert.equal(feeds.length, 1);
  });

  it("atributos em ordem inversa funciona (href antes de rel)", () => {
    const html = `<link href="/feed.xml" type="application/rss+xml" rel="alternate">`;
    const feeds = extractFeedsFromHtml(html, "https://example.com/");
    assert.deepEqual(feeds, ["https://example.com/feed.xml"]);
  });
});

describe("shouldSkipHost", () => {
  it("pula twitter/x/linkedin/instagram/facebook/tiktok", () => {
    for (const url of [
      "https://twitter.com/user",
      "https://x.com/user",
      "https://www.linkedin.com/company/x/",
      "https://instagram.com/x",
      "https://facebook.com/x",
      "https://tiktok.com/@x",
    ]) {
      assert.equal(shouldSkipHost(url), true, `should skip ${url}`);
    }
  });

  it("não pula domínios normais", () => {
    for (const url of [
      "https://canaltech.com.br/",
      "https://exame.com/",
      "https://anthropic.com/news/",
    ]) {
      assert.equal(shouldSkipHost(url), false);
    }
  });

  it("URL inválida → skip (defensivo)", () => {
    assert.equal(shouldSkipHost("not-a-url"), true);
  });
});
