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
  //
  // Revisado (finding 3 do self-review, #4102): a exclusão é por CONTEÚDO do
  // título ATUAL (isPlaceholderHighlightTitle), não pela flag
  // `newsletter_extracted` — a flag nunca é removida pelo enrich, então
  // checar só a flag excluía do clustering PERMANENTEMENTE todo artigo
  // newsletter_extracted, mesmo já enriquecido com título real (perdendo o
  // bônus de cobertura e o bloco "Aprofunde:" pra sempre, não só quando o
  // enrichment falha). Os testes abaixo cobrem os dois lados: título AINDA
  // placeholder → isolado; título JÁ enriquecido (real) → participa normal.
  describe("newsletter_extracted nunca clusteriza ENQUANTO título for placeholder (#4102)", () => {
    it("2 artigos newsletter_extracted com título placeholder idêntico NÃO clusterizam entre si", () => {
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

    it("artigo newsletter_extracted com título AINDA placeholder NÃO vira membro do cluster de um artigo normal", () => {
      const articles = [
        { url: "https://real-source.com/a", title: "Notícia real sobre IA generativa", source: "TechCrunch", summary: "resumo real" },
        { url: "https://ycombinator.com/library/y", title: '(newsletter:"Lenny\'s Newsletter")', flag: "newsletter_extracted", summary: "" },
      ];
      const { kept } = dedup(articles, new Set(), 0.85);
      assert.equal(kept.length, 2, "título placeholder não pode clusterizar com o artigo real");
      const real = kept.find((a) => a.url === "https://real-source.com/a");
      assert.equal(real?.cluster_sources, undefined);
    });

    it("newsletter_extracted com títulos placeholder SIMILARES (não idênticos) também não clusterizam entre si", () => {
      const articles = [
        { url: "https://a.com/x", title: '(newsletter:AI Roundup)', flag: "newsletter_extracted", summary: "" },
        { url: "https://b.com/y", title: '(newsletter:AI Roundup Extra)', flag: "newsletter_extracted", summary: "" },
      ];
      const { kept } = dedup(articles, new Set(), 0.85);
      assert.equal(kept.length, 2);
    });
  });

  describe("newsletter_extracted JÁ ENRIQUECIDO (título real) participa do clustering normalmente (#4102 finding 3)", () => {
    it("2 artigos newsletter_extracted com título REAL idêntico (pós-enrich) clusterizam normalmente", () => {
      const sameTitle = "OpenAI anuncia novo modelo de raciocínio";
      const articles = [
        { url: "https://ycombinator.com/library/z", title: sameTitle, flag: "newsletter_extracted", source: "YC Digest", summary: "b".repeat(120) },
        { url: "https://real-source.com/b", title: sameTitle, flag: "newsletter_extracted", source: "The Verge", summary: "a".repeat(400) },
      ];
      const { kept } = dedup(articles, new Set(), 0.85);
      assert.equal(kept.length, 1, "título real idêntico deve clusterizar mesmo com a flag newsletter_extracted presente");
      assert.equal(kept[0].cluster_sources?.length, 1);
    });

    it("newsletter_extracted já enriquecido (título real) clusteriza com artigo normal da mesma história", () => {
      const sameTitle = "OpenAI anuncia novo modelo de raciocínio";
      const articles = [
        { url: "https://real-source.com/a", title: sameTitle, source: "TechCrunch", summary: "resumo real e completo".repeat(5) },
        { url: "https://ycombinator.com/library/y", title: sameTitle, flag: "newsletter_extracted", source: "YC", summary: "curto" },
      ];
      const { kept } = dedup(articles, new Set(), 0.85);
      assert.equal(kept.length, 1, "newsletter_extracted enriquecido deve se fundir com o artigo real da mesma história");
      assert.equal(kept[0].cluster_sources?.length, 1);
    });

    it("ordem invertida (newsletter_extracted enriquecido processado ANTES) também clusteriza", () => {
      const sameTitle = "Outra história coberta por múltiplas fontes";
      const articles = [
        { url: "https://ycombinator.com/library/w", title: sameTitle, flag: "newsletter_extracted", source: "YC", summary: "curto" },
        { url: "https://real-source.com/c", title: sameTitle, source: "The Verge", summary: "resumo real e completo".repeat(5) },
      ];
      const { kept } = dedup(articles, new Set(), 0.85);
      assert.equal(kept.length, 1);
    });
  });

});
