import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAggregator,
  filterSources,
  AGGREGATOR_BLOCKLIST,
} from "../scripts/lib/aggregator-blocklist.ts";

describe("isAggregator (#717 hyp 5)", () => {
  it("detecta agregador clássico (crescendo.ai)", () => {
    const r = isAggregator("https://crescendo.ai/news/today");
    assert.equal(r.blocked, true);
    assert.equal(r.category, "classic_aggregator");
    assert.equal(r.pattern, "crescendo.ai");
  });

  it("detecta newsletter de roundup AI (aibreakfast.beehiiv.com)", () => {
    const r = isAggregator("https://aibreakfast.beehiiv.com/");
    assert.equal(r.blocked, true);
    assert.equal(r.category, "ai_roundup_newsletter");
  });

  it("case-insensitive match", () => {
    const r = isAggregator("https://AIBREAKFAST.beehiiv.com/p/123");
    assert.equal(r.blocked, true);
  });

  it("matcha path-prefix (tldr.tech/ai mas NÃO tldr.tech/security)", () => {
    assert.equal(isAggregator("https://tldr.tech/ai/2026-05-06").blocked, true);
    assert.equal(isAggregator("https://tldr.tech/security/2026-05-06").blocked, false);
  });

  it("perplexity.ai bloqueado por default", () => {
    const r = isAggregator("https://www.perplexity.ai/search?q=foo");
    assert.equal(r.blocked, true);
    assert.equal(r.category, "perplexity_non_primary");
  });

  it("perplexity.ai/hub/ NÃO bloqueado (fonte primária)", () => {
    const r = isAggregator("https://www.perplexity.ai/hub/blog/some-post");
    assert.equal(r.blocked, false);
  });

  it("research.perplexity.ai NÃO bloqueado (fonte primária)", () => {
    const r = isAggregator("https://research.perplexity.ai/articles/foo");
    assert.equal(r.blocked, false);
  });

  it("URL não-agregador retorna blocked: false", () => {
    assert.equal(isAggregator("https://anthropic.com/news/article").blocked, false);
    assert.equal(isAggregator("https://openai.com/blog/x").blocked, false);
    assert.equal(isAggregator("https://news.google.com/articles/foo").blocked, false);
  });

  it("URL inválida retorna blocked: false (defensive)", () => {
    assert.equal(isAggregator("").blocked, false);
    assert.equal(isAggregator(null as unknown as string).blocked, false);
    assert.equal(isAggregator(undefined as unknown as string).blocked, false);
  });

  it("br_republisher (docmanagement.com.br)", () => {
    const r = isAggregator("https://docmanagement.com.br/post/x");
    assert.equal(r.blocked, true);
    assert.equal(r.category, "br_republisher");
  });
});

describe("filterSources (#717 hyp 5)", () => {
  it("separa kept e skipped corretamente", () => {
    const sources = [
      { name: "Anthropic", url: "https://anthropic.com/news" },
      { name: "AI Breakfast", url: "https://aibreakfast.beehiiv.com/" },
      { name: "OpenAI", url: "https://openai.com/blog/" },
      { name: "TLDR AI", url: "https://tldr.tech/ai/" },
      { name: "Perplexity Research", url: "https://research.perplexity.ai/" },
    ];
    const r = filterSources(sources);
    assert.equal(r.kept.length, 3, "kept: anthropic, openai, perplexity-research");
    assert.equal(r.skipped.length, 2, "skipped: aibreakfast, tldr/ai");
    assert.deepEqual(
      r.kept.map((s) => s.name).sort(),
      ["Anthropic", "OpenAI", "Perplexity Research"],
    );
    assert.deepEqual(
      r.skipped.map((s) => s.name).sort(),
      ["AI Breakfast", "TLDR AI"],
    );
  });

  it("skipped inclui category + pattern pra log/debug", () => {
    const sources = [{ name: "AI Breakfast", url: "https://aibreakfast.beehiiv.com/" }];
    const r = filterSources(sources);
    assert.equal(r.skipped[0].category, "ai_roundup_newsletter");
    assert.equal(r.skipped[0].pattern, "aibreakfast.beehiiv.com");
  });

  it("array vazio retorna kept e skipped vazios", () => {
    const r = filterSources([]);
    assert.deepEqual(r.kept, []);
    assert.deepEqual(r.skipped, []);
  });
});

describe("AGGREGATOR_BLOCKLIST (#717 hyp 5)", () => {
  it("nenhuma entrada vazia ou com whitespace", () => {
    for (const entry of AGGREGATOR_BLOCKLIST) {
      assert.ok(entry.pattern.length > 0, `pattern vazio: ${JSON.stringify(entry)}`);
      assert.equal(
        entry.pattern.trim(),
        entry.pattern,
        `pattern com whitespace: ${JSON.stringify(entry)}`,
      );
    }
  });

  it("todas as entradas têm category válida", () => {
    const validCategories = new Set([
      "classic_aggregator",
      "ai_roundup_newsletter",
      "br_republisher",
      "perplexity_non_primary",
    ]);
    for (const entry of AGGREGATOR_BLOCKLIST) {
      assert.ok(
        validCategories.has(entry.category),
        `category inválida: ${entry.category}`,
      );
    }
  });
});
