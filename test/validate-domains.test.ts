import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractUrlsWithLines,
  validateDomains,
} from "../scripts/validate-domains.ts";
import { isPaywall } from "../scripts/lib/paywalls.ts";

describe("isPaywall (#701)", () => {
  it("detecta paywalls hard cadastrados", () => {
    assert.equal(isPaywall("https://www.bloomberg.com/news/articles/x"), true);
    assert.equal(isPaywall("https://wsj.com/articles/y"), true);
    assert.equal(isPaywall("https://www.nytimes.com/2026/05/05/tech/x.html"), true);
    assert.equal(isPaywall("https://www.theinformation.com/articles/z"), true);
    assert.equal(isPaywall("https://www.fortune.com/2026/05/05/x"), true);
  });

  it("ignora www. e case", () => {
    assert.equal(isPaywall("https://WWW.Bloomberg.COM/x"), true);
  });

  it("não detecta domínios fora da lista", () => {
    assert.equal(isPaywall("https://techcrunch.com/x"), false);
    assert.equal(isPaywall("https://www.theverge.com/x"), false);
    assert.equal(isPaywall("https://openai.com/blog"), false);
  });

  it("URL malformada → false (sem throw)", () => {
    assert.equal(isPaywall("not a url"), false);
    assert.equal(isPaywall(""), false);
  });
});

describe("extractUrlsWithLines (#701)", () => {
  it("extrai URLs com número de linha 1-indexed", () => {
    const md = ["primeira linha", "segunda https://a.com/x linha", "https://b.com/y"].join("\n");
    const urls = extractUrlsWithLines(md);
    assert.deepEqual(urls, [
      { url: "https://a.com/x", line: 2 },
      { url: "https://b.com/y", line: 3 },
    ]);
  });

  it("dedup markdown link [url](url)", () => {
    const md = "Item [https://a.com](https://a.com)";
    const urls = extractUrlsWithLines(md);
    assert.equal(urls.length, 1);
    assert.equal(urls[0].url, "https://a.com");
  });

  it("limpa pontuação trailing", () => {
    const md = "Texto com link https://a.com/x.";
    const urls = extractUrlsWithLines(md);
    assert.equal(urls[0].url, "https://a.com/x");
  });
});

describe("validateDomains (#701)", () => {
  it("ok quando todas URLs são válidas", () => {
    const md = [
      "LANÇAMENTOS",
      "https://openai.com/blog/x",
      "PESQUISAS",
      "https://arxiv.org/abs/2510.12345",
      "OUTRAS NOTÍCIAS",
      "https://techcrunch.com/y",
    ].join("\n");
    const r = validateDomains(md);
    assert.equal(r.ok, true);
    assert.equal(r.paywall_violations.length, 0);
    assert.equal(r.aggregator_violations.length, 0);
  });

  it("bloqueia URL Bloomberg em LANÇAMENTOS (paywall)", () => {
    const md = [
      "LANÇAMENTOS",
      "GPT-5.5 lançado",
      "https://www.bloomberg.com/news/articles/gpt-5-5",
    ].join("\n");
    const r = validateDomains(md);
    assert.equal(r.ok, false);
    assert.equal(r.paywall_violations.length, 1);
    assert.equal(r.paywall_violations[0].reason, "paywall");
    assert.equal(r.paywall_violations[0].line, 3);
  });

  it("bloqueia URL crescendo.ai (agregador)", () => {
    const md = ["OUTRAS NOTÍCIAS", "Resumo", "https://crescendo.ai/news/ai-roundup"].join("\n");
    const r = validateDomains(md);
    assert.equal(r.ok, false);
    assert.equal(r.aggregator_violations.length, 1);
    assert.equal(r.aggregator_violations[0].reason, "aggregator");
  });

  it("bloqueia múltiplas violações distintas", () => {
    const md = [
      "Item 1 https://www.wsj.com/articles/a",
      "Item 2 https://www.theinformation.com/b",
      "Item 3 https://flipboard.com/c",
    ].join("\n");
    const r = validateDomains(md);
    assert.equal(r.ok, false);
    assert.equal(r.paywall_violations.length, 2);
    assert.equal(r.aggregator_violations.length, 1);
  });
});
