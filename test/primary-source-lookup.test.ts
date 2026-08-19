import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyPrimarySourceLookup,
  buildPrimarySourceQuery,
  choosePrimarySource,
} from "../scripts/lib/primary-source-lookup.ts";

describe("primary-source-lookup (#5664)", () => {
  const article = {
    url: "https://www.theverge.com/ai/openai-gpt-5",
    title: "OpenAI launches GPT-5 with advanced reasoning",
    summary: "A new OpenAI model is available now.",
  };

  it("builds a site query from the cited company's official domain", () => {
    assert.equal(
      buildPrimarySourceQuery(article),
      "site:openai.com OpenAI launches GPT-5 with advanced reasoning",
    );
  });

  it("uses the Stage 1 suggested domain when company text is not available", () => {
    assert.equal(
      buildPrimarySourceQuery({ ...article, title: "New product announcement", suggested_primary_domain: "openai.com" }),
      "site:openai.com New product announcement",
    );
  });

  it("replaces only with an accessible official same-topic result", () => {
    const result = choosePrimarySource(article, [
      { url: "https://example.com/gpt-5", title: article.title },
      { url: "https://openai.com/research/gpt-5", title: "OpenAI launches GPT-5 with advanced reasoning", accessible: true },
    ]);
    assert.equal(result.url, "https://openai.com/research/gpt-5");
    assert.equal(result.lookup.status, "replaced");
    assert.equal(result.lookup.reason, "official-same-topic-result");
  });

  it("preserves the secondary URL when no result meets the deterministic rule", () => {
    const result = choosePrimarySource(article, [
      { url: "https://openai.com/about", title: "About OpenAI", accessible: true },
      { url: "https://openai.com/research/gpt-5", title: article.title, accessible: false },
    ]);
    assert.equal(result.url, undefined);
    assert.equal(result.lookup.status, "preserved");
    assert.equal(result.lookup.reason, "no-official-same-topic-result");
  });

  it("breaks equal-score candidates by URL, not search-provider order", () => {
    const a = { url: "https://openai.com/z", title: article.title };
    const b = { url: "https://openai.com/a", title: article.title };
    assert.equal(choosePrimarySource(article, [a, b]).url, b.url);
  });

  it("records the attempt across approved highlights and buckets without changing placement", () => {
    const input = {
      highlights: [{ article }],
      radar: [article],
    };
    const result = applyPrimarySourceLookup(input, {
      [article.url]: [{ url: "https://openai.com/research/gpt-5", title: article.title }],
    });
    const outputArticle = result.output.highlights?.[0].article as Record<string, unknown>;
    assert.equal(outputArticle.url, "https://openai.com/research/gpt-5");
    assert.equal((result.output.radar as Array<{ url: string }>)[0].url, "https://openai.com/research/gpt-5");
    assert.equal(result.replaced, 1);
  });
});
