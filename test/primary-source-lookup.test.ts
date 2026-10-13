import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isIntraEditionDuplicate } from "../scripts/dedup-intra-edition.ts";
import {
  applyPrimarySourceLookup,
  buildPrimarySourceQuery,
  choosePrimarySource,
  extractVersionedProductCodes,
  runActivePrimarySourceLookup,
  sameStoryByExactProductVersion,
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

// #10137: §1m-ter/§1y were delegated to the orchestrator and never ran after
// the Stage 1 runner (#5415) — zero substitutions from 260818 on. The active
// lookup now runs inside the runner for D1-D3. Fixtures below mirror the real
// 261008 case (venturebeat D3 → anthropic.com/claude-haiku-5-5). No network:
// `search` is a fixture.
describe("runActivePrimarySourceLookup (#10137)", () => {
  const haiku = {
    url: "https://venturebeat.com/technology/anthropic-launches-claude-haiku-5-5",
    title: "Anthropic launches Claude Haiku 5.5 with 90% API price reduction",
    suggested_primary_domain: "anthropic.com",
  };
  const official = "https://www.anthropic.com/claude-haiku-5-5";
  const d1 = { url: "https://openai.com/index/gpt-6-for-everyone", title: "GPT-6 and Intelligent UI for everyone" };
  const fixture = () => ({
    highlights: [
      { rank: 1, article: { ...d1 } },
      { rank: 2, article: { url: "https://g1.globo.com/brasil/noticia", title: "Empresas brasileiras usam IA sem revisão" } },
      { rank: 3, article: { ...haiku } },
      { rank: 4, article: { url: "https://theverge.com/x", title: "OpenAI ships something" } },
    ],
    radar: [{ ...haiku }, { url: "https://example.com/other", title: "Other" }],
  });
  const noSleep = async () => {};
  const sameStory = (a: { title?: string }, c: { title: string }) => (a.title ?? "").includes("Haiku 5.5") && c.title.includes("Haiku 5.5");

  it("replaces a top-3 highlight's secondary URL with the official one and annotates from/to", async () => {
    const queries: string[] = [];
    const result = await runActivePrimarySourceLookup(fixture(), {
      search: async (q) => {
        queries.push(q);
        return [{ url: official, title: "Claude Haiku 5.5 \\ Anthropic" }];
      },
      pastUrls: new Set(),
      canonicalize: (u) => u,
      sameStory,
      sleep: noSleep,
    });
    // D1 already official (openai.com) → no query; rank 4 is outside D1-D3.
    assert.deepEqual(queries, [`site:anthropic.com ${haiku.title}`]);
    assert.equal(result.replaced, 1);
    const art = result.output.highlights![2].article as Record<string, unknown>;
    assert.equal(art.url, official);
    assert.deepEqual(art.primary_source_substituted, { from: haiku.url, to: official });
    assert.equal((art.primary_source_lookup as { match?: string }).match, "same-story");
    // The highlight's copy in its bucket follows the same URL (no orphan secondary).
    assert.equal((result.output.radar as Array<{ url: string }>)[0].url, official);
  });

  it("without the same-story matcher, the short official title (sim < 0.60) is NOT accepted — the regression that kept 261008 manual", async () => {
    const result = await runActivePrimarySourceLookup(fixture(), {
      search: async () => [{ url: official, title: "Claude Haiku 5.5 \\ Anthropic" }],
      pastUrls: new Set(),
      canonicalize: (u) => u,
      sleep: noSleep,
    });
    assert.equal(result.replaced, 0);
  });

  it("never uses an official URL already published in the dedup window", async () => {
    const result = await runActivePrimarySourceLookup(fixture(), {
      search: async () => [{ url: official, title: "Claude Haiku 5.5 \\ Anthropic" }],
      pastUrls: new Set([official]),
      canonicalize: (u) => u,
      sameStory,
      sleep: noSleep,
    });
    assert.equal(result.replaced, 0);
    assert.equal(result.attempts[0].reason, "official-result-repeats-past-edition");
    assert.equal((result.output.highlights![2].article as { url: string }).url, haiku.url);
  });

  it("never uses an official URL that is already in this edition", async () => {
    const input = fixture();
    input.radar.push({ url: official, title: "Claude Haiku 5.5 \\ Anthropic", suggested_primary_domain: "" });
    const result = await runActivePrimarySourceLookup(input, {
      search: async () => [{ url: official, title: "Claude Haiku 5.5 \\ Anthropic" }],
      pastUrls: new Set(),
      canonicalize: (u) => u,
      sameStory,
      sleep: noSleep,
    });
    assert.equal(result.replaced, 0);
    assert.equal(result.attempts[0].reason, "official-result-already-in-edition");
  });

  it("search failure (null or throw) preserves the secondary URL", async () => {
    for (const search of [async () => null, async () => { throw new Error("network"); }]) {
      const result = await runActivePrimarySourceLookup(fixture(), {
        search,
        pastUrls: new Set(),
        canonicalize: (u) => u,
        sameStory,
        sleep: noSleep,
      });
      assert.equal(result.replaced, 0);
      assert.equal(result.attempts[0].reason, "search-failed");
      assert.equal((result.output.highlights![2].article as { url: string }).url, haiku.url);
    }
  });

  it("rejects off-domain results even when the story matches", async () => {
    const result = await runActivePrimarySourceLookup(fixture(), {
      search: async () => [{ url: "https://techcrunch.com/haiku-5-5", title: "Claude Haiku 5.5 \\ Anthropic" }],
      pastUrls: new Set(),
      canonicalize: (u) => u,
      sameStory,
      sleep: noSleep,
    });
    assert.equal(result.replaced, 0);
  });

  it("the real same-story matcher accepts the 261008 official page and rejects unrelated pages of the same company", () => {
    const press = { url: haiku.url, title: haiku.title };
    assert.equal(sameStoryByExactProductVersion(press, { url: official, title: "Claude Haiku 5.5 \\ Anthropic" }), true);
    assert.equal(sameStoryByExactProductVersion(press, { url: "https://www.anthropic.com/opus", title: "Claude Opus 5.5 system card" }), false);
    assert.equal(sameStoryByExactProductVersion(press, { url: "https://www.anthropic.com/index", title: "Anthropic Economic Index report" }), false);
  });

  it("waits between searches (Brave 1 q/s) and not before the first", async () => {
    const input = {
      highlights: [
        { rank: 1, article: { url: "https://press.example/a", title: "OpenAI launches GPT-6", suggested_primary_domain: "openai.com" } },
        { rank: 2, article: { url: "https://press.example/b", title: "Google launches Gemini 4", suggested_primary_domain: "blog.google" } },
      ],
    };
    const sleeps: number[] = [];
    await runActivePrimarySourceLookup(input, {
      search: async () => [],
      pastUrls: new Set(),
      canonicalize: (u) => u,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.deepEqual(sleeps, [1100]);
  });
});

// #10141: the #10137 wiring accepted `isIntraEditionDuplicate`'s cross_vehicle
// branch ("same company + 1 shared word") as same-story. Every result of
// `site:{official domain}` already carries the company name, so a lawsuit /
// fine / layoff headline sharing only a bare product name got its D1-D3 URL
// swapped for an unrelated official product page. The 4 cases below are the
// ones reproduced in the issue — none may swap. No network: `search` is a fixture.
describe("runActivePrimarySourceLookup — no swap to unrelated official pages (#10141)", () => {
  const noSleep = async () => {};
  const cases = [
    {
      name: "lawsuit about Claude → Claude 3 family page",
      article: { url: "https://g1.globo.com/tec/anthropic-livros", title: "Anthropic é acusada de usar livros piratas para treinar Claude", suggested_primary_domain: "anthropic.com" },
      candidate: { url: "https://www.anthropic.com/news/claude-3-family", title: "Introducing the next generation of Claude \\ Anthropic" },
    },
    {
      name: "EU fine about Llama → Llama 3.1 launch page",
      article: { url: "https://g1.globo.com/tec/meta-multa", title: "Meta enfrenta multa na Europa por treinar Llama com dados de usuários", suggested_primary_domain: "ai.meta.com" },
      candidate: { url: "https://ai.meta.com/blog/meta-llama-3-1/", title: "Introducing Llama 3.1 | Meta AI" },
    },
    {
      name: "layoffs while investing in Copilot → Copilot release notes",
      article: { url: "https://g1.globo.com/tec/microsoft-demissoes", title: "Microsoft corta 9 mil empregos enquanto investe em Copilot", suggested_primary_domain: "microsoft.com" },
      candidate: { url: "https://learn.microsoft.com/copilot/release-notes", title: "Copilot release notes | Microsoft" },
    },
    {
      name: "GPT-5.5 story → previous-version GPT-5 page",
      article: { url: "https://g1.globo.com/tec/gpt-5-5", title: "OpenAI GPT-5.5 chega com raciocínio melhor", suggested_primary_domain: "openai.com" },
      candidate: { url: "https://openai.com/index/introducing-gpt-5/", title: "Introducing GPT-5 | OpenAI" },
    },
  ];

  for (const c of cases) {
    it(`keeps the secondary URL: ${c.name}`, async () => {
      const result = await runActivePrimarySourceLookup({ highlights: [{ rank: 1, article: { ...c.article } }] }, {
        search: async () => [c.candidate],
        pastUrls: new Set(),
        canonicalize: (u) => u,
        sameStory: sameStoryByExactProductVersion,
        sleep: noSleep,
      });
      assert.equal(result.replaced, 0);
      assert.equal((result.output.highlights![0].article as { url: string }).url, c.article.url);
    });

    it(`the matcher itself rejects it, even with a launch verb forced into the title: ${c.name}`, async () => {
      // Guards the matcher independently of the launch-verb gate (a headline
      // can carry "lança"/"launches" and still be about something else).
      assert.equal(sameStoryByExactProductVersion(c.article, c.candidate), false);
      const forced = { ...c.article, title: `${c.article.title} e lança novidades` };
      const result = await runActivePrimarySourceLookup({ highlights: [{ rank: 1, article: forced }] }, {
        search: async () => [c.candidate],
        pastUrls: new Set(),
        canonicalize: (u) => u,
        sameStory: sameStoryByExactProductVersion,
        sleep: noSleep,
      });
      assert.equal(result.attempts.length, 1, "the forced title must reach the search");
      assert.equal(result.replaced, 0);
      assert.equal((result.output.highlights![0].article as { url: string }).url, c.article.url);
    });
  }

  it("fixtures discriminate: the #10137 matcher (isIntraEditionDuplicate) accepts all 4 as cross_vehicle", () => {
    for (const c of cases) {
      const hit = isIntraEditionDuplicate(
        { url: c.candidate.url, title: c.candidate.title },
        [{ article: { url: c.article.url, title: c.article.title } }] as never,
      );
      assert.equal(hit?.match_type, "cross_vehicle", c.name);
    }
  });

  it("the CLI wires the strict matcher, never isIntraEditionDuplicate", () => {
    const src = readFileSync(new URL("../scripts/primary-source-active-lookup.ts", import.meta.url), "utf8");
    assert.match(src, /sameStory: sameStoryByExactProductVersion/);
    assert.doesNotMatch(src, /from "\.\/dedup-intra-edition\.ts"/);
  });

  it("does not even search without a launch verb in the title", async () => {
    const queries: string[] = [];
    await runActivePrimarySourceLookup({ highlights: [{ rank: 1, article: { ...cases[0].article } }] }, {
      search: async (q) => { queries.push(q); return [cases[0].candidate]; },
      pastUrls: new Set(),
      canonicalize: (u) => u,
      sameStory: sameStoryByExactProductVersion,
      sleep: noSleep,
    });
    assert.deepEqual(queries, []);
  });

  it("does not search without an explicit suggested_primary_domain, even when the company is detectable", async () => {
    const queries: string[] = [];
    const article = { url: "https://press.example/x", title: "Anthropic launches Claude Haiku 5.5" };
    await runActivePrimarySourceLookup({ highlights: [{ rank: 1, article }] }, {
      search: async (q) => { queries.push(q); return []; },
      pastUrls: new Set(),
      canonicalize: (u) => u,
      sameStory: sameStoryByExactProductVersion,
      sleep: noSleep,
    });
    assert.deepEqual(queries, []);
  });

  it("the legit 261008 launch still swaps under the exact product+version rule", async () => {
    const article = {
      url: "https://venturebeat.com/technology/anthropic-launches-claude-haiku-5-5",
      title: "Anthropic launches Claude Haiku 5.5 with 90% API price reduction",
      suggested_primary_domain: "anthropic.com",
    };
    const official = "https://www.anthropic.com/claude-haiku-5-5";
    const result = await runActivePrimarySourceLookup({ highlights: [{ rank: 1, article }] }, {
      search: async () => [{ url: official, title: "Claude Haiku 5.5 \\ Anthropic" }],
      pastUrls: new Set(),
      canonicalize: (u) => u,
      sameStory: sameStoryByExactProductVersion,
      sleep: noSleep,
    });
    assert.equal(result.replaced, 1);
    assert.equal((result.output.highlights![0].article as { url: string }).url, official);
  });

  it("extractVersionedProductCodes keeps product+version, drops bare names and years", () => {
    assert.deepEqual([...extractVersionedProductCodes("OpenAI GPT-5.5 chega")], ["gpt5.5"]);
    assert.deepEqual([...extractVersionedProductCodes("Introducing GPT-5 | OpenAI")], ["gpt5"]);
    assert.deepEqual([...extractVersionedProductCodes("Claude Haiku 5.5 \\ Anthropic")], ["haiku5.5"]);
    assert.deepEqual([...extractVersionedProductCodes("OpenAI ships GPT-4o mini")], ["gpt4o"]);
    assert.deepEqual([...extractVersionedProductCodes("Anthropic treina Claude em Março 2026")], []);
    assert.deepEqual([...extractVersionedProductCodes("Copilot release notes | Microsoft")], []);
  });
});
