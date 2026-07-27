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

  // #4102 CASO REAL 260727: todos os links extraídos da MESMA newsletter
  // capturada compartilham o título sintético `(newsletter:{sender})`
  // LITERALMENTE idêntico (titleSimilarity = 1.0) até serem enriquecidos —
  // sem o guard, o clustering single-linkage os agrupava como se fossem
  // cobertura da mesma história, mesmo sendo notícias sem relação alguma
  // (o item do Y Combinator ganhou cluster_sources apontando pra Fallout da
  // Bethesda, livros na Amazon e um tweet pessoal).
  describe("newsletter_extracted nunca clusteriza (#4102)", () => {
    it("2 artigos newsletter_extracted com título idêntico NÃO clusterizam entre si", () => {
      const articles = [
        {
          url: "https://ycombinator.com/library/x",
          title: '(newsletter:"Lenny\'s Newsletter")',
          flag: "newsletter_extracted",
          summary: "",
        },
        {
          url: "https://bethesda.net/fallout",
          title: '(newsletter:"Lenny\'s Newsletter")',
          flag: "newsletter_extracted",
          summary: "",
        },
      ];
      const { kept } = dedup(articles, new Set(), 0.85);
      assert.equal(kept.length, 2, "os 2 links devem permanecer separados, sem cluster_sources cruzado");
      assert.ok(kept.every((a) => a.cluster_sources === undefined));
    });

    it("artigo newsletter_extracted NÃO vira membro do cluster de um artigo normal com título idêntico", () => {
      // Cenário adversarial: o título sintético coincide (mesmo por acaso)
      // com o título de um artigo já enriquecido de outra fonte — mesmo
      // assim, o newsletter_extracted não deve entrar no cluster.
      const sameTitle = "Notícia sobre IA que por coincidência bate o título";
      const articles = [
        { url: "https://real-source.com/a", title: sameTitle, source: "TechCrunch", summary: "resumo real" },
        { url: "https://ycombinator.com/library/y", title: sameTitle, flag: "newsletter_extracted", summary: "" },
      ];
      const { kept } = dedup(articles, new Set(), 0.85);
      assert.equal(kept.length, 2, "newsletter_extracted não deve se fundir no artigo real mesmo com título idêntico");
      const real = kept.find((a) => a.url === "https://real-source.com/a");
      assert.equal(real?.cluster_sources, undefined, "artigo real não deve herdar cluster_sources do newsletter_extracted");
    });

    it("artigo normal NÃO clusteriza com newsletter_extracted mesmo que o normal seja processado DEPOIS", () => {
      // Ordem invertida do teste anterior — garante que a checagem funciona
      // tanto quando newsletter_extracted já está no cluster (via `art`)
      // quanto quando é um `member` pré-existente sendo comparado (via loop
      // interno) — os dois early-returns do guard.
      const sameTitle = "Outra coincidência de título entre newsletter e fonte real";
      const articles = [
        { url: "https://ycombinator.com/library/z", title: sameTitle, flag: "newsletter_extracted", summary: "" },
        { url: "https://real-source.com/b", title: sameTitle, source: "The Verge", summary: "resumo real" },
      ];
      const { kept } = dedup(articles, new Set(), 0.85);
      assert.equal(kept.length, 2);
    });

    it("newsletter_extracted com títulos SIMILARES (não idênticos) também não clusterizam entre si", () => {
      const articles = [
        { url: "https://a.com/x", title: '(newsletter:AI Roundup)', flag: "newsletter_extracted", summary: "" },
        { url: "https://b.com/y", title: '(newsletter:AI Roundup Extra)', flag: "newsletter_extracted", summary: "" },
      ];
      const { kept } = dedup(articles, new Set(), 0.85);
      assert.equal(kept.length, 2);
    });
  });
});
