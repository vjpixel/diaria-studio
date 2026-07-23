import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractUrlsFromBuckets } from "../scripts/lib/approved-urls.ts";

describe("extractUrlsFromBuckets (#1678)", () => {
  it("anda por todos os buckets novos (#1629)", () => {
    const urls = extractUrlsFromBuckets({
      lancamento: [{ url: "l" }],
      radar: [{ url: "r" }],
      use_melhor: [{ url: "u" }],
      video: [{ url: "v" }],
    });
    assert.deepEqual(urls, ["l", "r", "u", "v"]);
  });

  it("anda pelos buckets legacy (pesquisa/noticias/tutorial)", () => {
    const urls = extractUrlsFromBuckets({
      pesquisa: [{ url: "p" }],
      noticias: [{ url: "n" }],
      tutorial: [{ url: "t" }],
    });
    assert.deepEqual(urls.sort(), ["n", "p", "t"]);
  });

  it("highlights/runners_up: precedência h.url ?? h.article?.url", () => {
    const urls = extractUrlsFromBuckets({
      highlights: [{ url: "top-level-wins" }, { article: { url: "from-article" } }],
      runners_up: [{ url: "ru1" }],
    });
    assert.deepEqual(urls, ["top-level-wins", "from-article", "ru1"]);
  });

  it("dedup preservando ordem de inserção", () => {
    const urls = extractUrlsFromBuckets({
      lancamento: [{ url: "x" }],
      radar: [{ url: "x" }, { url: "y" }],
    });
    assert.deepEqual(urls, ["x", "y"]);
  });

  it("null/undefined/shape parcial → [] sem crash", () => {
    assert.deepEqual(extractUrlsFromBuckets(null), []);
    assert.deepEqual(extractUrlsFromBuckets(undefined), []);
    assert.deepEqual(extractUrlsFromBuckets({}), []);
    assert.deepEqual(extractUrlsFromBuckets({ radar: "oops" as any }), []);
  });

  it("ignora entries sem url", () => {
    const urls = extractUrlsFromBuckets({
      lancamento: [{ url: "l" }, {} as any, { url: "" }],
    });
    assert.deepEqual(urls, ["l"]);
  });

  it("#3920: coleta URLs de cluster_sources em highlights (.article) e buckets", () => {
    const urls = extractUrlsFromBuckets({
      highlights: [
        {
          url: "destaque-canonico",
          article: {
            url: "destaque-canonico",
            cluster_sources: [{ url: "aprofunde-1" }, { url: "aprofunde-2" }],
          },
        },
      ],
      radar: [
        { url: "radar-canonico", cluster_sources: [{ url: "radar-src" }] },
      ],
    });
    assert.ok(urls.includes("aprofunde-1"));
    assert.ok(urls.includes("aprofunde-2"));
    assert.ok(urls.includes("radar-src"));
    assert.ok(urls.includes("destaque-canonico"));
    assert.ok(urls.includes("radar-canonico"));
  });

  it("#3920: cluster_sources sem url são ignorados", () => {
    const urls = extractUrlsFromBuckets({
      radar: [{ url: "r", cluster_sources: [{} as any, { url: "" }, { url: "ok" }] }],
    });
    assert.deepEqual(urls.sort(), ["ok", "r"]);
  });
});
