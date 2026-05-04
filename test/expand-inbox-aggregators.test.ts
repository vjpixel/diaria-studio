/**
 * expand-inbox-aggregators.test.ts
 *
 * Tests for #483: expanding aggregator links from inbox submissions.
 * Covers `expandInboxAggregators` with a mocked fetcher (no network).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Article, VerifyEntry } from "../scripts/expand-inbox-aggregators.ts";
import { expandInboxAggregators } from "../scripts/expand-inbox-aggregators.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVerifyMap(entries: VerifyEntry[]): Map<string, VerifyEntry> {
  const map = new Map<string, VerifyEntry>();
  for (const e of entries) {
    map.set(e.url, e);
  }
  return map;
}

const mockFetcherReturnsLinks = (links: string[]) => async (_url: string) => links;
const mockFetcherReturnsEmpty = async (_url: string): Promise<string[]> => [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("expandInboxAggregators (#483)", () => {
  it("artigos não-inbox passam sem alteração", async () => {
    const articles: Article[] = [
      { url: "https://source.com/article", title: "Regular article", source: "rss" },
    ];
    const verifyMap = makeVerifyMap([
      { url: "https://source.com/article", verdict: "aggregator", finalUrl: "https://source.com/article" },
    ]);

    const { articles: out, expanded } = await expandInboxAggregators(
      articles,
      verifyMap,
      mockFetcherReturnsLinks(["https://primary.com/post"]),
    );

    // Non-inbox articles should not be expanded even if verdict is aggregator
    assert.equal(out.length, 1);
    assert.equal(out[0].url, "https://source.com/article");
    assert.equal(expanded.length, 0);
  });

  it("artigo inbox com verdict aggregator é expandido para links primários", async () => {
    const articles: Article[] = [
      {
        url: "https://perplexity.ai/page/some-roundup",
        title: "(inbox)",
        source: "inbox",
        flag: "editor_submitted",
      },
    ];
    const verifyMap = makeVerifyMap([
      {
        url: "https://perplexity.ai/page/some-roundup",
        verdict: "aggregator",
        finalUrl: "https://perplexity.ai/page/some-roundup",
      },
    ]);

    const primaryLinks = [
      "https://techcrunch.com/2026/04/ai-news",
      "https://openai.com/blog/update",
    ];

    const { articles: out, expanded, warnings } = await expandInboxAggregators(
      articles,
      verifyMap,
      mockFetcherReturnsLinks(primaryLinks),
    );

    // Original aggregator article is replaced by 2 extracted links
    assert.equal(out.length, 2);
    assert.equal(out[0].url, "https://techcrunch.com/2026/04/ai-news");
    assert.equal(out[1].url, "https://openai.com/blog/update");

    // Each injected article has correct metadata
    assert.equal(out[0].source, "inbox_via_aggregator");
    assert.equal(out[0].flag, "editor_submitted");
    assert.equal(out[0].inbox_submitted, true);
    assert.equal(out[0].expanded_from, "https://perplexity.ai/page/some-roundup");

    // Expansion report
    assert.equal(expanded.length, 1);
    assert.equal(expanded[0].aggregator_url, "https://perplexity.ai/page/some-roundup");
    assert.equal(expanded[0].injected, 2);
    assert.equal(expanded[0].discarded, false);
    assert.equal(warnings.length, 0);
  });

  it("artigo inbox-aggregador sem links primários é descartado com warning", async () => {
    const articles: Article[] = [
      {
        url: "https://crescendo.ai/weekly",
        title: "(inbox)",
        source: "inbox",
        flag: "editor_submitted",
      },
    ];
    const verifyMap = makeVerifyMap([
      {
        url: "https://crescendo.ai/weekly",
        verdict: "aggregator",
        finalUrl: "https://crescendo.ai/weekly",
      },
    ]);

    const { articles: out, expanded, warnings } = await expandInboxAggregators(
      articles,
      verifyMap,
      mockFetcherReturnsEmpty,
    );

    assert.equal(out.length, 0); // Discarded
    assert.equal(expanded.length, 1);
    assert.equal(expanded[0].discarded, true);
    assert.equal(expanded[0].injected, 0);
    assert.equal(expanded[0].reason, "no_primary_links_found");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("crescendo.ai"));
  });

  it("mistura inbox-agregador + inbox-normal + não-inbox corretamente", async () => {
    const articles: Article[] = [
      // Non-inbox aggregator — pass through
      { url: "https://flipboard.com/x", title: "Flipboard article", source: "rss" },
      // Inbox aggregator — expand
      {
        url: "https://perplexity.ai/page/x",
        title: "(inbox)",
        source: "inbox",
        flag: "editor_submitted",
      },
      // Inbox non-aggregator — pass through
      {
        url: "https://reuters.com/article/x",
        title: "(inbox)",
        source: "inbox",
        flag: "editor_submitted",
      },
    ];

    const verifyMap = makeVerifyMap([
      { url: "https://flipboard.com/x", verdict: "aggregator", finalUrl: "https://flipboard.com/x" },
      { url: "https://perplexity.ai/page/x", verdict: "aggregator", finalUrl: "https://perplexity.ai/page/x" },
      { url: "https://reuters.com/article/x", verdict: "accessible", finalUrl: "https://reuters.com/article/x" },
    ]);

    const { articles: out, expanded } = await expandInboxAggregators(
      articles,
      verifyMap,
      mockFetcherReturnsLinks(["https://primary.org/story"]),
    );

    // flipboard (non-inbox): stays
    // perplexity inbox-aggregator: replaced by 1 extracted link
    // reuters inbox: stays
    assert.equal(out.length, 3);

    const urls = out.map((a) => a.url);
    assert.ok(urls.includes("https://flipboard.com/x"), "flipboard deve permanecer");
    assert.ok(urls.includes("https://primary.org/story"), "link primário extraído deve entrar");
    assert.ok(urls.includes("https://reuters.com/article/x"), "reuters deve permanecer");

    assert.equal(expanded.length, 1); // only the perplexity inbox aggregator was expanded
  });

  it("artigo inbox com source 'inbox_via_aggregator' é reconhecido como inbox", async () => {
    const articles: Article[] = [
      {
        url: "https://crescendo.ai/roundup",
        title: null,
        source: "inbox_via_aggregator",
        flag: "editor_submitted",
      },
    ];
    const verifyMap = makeVerifyMap([
      {
        url: "https://crescendo.ai/roundup",
        verdict: "aggregator",
        finalUrl: "https://crescendo.ai/roundup",
      },
    ]);

    const { articles: out, expanded } = await expandInboxAggregators(
      articles,
      verifyMap,
      mockFetcherReturnsLinks(["https://anthropic.com/news/x"]),
    );

    // inbox_via_aggregator is treated as inbox — should be expanded
    assert.equal(out.length, 1);
    assert.equal(out[0].url, "https://anthropic.com/news/x");
    assert.equal(expanded.length, 1);
    assert.equal(expanded[0].discarded, false);
  });

  it("lista vazia retorna saída vazia sem erros", async () => {
    const { articles: out, expanded, warnings } = await expandInboxAggregators(
      [],
      new Map(),
      mockFetcherReturnsEmpty,
    );
    assert.equal(out.length, 0);
    assert.equal(expanded.length, 0);
    assert.equal(warnings.length, 0);
  });

  it("artigo inbox sem entry no verifyMap (sem verdict) passa sem expansão", async () => {
    const articles: Article[] = [
      {
        url: "https://example.com/no-verify",
        title: "(inbox)",
        source: "inbox",
        flag: "editor_submitted",
        // No verdict set, no entry in verifyMap
      },
    ];
    const verifyMap = new Map<string, VerifyEntry>();

    const { articles: out, expanded } = await expandInboxAggregators(
      articles,
      verifyMap,
      mockFetcherReturnsLinks(["https://primary.com/x"]),
    );

    // No verdict = not aggregator → pass through unchanged
    assert.equal(out.length, 1);
    assert.equal(out[0].url, "https://example.com/no-verify");
    assert.equal(expanded.length, 0);
  });

  it("relata contagem correta de links injetados na saída", async () => {
    const articles: Article[] = [
      {
        url: "https://perplexity.ai/page/multi",
        title: "(inbox)",
        source: "inbox",
        flag: "editor_submitted",
      },
    ];
    const verifyMap = makeVerifyMap([
      {
        url: "https://perplexity.ai/page/multi",
        verdict: "aggregator",
        finalUrl: "https://perplexity.ai/page/multi",
      },
    ]);

    const fiveLinks = [
      "https://a.com/1",
      "https://b.com/2",
      "https://c.com/3",
      "https://d.com/4",
      "https://e.com/5",
    ];

    const { expanded } = await expandInboxAggregators(
      articles,
      verifyMap,
      mockFetcherReturnsLinks(fiveLinks),
    );

    assert.equal(expanded[0].injected, 5);
    assert.deepEqual(expanded[0].extracted_urls, fiveLinks);
  });
});
