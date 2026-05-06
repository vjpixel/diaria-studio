import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { categorize, isVideoUrl, isArxivRelevant, categorizeArticles, isUnresolvableInboxArticle, type Article } from "../scripts/categorize.ts";

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

  it("classifica paper arxiv de ML como pesquisa (#501: exige tema relevante)", () => {
    // #501: arXiv precisa ter tema relevante (LLM/ML) para ser pesquisa.
    const art: Article = { url: "https://arxiv.org/abs/2501.12345", title: "Scaling Laws for Large Language Models" };
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

  // #164 — rodadas em milhões e valuations
  it("rodada em $30M (Series B) em domínio lancamento vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://comfyui.org/blog/series-b",
        title: "ComfyUI raises $30M Series B as creators seek control",
      }),
      "noticias",
    );
  });

  it("captação em PT (50 milhões) vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://startup.com.br/blog/seed",
        title: "Startup brasileira captou R$ 50 milhões em rodada seed",
      }),
      "noticias",
    );
  });

  it("valuation $500M (hits ... valuation) vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://comfyui.org/news/valuation",
        title: "ComfyUI hits $500M valuation as creators seek more control",
      }),
      "noticias",
    );
  });

  it("IPO vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/news/ipo",
        title: "OpenAI files to go public in record IPO",
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
  it("aws.amazon.com/blogs/machine-learning/ → tutorial (não lancamento) (#318)", () => {
    // AWS ML Blog é historicamente tutoriais/case studies, não anúncios de produto.
    assert.equal(
      categorize({
        url: "https://aws.amazon.com/blogs/machine-learning/post-x",
      }),
      "tutorial",
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

  it("arxiv.org/pdf/ com tema ML → pesquisa via pattern (#501)", () => {
    // #501: arXiv via pattern também precisa de tema relevante para ser pesquisa.
    assert.equal(
      categorize({ url: "https://arxiv.org/pdf/2501.12345.pdf", title: "Attention Is All You Need: Revisiting Neural Network Architectures" }),
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

describe("categorize() — UPDATE_PATTERNS e TUTORIAL extras (#318)", () => {
  it("'An update on our election safeguards' (anthropic.com) → noticias", () => {
    assert.equal(
      categorize({ url: "https://www.anthropic.com/news/election-safeguards", title: "An update on our election safeguards" }),
      "noticias",
    );
  });

  it("'Migrating a text agent to a voice assistant' (AWS ML) → tutorial", () => {
    assert.equal(
      categorize({ url: "https://aws.amazon.com/blogs/machine-learning/migrating-a-text-agent/", title: "Migrating a text agent to a voice assistant" }),
      "tutorial",
    );
  });

  it("'How Popsa used Amazon Nova to inspire customers' (AWS ML) → tutorial", () => {
    assert.equal(
      categorize({ url: "https://aws.amazon.com/blogs/machine-learning/how-popsa-used-amazon-nova/", title: "How Popsa used Amazon Nova to inspire customers" }),
      "tutorial",
    );
  });

  it("'Claude for Creative Work' (anthropic.com) continua lancamento", () => {
    assert.equal(
      categorize({ url: "https://www.anthropic.com/news/claude-for-creative-work", title: "Claude for Creative Work" }),
      "lancamento",
    );
  });

  it("release notes → noticias (UPDATE_PATTERNS)", () => {
    assert.equal(
      categorize({ url: "https://openai.com/news/release-notes-v2", title: "GPT-5 release notes for developers" }),
      "noticias",
    );
  });
});

describe("categorize() — UPDATE_PATTERNS aniversário e expansão incremental (#486)", () => {
  it("'AI Max Turns 1' em domínio oficial → noticias (aniversário)", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/news/ai-max-turns-1",
        title: "AI Max Turns 1",
      }),
      "noticias",
    );
  });

  it("'3 years of Claude' em domínio oficial → noticias (aniversário)", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/3-years-of-claude",
        title: "3 years of Claude",
      }),
      "noticias",
    );
  });

  it("'Gemini turns 2' em domínio oficial → noticias (aniversário)", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/products/gemini/gemini-turns-2",
        title: "Gemini turns 2",
      }),
      "noticias",
    );
  });

  it("'expansion to more countries' em domínio oficial → noticias", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/news/expansion-countries",
        title: "ChatGPT expansion to more countries",
      }),
      "noticias",
    );
  });

  it("'expansion to new markets' em domínio oficial → noticias", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/new-markets",
        title: "Claude expansion to new enterprise markets",
      }),
      "noticias",
    );
  });

  it("lançamento real sem aniversário continua lancamento", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/blog/gpt-5",
        title: "Introducing GPT-5",
      }),
      "lancamento",
    );
  });
});

describe("categorize() — pesquisa em domínio oficial (#486)", () => {
  it("'Toward a theory of mind' em openai.com → pesquisa", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/blog/toward-a-theory-of-mind",
        title: "Toward a theory of mind in language models",
      }),
      "pesquisa",
    );
  });

  it("'Exploring chain-of-thought' em anthropic.com → pesquisa", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/exploring-chain-of-thought",
        title: "Exploring chain-of-thought prompting",
      }),
      "pesquisa",
    );
  });

  it("'A study on hallucination' em deepmind.com → pesquisa", () => {
    assert.equal(
      categorize({
        url: "https://deepmind.com/research/study-hallucination",
        title: "A study on hallucination in large language models",
      }),
      "pesquisa",
    );
  });

  it("'Path to AGI' em openai.com/blog → pesquisa", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/blog/path-to-agi",
        title: "Path to AGI: milestones and reflections",
      }),
      "pesquisa",
    );
  });

  it("anúncio real sem keyword research continua lancamento", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/blog/gpt-5-launch",
        title: "Introducing GPT-5 with advanced reasoning",
      }),
      "lancamento",
    );
  });
});

describe("categorize() — blog.google tutorial via slug imperativo (#486)", () => {
  it("blog.google/…/how-to-use-gemini → tutorial", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/technology/how-to-use-gemini-for-work",
      }),
      "tutorial",
    );
  });

  it("blog.google/…/tips-for-using-ai → tutorial", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/products/ai/tips-for-using-ai-at-work",
      }),
      "tutorial",
    );
  });

  it("blog.google/…/get-started-with-gemini → tutorial", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/outreach-initiatives/get-started-with-ai-for-schools",
      }),
      "tutorial",
    );
  });

  it("blog.google/products/gemini/gemini-update → lancamento (sem slug imperativo, título sem trigger de isUpdate)", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/products/gemini/gemini-2-0-flash-release",
        title: "Gemini 2.0 Flash release",
      }),
      "lancamento",
    );
  });

  it("blog.google/products/gemini/introducing-gemini → lancamento real", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/products/gemini/introducing-gemini-ultra",
        title: "Introducing Gemini Ultra",
      }),
      "lancamento",
    );
  });
});

describe("categorize() — bucket video (#359)", () => {
  it("youtube.com/watch → video", () => {
    assert.equal(
      categorize({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
      "video",
    );
  });

  it("youtu.be shortlink → video", () => {
    assert.equal(
      categorize({ url: "https://youtu.be/dQw4w9WgXcQ" }),
      "video",
    );
  });

  it("vimeo.com → video", () => {
    assert.equal(
      categorize({ url: "https://vimeo.com/123456789" }),
      "video",
    );
  });

  it("youtube.com sem /watch (canal, playlist) → noticias (não video)", () => {
    // Canais e playlists do YouTube sem /watch não são vídeos diretos
    assert.equal(
      categorize({ url: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw" }),
      "noticias",
    );
  });

  it("video tem precedência absoluta — mesmo se título parece lancamento", () => {
    assert.equal(
      categorize({
        url: "https://www.youtube.com/watch?v=abc123",
        title: "OpenAI announces GPT-5",
      }),
      "video",
    );
  });

  it("video tem precedência sobre tutorial keywords", () => {
    assert.equal(
      categorize({
        url: "https://www.youtube.com/watch?v=abc123",
        title: "Tutorial: how to build a RAG system",
      }),
      "video",
    );
  });
});

describe("isVideoUrl (#359)", () => {
  it("youtube.com/watch → true", () => {
    assert.ok(isVideoUrl("https://www.youtube.com/watch?v=abc"));
  });

  it("youtu.be → true", () => {
    assert.ok(isVideoUrl("https://youtu.be/abc"));
  });

  it("vimeo.com → true", () => {
    assert.ok(isVideoUrl("https://vimeo.com/123456789"));
  });

  it("youtube.com sem /watch → false", () => {
    assert.equal(isVideoUrl("https://youtube.com/channel/UCabc"), false);
  });

  it("techcrunch.com → false", () => {
    assert.equal(isVideoUrl("https://techcrunch.com/article"), false);
  });

  it("URL inválida → false (sem crash)", () => {
    assert.equal(isVideoUrl("not-a-url"), false);
  });
});

describe("isArxivRelevant (#501) — filtro arXiv por tema", () => {
  it("artigo não-arXiv sempre passa (retorna true)", () => {
    assert.ok(isArxivRelevant({ url: "https://techcrunch.com/article", title: "Unrelated" }));
  });

  it("arXiv com 'language model' no título → relevante", () => {
    assert.ok(isArxivRelevant({ url: "https://arxiv.org/abs/2501.00001", title: "Improving Language Model Alignment" }));
  });

  it("arXiv com 'LLM' → relevante", () => {
    assert.ok(isArxivRelevant({ url: "https://arxiv.org/abs/2501.00002", title: "LLM-based Code Generation" }));
  });

  it("arXiv com 'transformer' → relevante", () => {
    assert.ok(isArxivRelevant({ url: "https://arxiv.org/abs/2501.00003", title: "Efficient Transformer Architectures" }));
  });

  it("arXiv com 'diffusion' → relevante", () => {
    assert.ok(isArxivRelevant({ url: "https://arxiv.org/abs/2501.00004", title: "Diffusion Models for Image Synthesis" }));
  });

  it("arXiv com 'natural language' no summary → relevante (summary conta)", () => {
    assert.ok(isArxivRelevant({ url: "https://arxiv.org/abs/2501.00005", title: "A Study", summary: "We apply natural language processing techniques" }));
  });

  it("arXiv off-topic (física) → não relevante", () => {
    assert.equal(isArxivRelevant({ url: "https://arxiv.org/abs/2501.99999", title: "Quantum Field Theory and Gravitational Waves", summary: "We compute scattering amplitudes in QFT." }), false);
  });

  it("arXiv off-topic (biologia — sem deep learning) → não relevante", () => {
    assert.equal(isArxivRelevant({ url: "https://arxiv.org/abs/2501.88888", title: "E. coli Ribosome Structure Under Thermal Stress", summary: "We study ribosome dynamics at high temperature." }), false);
  });

  it("arXiv 'protein' com 'deep learning' no título → relevante (drug discovery)", () => {
    assert.ok(isArxivRelevant({ url: "https://arxiv.org/abs/2501.77777", title: "Protein Structure Prediction via Deep Learning" }));
  });

  it("arXiv sem título nem summary → não relevante (conteúdo vazio não passa)", () => {
    assert.equal(isArxivRelevant({ url: "https://arxiv.org/abs/2501.11111" }), false);
  });
});

describe("categorize() — arXiv off-topic vai para noticias (#501)", () => {
  it("arXiv paper de física → noticias (off-topic descartado de pesquisa)", () => {
    assert.equal(
      categorize({ url: "https://arxiv.org/abs/2501.99990", title: "Gravitational Wave Detection with LIGO", summary: "We present new methods for GW detection." }),
      "noticias",
    );
  });

  it("arXiv paper de ML → pesquisa (passa o filtro)", () => {
    assert.equal(
      categorize({ url: "https://arxiv.org/abs/2501.99991", title: "Scaling Laws for Language Models" }),
      "pesquisa",
    );
  });

  it("arXiv paper com 'deep learning' → pesquisa", () => {
    assert.equal(
      categorize({ url: "https://arxiv.org/abs/2501.99992", title: "Deep Learning for Climate Prediction" }),
      "pesquisa",
    );
  });
});


// ---------------------------------------------------------------------------
// Edge cases: precedencia, dominios ambiguos e casos limite (#534)
// // #534-edge-cases-appended
// ---------------------------------------------------------------------------

describe("categorize() -- edge cases: UPDATE_PATTERNS vs RESEARCH_IN_LAUNCH_DOMAIN (#534)", () => {
  it("An update on research toward AGI em openai.com -> noticias", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/blog/update-on-research-toward-agi",
        title: "An update on our research toward AGI",
      }),
      "noticias",
    );
  });

  it("Update: exploring path to AGI em anthropic.com -> noticias", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/update-exploring-path-to-agi",
        title: "Update: exploring path to AGI",
      }),
      "noticias",
    );
  });

  it("Introducing GPT-5: path to AGI em openai.com -> pesquisa (RESEARCH, sem UPDATE)", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/blog/introducing-gpt5-path-to-agi",
        title: "Introducing GPT-5: path to AGI",
      }),
      "pesquisa",
    );
  });

  it("Researching the path toward AI co-clinician em deepmind.google -> pesquisa", () => {
    assert.equal(
      categorize({
        url: "https://deepmind.google/blog/researching-path-toward-ai-co-clinician",
        title: "Researching the path toward AI co-clinician",
      }),
      "pesquisa",
    );
  });

  it("Exploring multimodal agents em openai.com -> pesquisa (RESEARCH_IN_LAUNCH_DOMAIN)", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/blog/exploring-multimodal-agents",
        title: "Exploring multimodal agents",
      }),
      "pesquisa",
    );
  });

  it("Introducing GPT-5 em openai.com -> lancamento (sem keyword research ou update)", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/blog/introducing-gpt-5",
        title: "Introducing GPT-5",
      }),
      "lancamento",
    );
  });
});

describe("categorize() -- edge cases: TUTORIAL_DOMAIN_EXTRA antes de LANCAMENTO (#534)", () => {
  it("How to get started with Gemini em blog.google (slug how-to) -> tutorial", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/technology/how-to-get-started-with-gemini",
        title: "How to get started with Gemini",
      }),
      "tutorial",
    );
  });

  it("Gemini turns 2 em blog.google -> noticias (UPDATE_PATTERNS)", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/products/gemini/gemini-turns-2",
        title: "Gemini turns 2",
      }),
      "noticias",
    );
  });
});

describe("categorize() -- edge cases: dominios ambiguos (#534)", () => {
  it("deepmind.google/research -> pesquisa (caminho /research/ no bloco lancamento)", () => {
    assert.equal(
      categorize({ url: "https://deepmind.google/research/publications/gemini-nano" }),
      "pesquisa",
    );
  });

  it("ai.google/blog -> lancamento (LANCAMENTO_DOMAINS, sem override)", () => {
    assert.equal(
      categorize({
        url: "https://ai.google/blog/new-feature-announcement",
        title: "Announcing a new AI feature",
      }),
      "lancamento",
    );
  });

  it("blog.google/products -> lancamento (sem slug de tutorial)", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/products/gemini/gemini-2-0-flash",
        title: "Gemini 2.0 Flash",
      }),
      "lancamento",
    );
  });

  it("arXiv sem titulo nem summary -> noticias (off-topic por ausencia de termos)", () => {
    assert.equal(
      categorize({ url: "https://arxiv.org/abs/2501.55555" }),
      "noticias",
    );
  });

  it("title inbox nao crasha -- retorna noticias para URL jornalistica", () => {
    const result = categorize({ url: "https://techcrunch.com/article-x", title: "(inbox)" });
    assert.equal(result, "noticias");
  });

  it("title inbox em dominio lancamento -> nao crasha, avalia URL normalmente", () => {
    const result = categorize({ url: "https://anthropic.com/news/new-model", title: "(inbox)" });
    assert.equal(result, "lancamento");
  });
});

describe("categorize() — arXiv off-topic log (#699)", () => {
  it("arXiv off-topic emite console.error com URL", () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));
    try {
      const result = categorize({ url: "https://arxiv.org/abs/2501.99999", title: "Thermodynamics of Black Holes" });
      assert.equal(result, "noticias", "arXiv off-topic deve ir para noticias");
      assert.ok(errors.length > 0, "deve emitir console.error");
      assert.ok(errors[0].includes("arXiv off-topic"), `mensagem deve conter 'arXiv off-topic', got: ${errors[0]}`);
      assert.ok(errors[0].includes("arxiv.org/abs/2501.99999"), "mensagem deve conter a URL");
    } finally {
      console.error = origError;
    }
  });

  it("arXiv relevante (IA) NÃO emite console.error", () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));
    try {
      categorize({ url: "https://arxiv.org/abs/2501.12345", title: "Scaling Laws for Large Language Models" });
      assert.equal(errors.length, 0, "arXiv relevante não deve emitir console.error");
    } finally {
      console.error = origError;
    }
  });
});

describe("categorizeArticles() — vídeos truncados com log (#697)", () => {
  const makeVideo = (n: number): Article => ({
    url: `https://youtube.com/watch?v=video${n}`,
    title: `Vídeo ${n}`,
  });

  it("≤2 vídeos: sem truncação, sem log", () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));
    try {
      const result = categorizeArticles([makeVideo(1), makeVideo(2)]);
      assert.equal(result.video.length, 2);
      assert.ok(!errors.some((e) => e.includes("truncando")), "não deve logar truncação");
    } finally {
      console.error = origError;
    }
  });

  it(">2 vídeos: trunca para 2 e emite console.error com URLs descartadas", () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));
    try {
      const result = categorizeArticles([makeVideo(1), makeVideo(2), makeVideo(3), makeVideo(4)]);
      assert.equal(result.video.length, 2, "deve manter só 2 vídeos");
      assert.equal(result.video[0].url, "https://youtube.com/watch?v=video1", "ordem preservada");
      assert.equal(result.video[1].url, "https://youtube.com/watch?v=video2");
      const log = errors.find((e) => e.includes("truncando"));
      assert.ok(log, "deve emitir log de truncação");
      assert.ok(log?.includes("4 vídeos"), `log deve mencionar contagem, got: ${log}`);
      assert.ok(log?.includes("video3"), "log deve incluir URL do descartado");
      assert.ok(log?.includes("video4"), "log deve incluir URL do descartado");
    } finally {
      console.error = origError;
    }
  });
});

describe("isUnresolvableInboxArticle (#722 — drop unresolvable inbox articles)", () => {
  it("identifica artigo editor_submitted com título placeholder e summary vazio como irresolvível", () => {
    assert.equal(
      isUnresolvableInboxArticle({
        url: "https://example.com/x",
        title: "(inbox)",
        summary: "",
        flag: "editor_submitted",
      }),
      true,
    );
  });

  it("identifica artigo com summary null como irresolvível", () => {
    assert.equal(
      isUnresolvableInboxArticle({
        url: "https://example.com/x",
        title: "(inbox)",
        summary: null,
        flag: "editor_submitted",
      }),
      true,
    );
  });

  it("identifica artigo com título vazio e summary curto como irresolvível", () => {
    assert.equal(
      isUnresolvableInboxArticle({
        url: "https://example.com/x",
        title: "",
        summary: "curto",
        flag: "editor_submitted",
      }),
      true,
    );
  });

  it("NÃO descarta artigo com título real mesmo sem summary longo", () => {
    assert.equal(
      isUnresolvableInboxArticle({
        url: "https://example.com/x",
        title: "Título real curado pelo editor",
        summary: "",
        flag: "editor_submitted",
      }),
      false,
    );
  });

  it("NÃO descarta artigo com summary suficiente (>=30 chars)", () => {
    assert.equal(
      isUnresolvableInboxArticle({
        url: "https://example.com/x",
        title: "(inbox)",
        summary: "Este é um resumo suficientemente longo para passar.",
        flag: "editor_submitted",
      }),
      false,
    );
  });

  it("NÃO descarta artigo que não é editor_submitted", () => {
    assert.equal(
      isUnresolvableInboxArticle({
        url: "https://example.com/x",
        title: "(inbox)",
        summary: "",
      }),
      false,
    );
  });

  it("categorizeArticles descarta artigo editor_submitted com placeholder + summary vazio", () => {
    const articles: Article[] = [
      {
        url: "https://example.com/real-article",
        title: "Artigo real sobre IA",
        summary: "Este artigo tem conteúdo real e vai para o pipeline.",
      },
      {
        url: "https://example.com/unresolvable",
        title: "(inbox)",
        summary: "",
        flag: "editor_submitted",
      },
    ];
    const result = categorizeArticles(articles);
    const allArticles = [
      ...result.lancamento,
      ...result.noticias,
      ...result.pesquisa,
      ...result.tutorial,
      ...result.video,
    ];
    assert.ok(
      allArticles.every((a) => a.url !== "https://example.com/unresolvable"),
      "artigo irresolvível não deve aparecer em nenhuma categoria",
    );
    assert.ok(
      allArticles.some((a) => a.url === "https://example.com/real-article"),
      "artigo real deve permanecer no pool",
    );
  });
});
