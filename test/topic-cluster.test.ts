import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize,
  jaccard,
  clusterArticles,
  rankWithinCluster,
  clusterBucket,
  clusterCategorized,
  type Article,
} from "../scripts/topic-cluster.ts";

describe("tokenize", () => {
  it("normaliza case, remove acentos e tokens curtos", () => {
    const set = tokenize("O Brasil avança em IA");
    assert.ok(set.has("brasil"));
    assert.ok(set.has("avanca"));
    // "em" é stopword → removido
    assert.ok(!set.has("em"));
    // "ia" é TECH_SHORT_TOKEN (#324) → mantido mesmo sendo < 4 chars
    assert.ok(set.has("ia"));
  });

  it("remove stopwords PT/EN", () => {
    const set = tokenize("The future of the Google Gemini model is coming");
    assert.ok(!set.has("the"));
    assert.ok(!set.has("of"));
    assert.ok(!set.has("is"));
    assert.ok(set.has("future"));
    assert.ok(set.has("google"));
    assert.ok(set.has("gemini"));
  });

  it("texto vazio retorna set vazio", () => {
    assert.equal(tokenize("").size, 0);
    assert.equal(tokenize("a o e um").size, 0); // só stopwords
  });
});

describe("jaccard", () => {
  it("conjuntos idênticos = 1", () => {
    const a = new Set(["foo", "bar", "baz"]);
    const b = new Set(["foo", "bar", "baz"]);
    assert.equal(jaccard(a, b), 1);
  });

  it("conjuntos disjuntos = 0", () => {
    const a = new Set(["foo"]);
    const b = new Set(["bar"]);
    assert.equal(jaccard(a, b), 0);
  });

  it("overlap parcial: 2/4 = 0.5", () => {
    const a = new Set(["w", "x"]);
    const b = new Set(["w", "y", "z"]);
    assert.equal(jaccard(a, b), 1 / 4);
  });

  it("ambos vazios retorna 0", () => {
    assert.equal(jaccard(new Set(), new Set()), 0);
  });
});

describe("clusterArticles", () => {
  it("artigos sobre o mesmo evento caem no mesmo cluster", () => {
    const articles: Article[] = [
      {
        url: "https://blog.google/gemini-3-announce",
        title: "Google anuncia Gemini 3 com capacidades multimodais expandidas",
        summary: "Google apresenta Gemini 3 com nova arquitetura multimodal e performance superior.",
      },
      {
        url: "https://techtudo.com.br/gemini-3",
        title: "Google lança Gemini 3 multimodal",
        summary: "O novo modelo Gemini 3 do Google traz capacidades multimodais expandidas.",
      },
    ];
    const clusters = clusterArticles(articles, 0.3);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].members.length, 2);
  });

  it("artigos de temas diferentes ficam em clusters separados", () => {
    const articles: Article[] = [
      {
        url: "https://a.com/1",
        title: "OpenAI lança GPT-5 com capacidades avançadas",
        summary: "OpenAI apresenta GPT-5 modelo linguagem multimodal.",
      },
      {
        url: "https://b.com/1",
        title: "Anthropic publica paper sobre interpretability",
        summary: "Novo estudo Anthropic sobre mechanistic interpretability em redes neurais.",
      },
    ];
    const clusters = clusterArticles(articles, 0.3);
    assert.equal(clusters.length, 2);
  });

  it("threshold alto separa artigos parcialmente similares", () => {
    const articles: Article[] = [
      {
        url: "https://a.com/1",
        title: "OpenAI anuncia parceria com Microsoft",
        summary: "OpenAI Microsoft investimento bilhões.",
      },
      {
        url: "https://b.com/1",
        title: "OpenAI publica paper sobre RLHF",
        summary: "OpenAI nova técnica RLHF alignment.",
      },
    ];
    const strict = clusterArticles(articles, 0.7);
    const loose = clusterArticles(articles, 0.05);
    assert.equal(strict.length, 2);
    assert.equal(loose.length, 1);
  });

  it("artigo único vira cluster solo", () => {
    const articles: Article[] = [
      { url: "https://a.com/1", title: "Único artigo isolado aqui", summary: "" },
    ];
    const clusters = clusterArticles(articles, 0.5);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].members.length, 1);
  });
});

describe("rankWithinCluster", () => {
  it("fonte cadastrada vem antes de discovered", () => {
    const members: Article[] = [
      { url: "https://a.com/1", title: "A", discovered_source: true, score: 90 },
      { url: "https://b.com/1", title: "B", discovered_source: false, score: 70 },
    ];
    const ranked = rankWithinCluster(members);
    assert.equal(ranked[0].url, "https://b.com/1");
  });

  it("score maior vence entre fontes do mesmo tier", () => {
    const members: Article[] = [
      { url: "https://a.com/1", title: "A", score: 75 },
      { url: "https://b.com/1", title: "B", score: 90 },
    ];
    const ranked = rankWithinCluster(members);
    assert.equal(ranked[0].url, "https://b.com/1");
  });

  it("sem score/discovered: mantém ordem original", () => {
    const members: Article[] = [
      { url: "https://a.com/1", title: "A" },
      { url: "https://b.com/1", title: "B" },
    ];
    const ranked = rankWithinCluster(members);
    assert.equal(ranked[0].url, "https://a.com/1");
  });

  it("discovered com score altíssimo ainda perde pra cadastrada", () => {
    const members: Article[] = [
      { url: "https://a.com/1", title: "A", discovered_source: true, score: 99 },
      { url: "https://b.com/1", title: "B", discovered_source: false, score: 50 },
    ];
    const ranked = rankWithinCluster(members);
    assert.equal(ranked[0].url, "https://b.com/1");
  });
});

describe("clusterBucket", () => {
  it("mantém top de cada cluster e captura runners-up na metadata", () => {
    const articles: Article[] = [
      {
        url: "https://blog.google/gemini-3",
        title: "Google anuncia Gemini 3 multimodal capacidades",
        summary: "Google Gemini 3 arquitetura multimodal performance",
        discovered_source: false,
        score: 80,
      },
      {
        url: "https://techtudo.com/gemini-3",
        title: "Google lança Gemini 3 multimodal",
        summary: "Gemini 3 Google capacidades multimodais",
        discovered_source: true,
        score: 70,
      },
      {
        url: "https://anthropic.com/claude-4-7",
        title: "Anthropic anuncia Claude 4.7 com interpretability",
        summary: "Claude 4.7 Anthropic mechanistic interpretability",
        discovered_source: false,
        score: 85,
      },
    ];
    const result = clusterBucket(articles, 0.3);
    assert.equal(result.kept.length, 2); // Gemini cluster colapsou
    assert.equal(result.kept[0].url, "https://blog.google/gemini-3"); // fonte cadastrada
    assert.equal(result.clusters.length, 1);
    assert.equal(result.clusters[0].top_url, "https://blog.google/gemini-3");
    assert.equal(result.clusters[0].member_urls.length, 2);
  });
});

describe("clusterCategorized", () => {
  it("processa os 3 buckets separadamente", () => {
    const input = {
      lancamento: [
        { url: "https://a.com/1", title: "OpenAI anuncia novo modelo GPT-5 com features avançadas", summary: "" },
        { url: "https://b.com/1", title: "OpenAI lança GPT-5 com features", summary: "novo modelo OpenAI GPT-5 features avançadas" },
      ],
      pesquisa: [
        { url: "https://arxiv.org/1", title: "Paper sobre attention routing", summary: "" },
      ],
      noticias: [
        { url: "https://c.com/1", title: "Regulação de IA no Brasil avança", summary: "" },
      ],
    };
    const result = clusterCategorized(input, 0.3);
    assert.equal(result.lancamento.length, 1); // GPT-5 cluster colapsou
    assert.equal(result.pesquisa.length, 1);
    assert.equal(result.noticias.length, 1);
    assert.equal(result.clusters.length, 1);
  });
});
