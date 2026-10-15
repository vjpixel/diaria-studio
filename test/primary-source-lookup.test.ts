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
  subjectVersionedProductCode,
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
    assert.deepEqual([...extractVersionedProductCodes("OpenAI ships GPT-4o mini")], ["gpt4omini"]);
    assert.deepEqual([...extractVersionedProductCodes("Anthropic treina Claude em Março 2026")], []);
    assert.deepEqual([...extractVersionedProductCodes("Copilot release notes | Microsoft")], []);
  });
});

// #10145: the #10141 matcher accepted ANY shared versioned code, so a headline
// citing the predecessor ("mais barato que o Haiku 4.5") or the platform
// ("no Windows 11") matched the old model's / platform's official page — on
// launch day Brave has not indexed the new page yet and `site:` returns the
// old one. Only the subject code counts now, and sibling variants of one
// version ("2.5 Flash" vs "2.5 Pro") never collide. No network.
describe("sameStoryByExactProductVersion — subject code only, variants distinct (#10145)", () => {
  const noSleep = async () => {};
  const cases = [
    {
      name: "Haiku 5.5 launch citing Haiku 4.5 → Haiku 4.5 page",
      article: { url: "https://press.example/haiku", title: "Anthropic lança Claude Haiku 5.5, mais barato que o Haiku 4.5", suggested_primary_domain: "anthropic.com" },
      candidate: { url: "https://www.anthropic.com/news/claude-haiku-4-5", title: "Introducing Claude Haiku 4.5" },
    },
    {
      name: "GPT-6.1 Sol launch citing GPT-6 → GPT-6 page",
      article: { url: "https://press.example/gpt", title: "OpenAI lança GPT-6.1 Sol, sucessor do GPT-6", suggested_primary_domain: "openai.com" },
      candidate: { url: "https://openai.com/index/gpt-6-for-everyone", title: "GPT-6 and Intelligent UI for everyone" },
    },
    {
      name: "Copilot Vision on Windows 11 → Windows 11 release info",
      article: { url: "https://press.example/copilot", title: "Microsoft lança Copilot Vision no Windows 11", suggested_primary_domain: "microsoft.com" },
      candidate: { url: "https://learn.microsoft.com/windows/release-health/windows11-release-information", title: "Windows 11 release information" },
    },
    {
      name: "Gemini on Pixel 10 → Pixel 10 Pro specs",
      article: { url: "https://press.example/pixel", title: "Google lança Gemini no Pixel 10", suggested_primary_domain: "blog.google" },
      candidate: { url: "https://blog.google/pixel-10-pro-specs", title: "Pixel 10 Pro tech specs" },
    },
    {
      name: "Gemini 2.5 Flash launch → Gemini 2.5 Pro page (variant after version)",
      article: { url: "https://press.example/flash", title: "Google lança Gemini 2.5 Flash para desenvolvedores", suggested_primary_domain: "blog.google" },
      candidate: { url: "https://blog.google/gemini-2-5-pro", title: "Gemini 2.5 Pro: our most intelligent model" },
    },
    {
      name: "Claude 3.5 Haiku launch → Claude 3.5 Sonnet page (variant after version)",
      article: { url: "https://press.example/35haiku", title: "Anthropic lança Claude 3.5 Haiku", suggested_primary_domain: "anthropic.com" },
      candidate: { url: "https://www.anthropic.com/news/claude-3-5-sonnet", title: "Introducing Claude 3.5 Sonnet \\ Anthropic" },
    },
    {
      name: "Gemini 2.5 Flash-Lite launch → Gemini 2.5 Flash page (chained variant)",
      article: { url: "https://press.example/flashlite", title: "Google lança Gemini 2.5 Flash-Lite", suggested_primary_domain: "blog.google" },
      candidate: { url: "https://blog.google/gemini-2-5-flash", title: "Gemini 2.5 Flash: our best price-performance model for developers" },
    },
  ];

  for (const c of cases) {
    it(`rejects: ${c.name}`, async () => {
      assert.equal(sameStoryByExactProductVersion(c.article, c.candidate), false);
      const result = await runActivePrimarySourceLookup({ highlights: [{ rank: 1, article: { ...c.article } }] }, {
        search: async () => [c.candidate],
        pastUrls: new Set(),
        canonicalize: (u) => u,
        sameStory: sameStoryByExactProductVersion,
        sleep: noSleep,
      });
      assert.equal(result.attempts.length, 1, "the title must reach the search (launch verb + domain)");
      assert.equal(result.replaced, 0);
      assert.equal((result.output.highlights![0].article as { url: string }).url, c.article.url);
    });
  }

  it("fixtures discriminate: the #10141 rule (any shared product+version, no variant) accepted every case", () => {
    // Verbatim copy of the pre-#10145 extractor/matcher, kept here so the
    // fixtures prove they would have swapped under the old rule.
    const oldCodes = (text: string) => {
      const codes = new Set<string>();
      for (const m of text.matchAll(/\b([A-Z][A-Za-z]*)[\s-]?(\d+(?:\.\d+)*[a-z]?)(?![\w.]*\d)/g)) {
        if (/^\d{4}$/.test(m[2]) && Number(m[2]) >= 1900) continue;
        codes.add(`${m[1].toLowerCase()}${m[2].toLowerCase()}`);
      }
      return codes;
    };
    for (const c of cases) {
      const a = oldCodes(c.article.title);
      const shared = [...oldCodes(c.candidate.title)].some((code) => a.has(code));
      assert.equal(shared, true, c.name);
    }
  });

  it("still swaps the legit launch pages (subject code ↔ same code)", () => {
    const accept: Array<[string, string]> = [
      ["Anthropic lança Claude Haiku 5.5, mais barato que o Haiku 4.5", "Claude Haiku 5.5 \\ Anthropic"],
      ["OpenAI lança GPT-6.1 Sol, sucessor do GPT-6", "Introducing GPT-6.1 Sol | OpenAI"],
      ["Google lança Gemini 2.5 Flash para desenvolvedores", "Gemini 2.5 Flash: our fastest model"],
      ["Anthropic lança Claude 3.5 Haiku", "Introducing Claude 3.5 Haiku \\ Anthropic"],
      ["Anthropic launches Claude Haiku 5.5 with 90% API price reduction", "Claude Haiku 5.5 \\ Anthropic"],
    ];
    for (const [title, candidateTitle] of accept) {
      assert.equal(sameStoryByExactProductVersion({ title }, { url: "https://x.example/", title: candidateTitle }), true, `${title} ↔ ${candidateTitle}`);
    }
  });

  it("in doubt does not swap: candidate also citing the predecessor, or a variant-less version", () => {
    const article = { title: "Anthropic lança Claude Haiku 5.5, mais barato que o Haiku 4.5" };
    assert.equal(sameStoryByExactProductVersion(article, { url: "https://x.example/", title: "Claude Haiku 5.5 vs Haiku 4.5 benchmarks" }), false);
    assert.equal(sameStoryByExactProductVersion({ title: "Google lança Gemini 2.5 Flash" }, { url: "https://x.example/", title: "Gemini 2.5 models" }), false);
  });

  it("subjectVersionedProductCode picks the launched product, not platform/predecessor", () => {
    assert.equal(subjectVersionedProductCode("Anthropic lança Claude Haiku 5.5, mais barato que o Haiku 4.5"), "haiku5.5");
    assert.equal(subjectVersionedProductCode("OpenAI lança GPT-6.1 Sol, sucessor do GPT-6"), "gpt6.1");
    assert.equal(subjectVersionedProductCode("Microsoft lança Copilot Vision no Windows 11"), undefined);
    assert.equal(subjectVersionedProductCode("Google lança Gemini no Pixel 10"), undefined);
    assert.equal(subjectVersionedProductCode("Google lança Gemini 2.5 Flash-Lite"), "gemini2.5flashlite");
  });

  it("#10147: adjunto com vírgula antes do sujeito não esconde o código (regressão do #10145)", () => {
    assert.equal(subjectVersionedProductCode("Com preço menor, Anthropic lança Haiku 5.5"), "haiku5.5");
    assert.equal(subjectVersionedProductCode("Após atraso, OpenAI lança GPT-5.5"), "gpt5.5");
    assert.equal(subjectVersionedProductCode("Google lança Gemini, no Pixel 10"), undefined);
    assert.equal(sameStoryByExactProductVersion({ title: "Com preço menor, Anthropic lança Haiku 5.5" }, { url: "https://x.example/", title: "Introducing Claude Haiku 5.5" }), true);
    assert.equal(sameStoryByExactProductVersion({ title: "Após atraso, OpenAI lança GPT-5.5" }, { url: "https://x.example/", title: "Introducing GPT-5.5" }), true);
  });

  it("#10147: 'pro' minúsculo (PT) não vira variante Pro; 'Pro' maiúsculo continua", () => {
    assert.equal(subjectVersionedProductCode("Anthropic leva Claude Haiku 5.5 pro Brasil"), "haiku5.5");
    assert.equal(sameStoryByExactProductVersion({ title: "Anthropic leva Claude Haiku 5.5 pro Brasil" }, { url: "https://x.example/", title: "Claude Haiku 5.5 \\ Anthropic" }), true);
    assert.equal(subjectVersionedProductCode("Google lança Gemini 2.5 Pro"), "gemini2.5pro");
  });

  it("#10147: 'multada/processada por <produto>' não troca pela página de lançamento", () => {
    assert.equal(sameStoryByExactProductVersion({ title: "Meta é multada por Llama 5" }, { url: "https://x.example/", title: "Llama 5" }), false);
    assert.equal(sameStoryByExactProductVersion({ title: "Juiz multa OpenAI por GPT-4o" }, { url: "https://x.example/", title: "GPT-4o" }), false);
  });

  it("#10147 review: pós-vírgula com 'mas exige <plataforma>' não vira sujeito; 'pro' final continua variante", () => {
    assert.equal(subjectVersionedProductCode("Novo recurso chega, mas exige iPhone 17"), undefined);
    assert.equal(subjectVersionedProductCode("Nova IA: Gemini 3 pro"), "gemini3pro");
  });

  it("#10205: 2ª oração após pontuação não vira sujeito; preposição inicial é adjunto; sufixo hifenado é variante", () => {
    assert.equal(subjectVersionedProductCode("Microsoft lança Copilot Vision: Windows 11 ganha IA na tela"), undefined);
    assert.equal(subjectVersionedProductCode("OpenAI anuncia plano novo; GPT-5 fica mais barato"), undefined);
    assert.equal(subjectVersionedProductCode("No Windows 11, Microsoft lança Copilot Vision"), undefined);
    assert.equal(subjectVersionedProductCode("Após GPT-5.5, OpenAI lança GPT-6"), "gpt6");
    assert.equal(subjectVersionedProductCode("OpenAI lança GPT-5.5-Codex"), "gpt5.5codex");
    assert.equal(subjectVersionedProductCode("Novo recurso chega, mas exige Windows 11"), undefined);
    assert.equal(sameStoryByExactProductVersion({ title: "OpenAI lança GPT-5.5-Codex" }, { url: "https://x.example/", title: "Introducing GPT-5.5" }), false);
  });

  it("#10277: 1ª oração com verbo de lançamento e objeto genérico segue para a 2ª", () => {
    assert.equal(subjectVersionedProductCode("Anthropic lança novo modelo: Claude Opus 6"), "opus6");
    assert.equal(subjectVersionedProductCode("OpenAI launches new model: GPT-6"), "gpt6");
    assert.equal(subjectVersionedProductCode("Microsoft lança Copilot Vision: Windows 11 ganha IA na tela"), undefined);
  });
});

// #10162: decisão do editor — fonte oficial vence a cobertura em QUALQUER
// seção. Antes, a busca ativa só cobria D1-D3; RADAR `launch_candidate`
// dependia do §1m-ter delegado (nunca rodava) e USE MELHOR não tinha busca
// nenhuma — o editor trocava à mão no gate 4 (261005-261014). Sem rede:
// `search` é fixture.
describe("runActivePrimarySourceLookup — pool RADAR/USE MELHOR (#10162)", () => {
  const noSleep = async () => {};
  const regDomain = (u: string) => {
    try {
      const h = new URL(u).hostname.replace(/^www\./, "");
      return h.split(".").slice(-2).join(".");
    } catch {
      return null;
    }
  };
  const radarPress = {
    url: "https://venturebeat.com/ai/openai-launches-gpt-6-1",
    title: "OpenAI launches GPT-6.1 for developers",
    launch_candidate: true,
    suggested_primary_domain: "openai.com",
  };
  const radarOfficial = "https://openai.com/index/introducing-gpt-6-1";
  const tutorial = {
    url: "https://www.techtudo.com.br/dicas/como-usar-o-claude-para-resumir-pdfs",
    title: "Como usar o Claude para resumir PDFs",
  };
  const tutorialOfficial = "https://support.anthropic.com/resumir-pdfs";
  const search = async (q: string) => {
    if (q.startsWith("site:openai.com")) return [{ url: radarOfficial, title: "Introducing GPT-6.1" }];
    if (q.startsWith("site:anthropic.com")) return [{ url: tutorialOfficial, title: "Como usar o Claude para resumir PDFs | Anthropic" }];
    return [];
  };
  type Item = { url: string; title: string; launch_candidate?: boolean; suggested_primary_domain?: string; flag?: string };
  const fixture = (): { highlights: Array<{ rank: number; article: Item }>; radar: Item[]; use_melhor: Item[] } => ({
    highlights: [{ rank: 1, article: { url: "https://g1.globo.com/a", title: "Empresas brasileiras usam IA" } }],
    radar: [{ ...radarPress }, { url: "https://example.com/r", title: "Outra notícia de IA" }],
    use_melhor: [{ ...tutorial }],
  });
  const base = { pastUrls: new Set<string>(), canonicalize: (u: string) => u, sameStory: sameStoryByExactProductVersion, sleep: noSleep };

  it("sem poolMaxQueries o pool não é buscado (comportamento #10137 preservado)", async () => {
    const queries: string[] = [];
    const result = await runActivePrimarySourceLookup(fixture(), { ...base, search: async (q) => { queries.push(q); return search(q); } });
    assert.deepEqual(queries, []);
    assert.equal((result.output.use_melhor as Array<{ url: string }>)[0].url, tutorial.url);
  });

  it("troca RADAR launch_candidate e USE MELHOR pela página oficial da mesma história", async () => {
    const result = await runActivePrimarySourceLookup(fixture(), { ...base, search, poolMaxQueries: 6, registrableDomain: regDomain });
    assert.equal(result.replaced, 2);
    const radar = result.output.radar as Array<Record<string, unknown>>;
    assert.equal(radar[0].url, radarOfficial);
    assert.deepEqual(radar[0].primary_source_substituted, { from: radarPress.url, to: radarOfficial });
    assert.equal(radar[1].url, "https://example.com/r");
    const um = result.output.use_melhor as Array<Record<string, unknown>>;
    assert.equal(um[0].url, tutorialOfficial);
    assert.deepEqual(result.attempts.map((a) => a.bucket), ["radar", "use_melhor"]);
  });

  it("RADAR sem launch_candidate ou sem verbo de lançamento não é buscado (gate do #10141)", async () => {
    const queries: string[] = [];
    const input = {
      radar: [
        { ...radarPress, launch_candidate: false },
        { ...radarPress, url: "https://venturebeat.com/b", title: "OpenAI é processada por GPT-6.1" },
      ],
    };
    await runActivePrimarySourceLookup(input, { ...base, search: async (q) => { queries.push(q); return []; }, poolMaxQueries: 6 });
    assert.deepEqual(queries, []);
  });

  it("nunca troca submissão do editor nem URL já oficial", async () => {
    const queries: string[] = [];
    const input = {
      radar: [{ ...radarPress, flag: "editor_submitted" }],
      use_melhor: [{ ...tutorial, url: "https://claude.com/blog/resumir-pdfs" }],
    };
    await runActivePrimarySourceLookup(input, {
      ...base,
      search: async (q) => { queries.push(q); return search(q); },
      poolMaxQueries: 6,
      isOfficialUrl: (u) => u.startsWith("https://claude.com/"),
    });
    assert.deepEqual(queries, []);
  });

  it("não leva o domínio oficial acima de 2 URLs na edição (#5735)", async () => {
    const input = fixture();
    input.radar.push({ url: "https://openai.com/index/a", title: "A" }, { url: "https://openai.com/index/b", title: "B" });
    const result = await runActivePrimarySourceLookup(input, { ...base, search, poolMaxQueries: 6, registrableDomain: regDomain });
    assert.equal((result.output.radar as Array<{ url: string }>)[0].url, radarPress.url);
    assert.equal(result.attempts.find((a) => a.bucket === "radar")?.reason, "official-domain-at-cap");
    // O USE MELHOR (anthropic.com, sem URL na edição) segue trocando.
    assert.equal((result.output.use_melhor as Array<{ url: string }>)[0].url, tutorialOfficial);
  });

  it("poolMaxQueries limita as buscas do pool", async () => {
    const queries: string[] = [];
    await runActivePrimarySourceLookup(fixture(), { ...base, search: async (q) => { queries.push(q); return search(q); }, poolMaxQueries: 1 });
    assert.equal(queries.length, 1);
    assert.ok(queries[0].startsWith("site:openai.com"));
  });

  it("USE MELHOR cuja página oficial não é o mesmo assunto mantém a cobertura", async () => {
    const result = await runActivePrimarySourceLookup({ use_melhor: [{ ...tutorial }] }, {
      ...base,
      search: async () => [{ url: "https://www.anthropic.com/news/economic-index", title: "Anthropic Economic Index" }],
      poolMaxQueries: 6,
    });
    assert.equal(result.replaced, 0);
    assert.equal((result.output.use_melhor as Array<{ url: string }>)[0].url, tutorial.url);
  });

  it("a CLI liga o passe do pool com teto e cap de domínio", () => {
    const src = readFileSync(new URL("../scripts/primary-source-active-lookup.ts", import.meta.url), "utf8");
    assert.match(src, /poolMaxQueries: poolMax/);
    assert.match(src, /registrableDomain,/);
    assert.match(src, /DEFAULT_POOL_MAX_QUERIES = 6/);
  });
});
