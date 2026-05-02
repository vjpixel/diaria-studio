import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize,
  jaccard,
  cosineSimilarity,
  clusterArticles,
  clusterArticlesWithEmbeddings,
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

describe("cosineSimilarity", () => {
  it("vetores idênticos retornam 1.0", () => {
    const v = [1, 2, 3];
    assert.equal(cosineSimilarity(v, v), 1.0);
  });

  it("vetores opostos retornam -1.0", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    assert.ok(Math.abs(cosineSimilarity(a, b) - (-1.0)) < 1e-10);
  });

  it("vetores ortogonais retornam 0", () => {
    const a = [1, 0];
    const b = [0, 1];
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-10);
  });

  it("vetores vazios retornam 0 (sem divisão por zero)", () => {
    assert.equal(cosineSimilarity([], []), 0);
  });

  it("similaridade é simétrica", () => {
    const a = [0.5, 0.3, 0.8];
    const b = [0.1, 0.9, 0.2];
    assert.equal(cosineSimilarity(a, b), cosineSimilarity(b, a));
  });
});

describe("clusterBucket (com fallback Jaccard — sem GEMINI_API_KEY)", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });
  afterEach(() => {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    else delete process.env.GEMINI_API_KEY;
  });

  it("mantém top de cada cluster e captura runners-up na metadata", async () => {
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
    const result = await clusterBucket(articles, 0.3);
    assert.equal(result.kept.length, 2); // Gemini cluster colapsou
    assert.equal(result.kept[0].url, "https://blog.google/gemini-3"); // fonte cadastrada
    assert.equal(result.clusters.length, 1);
    assert.equal(result.clusters[0].top_url, "https://blog.google/gemini-3");
    assert.equal(result.clusters[0].member_urls.length, 2);
    assert.equal(result.clusters[0].similarity_method, "jaccard");
  });
});

describe("clusterCategorized (com fallback Jaccard — sem GEMINI_API_KEY)", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });
  afterEach(() => {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    else delete process.env.GEMINI_API_KEY;
  });

  it("processa os 3 buckets separadamente", async () => {
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
    const result = await clusterCategorized(input, 0.3);
    assert.equal(result.lancamento.length, 1); // GPT-5 cluster colapsou
    assert.equal(result.pesquisa.length, 1);
    assert.equal(result.noticias.length, 1);
    assert.equal(result.clusters.length, 1);
  });
});

describe("clusterArticlesWithEmbeddings — fallback Jaccard quando GEMINI_API_KEY ausente", () => {
  let savedKey: string | undefined;
  let fetchCalled = false;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    savedFetch = globalThis.fetch;
    // Mock fetch to detect if it's called despite no key
    globalThis.fetch = async (..._args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return new Response(JSON.stringify({}), { status: 200 });
    };
    fetchCalled = false;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    else delete process.env.GEMINI_API_KEY;
  });

  it("não chama a API quando GEMINI_API_KEY não está definida", async () => {
    const articles: Article[] = [
      { url: "https://a.com/1", title: "OpenAI GPT-5 model release", summary: "OpenAI novo modelo" },
      { url: "https://b.com/1", title: "Anthropic Claude update", summary: "Anthropic novo modelo" },
    ];
    await clusterArticlesWithEmbeddings(articles, 0.5);
    assert.equal(fetchCalled, false, "fetch não deve ser chamado sem GEMINI_API_KEY");
  });

  it("usa Jaccard e clusteriza corretamente sem API", async () => {
    const articles: Article[] = [
      {
        url: "https://a.com/1",
        title: "Google anuncia Gemini 3 multimodal capacidades novas",
        summary: "Google Gemini 3 performance multimodal",
      },
      {
        url: "https://b.com/1",
        title: "Google lança Gemini 3 com capacidades multimodais",
        summary: "Novo Gemini 3 Google multimodal arquitetura",
      },
    ];
    const clusters = await clusterArticlesWithEmbeddings(articles, 0.3);
    assert.equal(clusters.length, 1, "artigos similares devem cair no mesmo cluster");
    assert.equal(clusters[0].method, "jaccard");
  });
});

describe("clusterArticlesWithEmbeddings — caminho com embeddings (fetch mockado)", () => {
  let savedKey: string | undefined;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "fake-key-for-test";
    savedFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    else delete process.env.GEMINI_API_KEY;
  });

  it("agrupa artigos com embeddings similares e separa dissimilares", async () => {
    // Artigos A e B → vetores quase idênticos (sim alta)
    // Artigo C → vetor ortogonal (sim baixa com A e B)
    const vecA = [1, 0, 0];
    const vecB = [0.99, 0.1, 0.0]; // cos sim com A ≈ 0.995
    const vecC = [0, 1, 0];       // cos sim com A = 0, com B ≈ 0.1

    const embeddings = [vecA, vecB, vecC];
    let callIndex = 0;

    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      const emb = embeddings[callIndex++];
      return new Response(
        JSON.stringify({ embedding: { values: emb } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const articles: Article[] = [
      { url: "https://a.com/1", title: "Artigo A", summary: "" },
      { url: "https://b.com/1", title: "Artigo B", summary: "" },
      { url: "https://c.com/1", title: "Artigo C", summary: "" },
    ];

    // Threshold 0.85 → A e B (cos≈0.995) agrupados; C separado
    const clusters = await clusterArticlesWithEmbeddings(articles, 0.85);
    assert.equal(clusters.length, 2, "deve produzir 2 clusters");
    assert.equal(clusters[0].members.length, 2, "cluster A+B deve ter 2 membros");
    assert.equal(clusters[0].method, "cosine");
    assert.equal(clusters[1].members.length, 1, "cluster C deve ter 1 membro");
  });

  it("fallback para Jaccard quando todos embeddings retornam null (erro de API)", async () => {
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ error: "API error" }), { status: 500 });
    };

    const articles: Article[] = [
      {
        url: "https://a.com/1",
        title: "Google Gemini multimodal capacidades lançamento",
        summary: "Google Gemini novo modelo multimodal",
      },
      {
        url: "https://b.com/1",
        title: "Anthropic Claude interpretability paper",
        summary: "Anthropic research mechanistic interpretability",
      },
    ];

    // Embeddings retornarão null (500 error) → cai no Jaccard com threshold=0.5
    const clusters = await clusterArticlesWithEmbeddings(articles, 0.85);
    // Com Jaccard esses artigos são dissimilares → 2 clusters
    assert.equal(clusters.length, 2);
    // Fallback total deve usar Jaccard, não cosine
    assert.equal(clusters[0].method, "jaccard");
  });
});
