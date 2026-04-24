import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { categorize, type Article } from "../scripts/categorize.ts";

describe("categorize() — regras de domínio", () => {
  it("classifica anúncio oficial da OpenAI como lancamento", () => {
    const art: Article = { url: "https://openai.com/index/introducing-gpt-5/" };
    assert.equal(categorize(art), "lancamento");
  });

  it("classifica news da Anthropic como lancamento (via pattern)", () => {
    const art: Article = { url: "https://anthropic.com/news/claude-4-5-sonnet" };
    assert.equal(categorize(art), "lancamento");
  });

  it("classifica blog da Hugging Face como lancamento", () => {
    const art: Article = { url: "https://huggingface.co/blog/cool-model" };
    assert.equal(categorize(art), "lancamento");
  });

  it("classifica paper arxiv como pesquisa", () => {
    const art: Article = { url: "https://arxiv.org/abs/2501.12345" };
    assert.equal(categorize(art), "pesquisa");
  });

  it("classifica huggingface.co/papers como pesquisa (mesmo domínio do blog)", () => {
    const art: Article = { url: "https://huggingface.co/papers/2501.12345" };
    assert.equal(categorize(art), "pesquisa");
  });

  it("classifica anthropic.com/research como pesquisa (prioridade sobre lancamento)", () => {
    const art: Article = { url: "https://anthropic.com/research/some-paper" };
    assert.equal(categorize(art), "pesquisa");
  });

  it("classifica openai.com/research como pesquisa (prioridade sobre lancamento)", () => {
    const art: Article = { url: "https://openai.com/research/some-paper" };
    assert.equal(categorize(art), "pesquisa");
  });

  it("usa type_hint='pesquisa' quando domínio não é reconhecido", () => {
    const art: Article = {
      url: "https://some-unknown-lab.example/paper",
      type_hint: "pesquisa",
    };
    assert.equal(categorize(art), "pesquisa");
  });

  it("cai em noticias por default (cobertura jornalística)", () => {
    const art: Article = { url: "https://techcrunch.com/2026/04/some-story" };
    assert.equal(categorize(art), "noticias");
  });

  it("cai em noticias quando URL é cobertura secundária (não domínio oficial)", () => {
    const art: Article = {
      url: "https://theverge.com/openai-announces-gpt5",
      type_hint: "lancamento",
    };
    assert.equal(categorize(art), "noticias");
  });

  it("lida com www. no hostname", () => {
    const art: Article = { url: "https://www.openai.com/blog/something" };
    assert.equal(categorize(art), "lancamento");
  });

  it("URL inválida cai em noticias sem crashar", () => {
    const art: Article = { url: "not-a-url" };
    assert.equal(categorize(art), "noticias");
  });
});

describe("categorize() — business deal override (#77)", () => {
  it("expands partnership em domínio lancamento vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/amazon-deal",
        title: "Anthropic expands partnership with Amazon in $4 billion deal",
      }),
      "noticias",
    );
  });

  it("acquires/acquisition em domínio lancamento vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/news/global-illumination",
        title: "OpenAI acquires Global Illumination team",
      }),
      "noticias",
    );
  });

  it("PT-BR: aquisição / parceria expandida", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/news/adquire-x",
        title: "Google adquire startup brasileira por 100 milhões",
      }),
      "noticias",
    );
  });

  it("investimento bilionário com numeral + keyword", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/news/deal",
        title: "Microsoft announces $10 billion investment in AI infrastructure",
      }),
      "noticias",
    );
  });

  it("gigawatts de compute (contrato de infra) vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/news/chile-deal",
        title: "OpenAI signs deal for 5 gigawatts of new compute capacity",
      }),
      "noticias",
    );
  });

  it("multi-year agreement vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/multi-year",
        title: "Multi-year agreement with enterprise customer announced",
      }),
      "noticias",
    );
  });

  it("strategic agreement vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/strategic",
        title: "Strategic agreement for cloud partnership",
      }),
      "noticias",
    );
  });

  it("lancamento normal (sem deal pattern) continua lancamento", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/claude-4-7",
        title: "Anthropic announces Claude 4.7 with improved reasoning",
      }),
      "lancamento",
    );
  });

  it("deal em domínio não-lancamento continua noticias (default)", () => {
    assert.equal(
      categorize({
        url: "https://techcrunch.com/openai-microsoft-deal",
        title: "OpenAI Microsoft $10 billion investment",
      }),
      "noticias",
    );
  });
});

describe("categorize() — non-product announcement override (#77)", () => {
  it("scholars program vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/anthropic-scholars-2026",
        title: "Announcing Anthropic Scholars program 2026",
      }),
      "noticias",
    );
  });

  it("research grants vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/news/research-grants",
        title: "Launching $1M in research grants for academic researchers",
      }),
      "noticias",
    );
  });

  it("Apple scholars vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://machinelearning.apple.com/apple-scholars",
        title: "Apple Scholars in AI/ML 2026",
      }),
      "noticias",
    );
  });

  it("fellowship announcement vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/fellowships",
        title: "Announcing Google PhD fellowship program for 2026",
      }),
      "noticias",
    );
  });

  it("PT-BR: programa de bolsas vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/bolsas-br",
        title: "Anthropic announces bolsas para pesquisadores brasileiros",
      }),
      "noticias",
    );
  });

  it("compute grants vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/compute",
        title: "Launching compute grants for researchers",
      }),
      "noticias",
    );
  });
});

describe("categorize() — patterns específicos (#77)", () => {
  it("aws.amazon.com/blogs/ → lancamento via pattern", () => {
    assert.equal(
      categorize({
        url: "https://aws.amazon.com/blogs/machine-learning/post-x",
      }),
      "lancamento",
    );
  });

  it("perplexity.ai/hub/ → lancamento", () => {
    assert.equal(
      categorize({ url: "https://perplexity.ai/hub/new-feature" }),
      "lancamento",
    );
  });

  it("research.perplexity.ai/ → pesquisa", () => {
    assert.equal(
      categorize({ url: "https://research.perplexity.ai/paper-x" }),
      "pesquisa",
    );
  });

  it("developer.nvidia.com/blog/ → lancamento", () => {
    assert.equal(
      categorize({ url: "https://developer.nvidia.com/blog/tensorrt-update" }),
      "lancamento",
    );
  });

  it("ai.meta.com/blog/ → lancamento", () => {
    assert.equal(
      categorize({ url: "https://ai.meta.com/blog/llama-update" }),
      "lancamento",
    );
  });

  it("ai.meta.com/research/ → pesquisa (path específico)", () => {
    assert.equal(
      categorize({ url: "https://ai.meta.com/research/publications/paper" }),
      "pesquisa",
    );
  });

  it("cloud.google.com/blog/ → lancamento", () => {
    assert.equal(
      categorize({ url: "https://cloud.google.com/blog/products/ai-ml/gemini-update" }),
      "lancamento",
    );
  });

  it("nature.com → pesquisa via domain", () => {
    assert.equal(
      categorize({ url: "https://nature.com/articles/s41586-x" }),
      "pesquisa",
    );
  });

  it("openreview.net → pesquisa", () => {
    assert.equal(
      categorize({ url: "https://openreview.net/forum?id=xyz" }),
      "pesquisa",
    );
  });

  it("arxiv.org/pdf/ → pesquisa via pattern", () => {
    assert.equal(
      categorize({ url: "https://arxiv.org/pdf/2501.12345.pdf" }),
      "pesquisa",
    );
  });
});

describe("categorize() — ordem de precedência (#77)", () => {
  it("pesquisa tem precedência sobre lancamento (mesmo domínio)", () => {
    // anthropic.com é LANCAMENTO_PATTERN mas /research/ é PESQUISA_PATTERN
    assert.equal(
      categorize({ url: "https://anthropic.com/research/paper" }),
      "pesquisa",
    );
  });

  it("research path override vence deal keyword em research paper", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/research/deal-analysis",
        title: "Research on strategic agreement safety",
      }),
      "pesquisa",
    );
  });

  it("deal pattern sem domínio oficial não override (já é noticias)", () => {
    assert.equal(
      categorize({
        url: "https://theverge.com/microsoft-deal",
        title: "Microsoft announces $10 billion acquisition",
      }),
      "noticias",
    );
  });
});
