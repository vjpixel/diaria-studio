import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync as rf, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  tokenize,
  jaccard,
  cosineSimilarity,
  clusterArticles,
  clusterArticlesWithEmbeddings,
  rankWithinCluster,
  clusterBucket,
  clusterCategorized,
  aggregateEmbeddingStats,
  resolveEmbeddingModel,
  resolveEmbeddingModelWithDiagnostics,
  embedText,
  DEFAULT_EMBEDDING_MODEL,
  type Article,
  type EmbeddingStats,
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

  it("#679: ambos vazios retorna 1 (sem tokens = semanticamente idênticos)", () => {
    assert.equal(jaccard(new Set(), new Set()), 1);
  });

  it("#679: um vazio e um não-vazio retorna 0", () => {
    assert.equal(jaccard(new Set(["foo"]), new Set()), 0);
    assert.equal(jaccard(new Set(), new Set(["foo"])), 0);
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

  it("processa todos os 4 buckets (#1629)", async () => {
    const input = {
      lancamento: [
        { url: "https://a.com/1", title: "OpenAI anuncia novo modelo GPT-5 com features avançadas", summary: "" },
        { url: "https://b.com/1", title: "OpenAI lança GPT-5 com features", summary: "novo modelo OpenAI GPT-5 features avançadas" },
      ],
      radar: [
        { url: "https://arxiv.org/1", title: "Paper sobre attention routing", summary: "" },
        { url: "https://c.com/1", title: "Regulação de IA no Brasil avança", summary: "" },
      ],
      use_melhor: [
        { url: "https://t.com/1", title: "Tutorial Claude Agents", summary: "" },
      ],
      video: [],
    };
    const result = await clusterCategorized(input, 0.3);
    assert.equal(result.lancamento.length, 1); // GPT-5 cluster colapsou
    assert.equal(result.radar.length, 2);
    assert.equal(result.use_melhor.length, 1); // #1628: agora processa use_melhor/video
    assert.equal(result.video.length, 0);
    assert.equal(result.clusters.length, 1);
    // #4654: embedding_health agregado dos 4 buckets, sem key → nunca reportado como falha.
    assert.equal(result.embedding_health.key_present, false);
    assert.equal(result.embedding_health.failed, 0);
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
    const { clusters } = await clusterArticlesWithEmbeddings(articles, 0.3);
    assert.equal(clusters.length, 1, "artigos similares devem cair no mesmo cluster");
    assert.equal(clusters[0].method, "jaccard");
  });

  it("#4654: sem key, stats.key_present=false — nunca é reportado como falha", async () => {
    const articles: Article[] = [
      { url: "https://a.com/1", title: "OpenAI GPT-5 model release", summary: "" },
    ];
    const { stats } = await clusterArticlesWithEmbeddings(articles, 0.5);
    assert.equal(stats.key_present, false);
    assert.equal(stats.attempted, 0);
    assert.equal(stats.failed, 0);
    assert.equal(stats.fallback_triggered, true);
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
    const { clusters, stats } = await clusterArticlesWithEmbeddings(articles, 0.85);
    assert.equal(clusters.length, 2, "deve produzir 2 clusters");
    assert.equal(clusters[0].members.length, 2, "cluster A+B deve ter 2 membros");
    assert.equal(clusters[0].method, "cosine");
    assert.equal(clusters[1].members.length, 1, "cluster C deve ter 1 membro");
    // #4654: caminho feliz — key presente, tudo respondeu, sem falha reportada.
    assert.equal(stats.key_present, true);
    assert.equal(stats.attempted, 3);
    assert.equal(stats.failed, 0);
    assert.equal(stats.fallback_triggered, false);
  });

  it("#4654: fallback para Jaccard quando TODOS embeddings retornam null (modelo 404/erro de API) — reportado em stats, não só console.warn", async () => {
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ error: { code: 404, message: "model not found" } }), { status: 404 });
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

    // Embeddings retornarão null (404) → cai no Jaccard com threshold=0.5
    const { clusters, stats } = await clusterArticlesWithEmbeddings(articles, 0.85);
    // Com Jaccard esses artigos são dissimilares → 2 clusters
    assert.equal(clusters.length, 2);
    // Fallback total deve usar Jaccard, não cosine
    assert.equal(clusters[0].method, "jaccard");
    // #4654: a falha 100% precisa aparecer em stats — key presente, todos falharam.
    assert.equal(stats.key_present, true);
    assert.equal(stats.attempted, 2);
    assert.equal(stats.failed, 2);
    assert.equal(stats.fail_rate, 1);
    assert.equal(stats.fallback_triggered, true);
  });

  it("#4654: degradação parcial (1 de 2 embeddings falha) fica registrada em stats.failed", async () => {
    let callIndex = 0;
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      callIndex++;
      if (callIndex === 1) {
        return new Response(JSON.stringify({ embedding: { values: [1, 0, 0] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "transient" }), { status: 500 });
    };

    const articles: Article[] = [
      { url: "https://a.com/1", title: "Artigo A", summary: "" },
      { url: "https://b.com/1", title: "Artigo B", summary: "" },
    ];

    const { stats } = await clusterArticlesWithEmbeddings(articles, 0.85);
    assert.equal(stats.key_present, true);
    assert.equal(stats.attempted, 2);
    assert.equal(stats.failed, 1);
    assert.equal(stats.fail_rate, 0.5);
    // Degradação parcial não é "fallback total" (só alguns pares caem em Jaccard).
    assert.equal(stats.fallback_triggered, false);
  });

  it("embedText usa o model passado na URL e no body (não hardcoded text-embedding-004, #4654)", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ embedding: { values: [1, 2, 3] } }), { status: 200 });
    };
    const result = await embedText("texto de teste", "gemini-embedding-001");
    assert.deepEqual(result, [1, 2, 3]);
    assert.ok(capturedUrl.includes("gemini-embedding-001"), `URL deveria conter o model: ${capturedUrl}`);
    assert.ok(!capturedUrl.includes("text-embedding-004"), "URL não deve mais usar o modelo descontinuado");
    assert.ok(capturedBody.includes("gemini-embedding-001"), `body deveria referenciar o model: ${capturedBody}`);
  });
});

describe("resolveEmbeddingModel (#4654)", () => {
  it("lê gemini.embedding_model de platform.config.json quando presente", () => {
    const dir = mkdtempSync(join(tmpdir(), "topic-cluster-cfg-"));
    try {
      writeFileSync(
        join(dir, "platform.config.json"),
        JSON.stringify({ gemini: { embedding_model: "gemini-embedding-2" } }),
        "utf8",
      );
      assert.equal(resolveEmbeddingModel(dir), "gemini-embedding-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cai no default quando platform.config.json não existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "topic-cluster-cfg-missing-"));
    try {
      assert.equal(resolveEmbeddingModel(dir), DEFAULT_EMBEDDING_MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cai no default quando gemini.embedding_model está ausente do config", () => {
    const dir = mkdtempSync(join(tmpdir(), "topic-cluster-cfg-partial-"));
    try {
      writeFileSync(join(dir, "platform.config.json"), JSON.stringify({ gemini: { model: "x" } }), "utf8");
      assert.equal(resolveEmbeddingModel(dir), DEFAULT_EMBEDDING_MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DEFAULT_EMBEDDING_MODEL não é o modelo descontinuado (#4654)", () => {
    assert.notEqual(DEFAULT_EMBEDDING_MODEL, "text-embedding-004");
  });
});

// ─── Achado #2 do fleet review (#4654 fix, 2ª camada) ──────────────────────
// resolveEmbeddingModel() degradava só com console.error — mesmo padrão de
// sinal-perdido-em-stderr que originou o #4654. configError precisa chegar
// até o caller pra ser roteado por logEvent + propagado pro sidecar/gate.
describe("resolveEmbeddingModelWithDiagnostics (#4654 fleet review achado #2)", () => {
  it("configError null quando platform.config.json é lido normalmente", () => {
    const dir = mkdtempSync(join(tmpdir(), "topic-cluster-diag-ok-"));
    try {
      writeFileSync(
        join(dir, "platform.config.json"),
        JSON.stringify({ gemini: { embedding_model: "gemini-embedding-2" } }),
        "utf8",
      );
      const result = resolveEmbeddingModelWithDiagnostics(dir);
      assert.equal(result.model, "gemini-embedding-2");
      assert.equal(result.configError, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo ausente também popula configError — mesmo tratamento pré-existente do catch (ENOENT)", () => {
    // Nota: preserva o comportamento ANTERIOR ao fleet review — o catch já
    // tratava ENOENT igual a JSON inválido (console.error incondicional).
    // Este teste documenta que a propagação de configError não distingue
    // "arquivo não existe" de "arquivo corrompido" — ambos caem no mesmo
    // catch. Isso é aceitável: em produção (`main()` roda de cwd=ROOT do
    // repo) `platform.config.json` sempre existe; a distinção relevante pro
    // achado #2 é key_present/model_used no sidecar, não a causa do ENOENT.
    const dir = mkdtempSync(join(tmpdir(), "topic-cluster-diag-missing-"));
    try {
      const result = resolveEmbeddingModelWithDiagnostics(dir);
      assert.equal(result.model, DEFAULT_EMBEDDING_MODEL);
      assert.ok(result.configError, "ENOENT também é reportado — mesmo catch de antes do fix");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("configError populado quando platform.config.json existe mas é JSON inválido", () => {
    const dir = mkdtempSync(join(tmpdir(), "topic-cluster-diag-corrupt-"));
    try {
      writeFileSync(join(dir, "platform.config.json"), "{ isso não é json", "utf8");
      const result = resolveEmbeddingModelWithDiagnostics(dir);
      assert.equal(result.model, DEFAULT_EMBEDDING_MODEL, "cai no default mesmo com config corrompido");
      assert.ok(result.configError, "configError deve capturar o motivo — não pode ser null aqui");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveEmbeddingModel (wrapper de compat) continua retornando só o model", () => {
    const dir = mkdtempSync(join(tmpdir(), "topic-cluster-diag-wrapper-"));
    try {
      writeFileSync(join(dir, "platform.config.json"), "{ corrompido", "utf8");
      assert.equal(resolveEmbeddingModel(dir), DEFAULT_EMBEDDING_MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("aggregateEmbeddingStats (#4654)", () => {
  it("soma attempted/failed de vários buckets e mantém o model comum", () => {
    const statsList: EmbeddingStats[] = [
      { model: "gemini-embedding-001", key_present: true, attempted: 3, failed: 0, fail_rate: 0, fallback_triggered: false },
      { model: "gemini-embedding-001", key_present: true, attempted: 5, failed: 5, fail_rate: 1, fallback_triggered: true },
    ];
    const agg = aggregateEmbeddingStats(statsList);
    assert.equal(agg.attempted, 8);
    assert.equal(agg.failed, 5);
    assert.equal(agg.fail_rate, 5 / 8);
    assert.equal(agg.key_present, true);
    assert.equal(agg.fallback_triggered, true, "qualquer bucket com fallback total marca o agregado");
    assert.equal(agg.model, "gemini-embedding-001");
  });

  it("bucket vazio (attempted=0) não quebra fail_rate", () => {
    const statsList: EmbeddingStats[] = [
      { model: "gemini-embedding-001", key_present: false, attempted: 0, failed: 0, fail_rate: 0, fallback_triggered: true },
    ];
    const agg = aggregateEmbeddingStats(statsList);
    assert.equal(agg.attempted, 0);
    assert.equal(agg.fail_rate, 0);
    assert.equal(agg.key_present, false);
  });
});

describe("clusterCategorized — legacy shape #1629 (#1671)", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY; // força fallback jaccard (sem network)
  });
  afterEach(() => {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    else delete process.env.GEMINI_API_KEY;
  });

  it("input legacy (pesquisa/noticias/tutorial, sem buckets novos) → não crasha + remapeia pra radar/use_melhor", async () => {
    const legacy = {
      lancamento: [{ url: "https://x/l", title: "Lançamento X", summary: "produto novo" }],
      pesquisa: [{ url: "https://x/p", title: "Paper Y", summary: "estudo sobre Z" }],
      noticias: [{ url: "https://x/n", title: "Notícia W", summary: "cobertura de mercado" }],
      tutorial: [{ url: "https://x/t", title: "Como usar V", summary: "passo a passo" }],
    };
    // Antes do #1671: clusterBucket(input.radar=undefined) → crash no .map.
    const out = await clusterCategorized(legacy as unknown as Parameters<typeof clusterCategorized>[0], 0.85);
    const urls = (b: { url: string }[]) => b.map((a) => a.url).sort();
    assert.deepEqual(urls(out.radar), ["https://x/n", "https://x/p"], "pesquisa+noticias → radar");
    assert.deepEqual(urls(out.use_melhor), ["https://x/t"], "tutorial → use_melhor");
    assert.deepEqual(urls(out.lancamento), ["https://x/l"]);
    assert.deepEqual(out.video, []);
  });
});

describe("topic-cluster CLI main() — legacy shape não crasha (#1671 — site real do bug)", () => {
  it("CLI com categorized.json legacy → exit 0 + output escrito (não crasha em totalIn)", () => {
    const ROOT = resolve(import.meta.dirname, "..");
    const dir = mkdtempSync(join(tmpdir(), "topic-cluster-cli-"));
    try {
      const legacy = {
        lancamento: [{ url: "https://x/l", title: "Lançamento", summary: "produto" }],
        pesquisa: [{ url: "https://x/p", title: "Paper", summary: "estudo" }],
        noticias: [{ url: "https://x/n", title: "Notícia", summary: "mercado" }],
      };
      const inPath = join(dir, "legacy-categorized.json");
      const outPath = join(dir, "clustered.json");
      writeFileSync(inPath, JSON.stringify(legacy), "utf8");
      const env = { ...process.env };
      delete env.GEMINI_API_KEY; // jaccard determinístico, sem network
      const r = spawnSync(
        "npx",
        ["tsx", "scripts/topic-cluster.ts", "--in", inPath, "--out", outPath, "--threshold", "0.5"],
        { cwd: ROOT, env, encoding: "utf8", shell: true, timeout: 120000 },
      );
      assert.equal(r.status, 0, `CLI deve sair 0 (legacy não crasha). stderr: ${r.stderr?.slice(0, 400)}`);
      assert.ok(existsSync(outPath), "output deve ser escrito (não abortado pré-write)");
      const out = JSON.parse(rf(outPath, "utf8"));
      assert.deepEqual(out.radar.map((a: { url: string }) => a.url).sort(), ["https://x/n", "https://x/p"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#4654: escreve sidecar topic-cluster-stats.json junto do --out (embedding_health visível pro validator)", () => {
    const ROOT = resolve(import.meta.dirname, "..");
    const dir = mkdtempSync(join(tmpdir(), "topic-cluster-cli-stats-"));
    try {
      const input = {
        lancamento: [{ url: "https://x/l", title: "Lançamento", summary: "produto" }],
        radar: [],
        use_melhor: [],
        video: [],
      };
      const inPath = join(dir, "categorized.json");
      const outPath = join(dir, "clustered.json");
      writeFileSync(inPath, JSON.stringify(input), "utf8");
      const env = { ...process.env };
      delete env.GEMINI_API_KEY; // sem key — caminho esperado, key_present=false
      const r = spawnSync(
        "npx",
        [
          "tsx", "scripts/topic-cluster.ts",
          "--in", inPath, "--out", outPath, "--threshold", "0.5",
          "--log-root-dir", dir, // #3311: isola o run-log do worktree real
        ],
        { cwd: ROOT, env, encoding: "utf8", shell: true, timeout: 120000 },
      );
      assert.equal(r.status, 0, `CLI deve sair 0. stderr: ${r.stderr?.slice(0, 400)}`);
      const statsPath = join(dir, "topic-cluster-stats.json");
      assert.ok(existsSync(statsPath), "sidecar topic-cluster-stats.json deve ser escrito");
      const stats = JSON.parse(rf(statsPath, "utf8"));
      assert.equal(stats.key_present, false);
      assert.equal(stats.model, "gemini-embedding-001");

      const out = JSON.parse(rf(outPath, "utf8"));
      assert.ok(out.embedding_health, "output principal também carrega embedding_health");
      assert.equal(out.embedding_health.key_present, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Achado #2 do fleet review (#4654 fix, 2ª camada): platform.config.json
  // ilegível não pode degradar só com console.error — precisa ir pro
  // run-log.jsonl e pro sidecar (config_error), pra chegar até o gate.
  it("#4654 achado #2: platform.config.json corrompido loga em run-log.jsonl e marca config_error no sidecar", () => {
    const ROOT = resolve(import.meta.dirname, "..");
    const dir = mkdtempSync(join(tmpdir(), "topic-cluster-cli-cfg-error-"));
    try {
      const input = {
        lancamento: [{ url: "https://x/l", title: "Lançamento", summary: "produto" }],
        radar: [],
        use_melhor: [],
        video: [],
      };
      const inPath = join(dir, "categorized.json");
      const outPath = join(dir, "clustered.json");
      writeFileSync(inPath, JSON.stringify(input), "utf8");
      // platform.config.json corrompido NA RAIZ do worktree — resolveEmbeddingModelWithDiagnostics
      // lê de process.cwd() (= cwd do subprocess = ROOT), não de --log-root-dir.
      // Como não dá pra corromper o platform.config.json real do worktree
      // (compartilhado com outros testes/processos), rodamos o CLI com
      // cwd apontando pro tmpdir e copiamos só o necessário.
      writeFileSync(join(dir, "platform.config.json"), "{ isso não é json válido", "utf8");
      const env = { ...process.env };
      delete env.GEMINI_API_KEY;
      const r = spawnSync(
        "npx",
        [
          "tsx", resolve(ROOT, "scripts/topic-cluster.ts"),
          "--in", inPath, "--out", outPath, "--threshold", "0.5",
          "--log-root-dir", dir,
        ],
        { cwd: dir, env, encoding: "utf8", shell: true, timeout: 120000 },
      );
      assert.equal(r.status, 0, `CLI deve sair 0 mesmo com config corrompido. stderr: ${r.stderr?.slice(0, 400)}`);

      const statsPath = join(dir, "topic-cluster-stats.json");
      const stats = JSON.parse(rf(statsPath, "utf8"));
      assert.ok(stats.config_error, "sidecar deve carregar config_error");
      assert.equal(stats.model, "gemini-embedding-001", "cai no default mesmo com config corrompido");

      const logPath = join(dir, "data", "run-log.jsonl");
      assert.ok(existsSync(logPath), "run-log.jsonl deve ser escrito");
      const lines = rf(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const entry = lines.find((l: { message?: string }) => l.message?.includes("platform.config.json não lido"));
      assert.ok(entry, "evento de config ilegível deve estar no run-log");
      assert.equal(entry.level, "warn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
