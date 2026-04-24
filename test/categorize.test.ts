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

describe("categorize() — bucket tutorial (#59 slice 2)", () => {
  it("simonwillison.net → tutorial (dedicated domain)", () => {
    assert.equal(
      categorize({ url: "https://simonwillison.net/2026/Jan/15/llm-tools/" }),
      "tutorial",
    );
  });

  it("huggingface.co/learn/ → tutorial", () => {
    assert.equal(
      categorize({ url: "https://huggingface.co/learn/nlp-course/chapter1" }),
      "tutorial",
    );
  });

  it("github.com/anthropics/anthropic-cookbook → tutorial", () => {
    assert.equal(
      categorize({
        url: "https://github.com/anthropics/anthropic-cookbook/blob/main/skills/index.ipynb",
      }),
      "tutorial",
    );
  });

  it("deeplearning.ai/the-batch/ → tutorial", () => {
    assert.equal(
      categorize({ url: "https://deeplearning.ai/the-batch/issue-123" }),
      "tutorial",
    );
  });

  it("www.deeplearning.ai/ funciona (www stripping)", () => {
    // www. é removido em hostAndPath, então o pattern sem www deve matchar
    assert.equal(
      categorize({ url: "https://www.deeplearning.ai/the-batch/issue-123" }),
      "tutorial",
    );
  });

  it("latent.space → tutorial", () => {
    assert.equal(
      categorize({ url: "https://www.latent.space/p/agent-eng" }),
      "tutorial",
    );
  });

  it("every.to/chain-of-thought → tutorial", () => {
    assert.equal(
      categorize({ url: "https://every.to/chain-of-thought/my-article" }),
      "tutorial",
    );
  });

  it("título 'How to build X' → tutorial via keyword", () => {
    assert.equal(
      categorize({
        url: "https://blog.medium.com/post-123",
        title: "How to build a RAG system with Claude",
      }),
      "tutorial",
    );
  });

  it("'Passo a passo' em PT → tutorial", () => {
    assert.equal(
      categorize({
        url: "https://randomblog.com/post",
        title: "Guia passo a passo: fine-tune de modelos",
      }),
      "tutorial",
    );
  });

  it("'Tutorial:' no título → tutorial", () => {
    assert.equal(
      categorize({
        url: "https://randomblog.com/post",
        title: "Tutorial: deploying LLMs with vLLM",
      }),
      "tutorial",
    );
  });

  it("título 'cookbook' → tutorial", () => {
    assert.equal(
      categorize({
        url: "https://randomblog.com/post",
        title: "LLM cookbook: prompts que funcionam",
      }),
      "tutorial",
    );
  });

  describe("precedência tutorial vs pesquisa", () => {
    it("arxiv paper com 'Tutorial on X' vence como PESQUISA (não tutorial)", () => {
      // Papers acadêmicos com "Tutorial" no título vão pra pesquisa
      // porque arxiv é domínio pesquisa dedicado (precedência #77/#59).
      assert.equal(
        categorize({
          url: "https://arxiv.org/abs/2310.12345",
          title: "A Tutorial on Diffusion Models for LLMs",
        }),
        "pesquisa",
      );
    });

    it("huggingface.co/papers/ com 'tutorial' → pesquisa", () => {
      assert.equal(
        categorize({
          url: "https://huggingface.co/papers/2401.12345",
          title: "Tutorial on Mechanistic Interpretability",
        }),
        "pesquisa",
      );
    });

    it("nature.com com 'how to' → pesquisa", () => {
      assert.equal(
        categorize({
          url: "https://nature.com/articles/s41586-x",
          title: "How to train better language models",
        }),
        "pesquisa",
      );
    });
  });

  describe("keyword detection conservadora (não false-positive)", () => {
    it("'How X reduces Y' (sem build/create/deploy) NÃO é tutorial", () => {
      // regex exige how-to seguido de verbo acionável (build|create|deploy|train|fine-tune|implement|use)
      assert.equal(
        categorize({
          url: "https://techcrunch.com/x",
          title: "How OpenAI reduces costs in 2026",
        }),
        "noticias",
      );
    });

    it("'Getting started' sozinho NÃO é tutorial (removido da regex por ser genérico)", () => {
      assert.equal(
        categorize({
          url: "https://techcrunch.com/x",
          title: "Getting started with AI adoption is harder than you think",
        }),
        "noticias",
      );
    });

    it("Press release com 'Get Started today' NÃO é tutorial", () => {
      assert.equal(
        categorize({
          url: "https://techcrunch.com/x",
          title: "New AI feature launched — get started today",
        }),
        "noticias",
      );
    });
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
