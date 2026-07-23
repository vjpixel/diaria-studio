import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedup } from "../scripts/dedup.ts";

// #3920: sub-pass 2b agora PRESERVA os perdedores same-story como
// cluster_sources[] no vencedor mais completo, em vez de descartá-los.

const TITLE = "Modelo X supera benchmark de raciocínio";

describe("dedup cluster same-story (#3920)", () => {
  it("dobra 3 artigos same-story em 1 vencedor com cluster_sources[2]", () => {
    const articles = [
      { url: "https://verge.com/x", title: TITLE, source: "The Verge", summary: "b".repeat(120), published_at: "2026-07-21" },
      { url: "https://techcrunch.com/x", title: TITLE, source: "TechCrunch", summary: "a".repeat(400), published_at: "2026-07-20" },
      { url: "https://blog.dev/x", title: TITLE, source: "Blog", discovered_source: true, summary: "c".repeat(30), published_at: "2026-07-22" },
      { url: "https://other.com/y", title: "Assunto completamente diferente sobre chips", source: "Ars", summary: "z".repeat(80) },
    ];

    const { kept, removed } = dedup(articles, new Set(), 0.85);

    // 2 kept: o canônico do cluster + o artigo distinto
    assert.equal(kept.length, 2);

    const canonical = kept.find((a) => a.title === TITLE);
    assert.ok(canonical, "vencedor do cluster deve sobreviver");
    // Canônico = maior summary = TechCrunch (400 chars)
    assert.equal(canonical!.url, "https://techcrunch.com/x");
    assert.equal(canonical!.cluster_sources?.length, 2);
    const csUrls = canonical!.cluster_sources!.map((c) => c.url).sort();
    assert.deepEqual(csUrls, ["https://blog.dev/x", "https://verge.com/x"]);
    // cluster_sources carregam source + published_at pro Aprofunde
    const verge = canonical!.cluster_sources!.find((c) => c.url === "https://verge.com/x");
    assert.equal(verge!.source, "The Verge");
    assert.equal(verge!.published_at, "2026-07-21");

    // artigo distinto intacto, sem cluster_sources
    const other = kept.find((a) => a.url === "https://other.com/y");
    assert.ok(other);
    assert.equal(other!.cluster_sources, undefined);

    // perdedores saem em removed com nota de cluster
    assert.equal(removed.length, 2);
    assert.ok(removed.every((r) => /cluster same-story/.test(r.dedup_note)));
  });

  it("summary maior vence mesmo vindo de fonte discovered (decisão do editor)", () => {
    const articles = [
      { url: "https://reg.com/x", title: TITLE, source: "Registered", discovered_source: false, summary: "a".repeat(50) },
      { url: "https://disc.com/x", title: TITLE, source: "Discovered", discovered_source: true, summary: "b".repeat(500) },
    ];
    const { kept } = dedup(articles, new Set(), 0.85);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].url, "https://disc.com/x"); // maior summary vence
    assert.equal(kept[0].cluster_sources?.length, 1);
    assert.equal(kept[0].cluster_sources![0].url, "https://reg.com/x");
  });

  it("cluster de 1 (sem fontes extras) não ganha cluster_sources", () => {
    const articles = [
      { url: "https://a.com/x", title: "História única sobre satélites de IA", summary: "s" },
    ];
    const { kept } = dedup(articles, new Set(), 0.85);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].cluster_sources, undefined);
  });

  it("dedup contra edições passadas continua REMOVENDO (não vira cluster)", () => {
    const past = new Set(["https://old.com/x"]);
    const articles = [
      { url: "https://old.com/x", title: "Link repetido de edição anterior", summary: "s" },
      { url: "https://new.com/y", title: "Notícia inédita sobre GPUs", summary: "s" },
    ];
    const { kept } = dedup(articles, past, 0.85);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].url, "https://new.com/y");
    assert.equal(kept[0].cluster_sources, undefined);
  });

  it("títulos placeholder (inbox) nunca clusterizam por título", () => {
    const articles = [
      { url: "https://a.com/x", title: "(inbox)", summary: "s" },
      { url: "https://b.com/y", title: "(inbox)", summary: "s" },
    ];
    const { kept } = dedup(articles, new Set(), 0.85);
    assert.equal(kept.length, 2);
    assert.ok(kept.every((a) => a.cluster_sources === undefined));
  });
});
