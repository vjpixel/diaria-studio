import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import {
  categorize,
  isVideoUrl,
  isArxivRelevant,
  categorizeArticles,
  isUnresolvableInboxArticle,
  isCustomerStory,
  isNonLaunchPath,
  hasLaunchVerb,
  isThirdPartyBlogAboutOtherCompany,
  isExplainerByTitle,
  isNewsNotTutorial,
  isCoursePage,
  hasPreExistenceSignal,
  isIncrementalReleaseOnThirdPartyBlog,
  isResearchBySlug,
  isOpenAIFrontiersStory,
  isFirstPartyToolingBlog,
  type Article,
} from "../scripts/categorize.ts";

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

  it("#1852: NVIDIA blog com slug de conferência (cvpr) → pesquisa, não lançamento", () => {
    const art: Article = {
      url: "https://blogs.nvidia.com/blog/cvpr-research-grasping-driving-agent-training/",
      title: "Grasping, driving and agent training advances",
    };
    assert.equal(categorize(art), "pesquisa");
    assert.equal(isResearchBySlug(art.url), true);
  });

  it("#1852: research-slug vence type_hint=lancamento (conferência é autoritativa)", () => {
    const art: Article = {
      url: "https://blogs.nvidia.com/blog/neurips-2025-foundation-model/",
      title: "Foundation model results",
      type_hint: "lancamento",
    };
    assert.equal(categorize(art), "pesquisa");
  });

  it("#1852: 'research preview' NÃO é capturado pelo research-slug (é lançamento)", () => {
    // research cru fora — `research preview` é termo de produto.
    assert.equal(isResearchBySlug("https://openai.com/index/research-preview-of-o5/"), false);
  });

  it("#1852: OpenAI Frontiers (customer story) → noticias, não lançamento", () => {
    const art: Article = {
      url: "https://openai.com/index/endava-frontiers/",
      title: "How Endava scaled with OpenAI",
    };
    assert.equal(categorize(art), "noticias");
    assert.equal(isOpenAIFrontiersStory(art.url), true);
  });

  it("#1852: HF /blog/ sobre CLI própria → noticias (não página de produto)", () => {
    const art: Article = {
      url: "https://huggingface.co/blog/hf-cli-for-agents",
      title: "Designing the HF CLI for agents",
    };
    assert.equal(categorize(art), "noticias");
    assert.equal(isFirstPartyToolingBlog(art.url), true);
  });

  it("#1852 review: HF CLI blog vence type_hint=lancamento (roda antes do short-circuit)", () => {
    // Prod: o agent lê o post e seta type_hint=lancamento. O check tem que rodar
    // ANTES do short-circuit, senão o fix não funciona na prática.
    const art: Article = {
      url: "https://huggingface.co/blog/hf-cli-for-agents",
      title: "The HF CLI for agents",
      type_hint: "lancamento",
    };
    assert.equal(categorize(art), "noticias");
  });

  it("#1852: HF model release (sem cli/sdk) continua lançamento", () => {
    assert.equal(isFirstPartyToolingBlog("https://huggingface.co/blog/smollm3"), false);
    const art: Article = { url: "https://huggingface.co/blog/smollm3", title: "Introducing SmolLM3" };
    assert.equal(categorize(art), "lancamento");
  });

  it("#1852 review: sigla de conferência só no TÍTULO (slug limpo) NÃO vira pesquisa", () => {
    // isResearchBySlug é slug-only — título com "CVPR"/"NeurIPS" não pode
    // reclassificar um lançamento real.
    assert.equal(isResearchBySlug("https://blogs.nvidia.com/blog/new-rtx-gpu/"), false);
    const art: Article = {
      url: "https://blogs.nvidia.com/blog/new-rtx-gpu/",
      title: "New RTX GPU debuts at CVPR 2026",
      type_hint: "lancamento",
    };
    assert.equal(categorize(art), "lancamento");
  });

  it("#1852 review: 'frontiers' NÃO no fim do slug não dispara o detector da OpenAI", () => {
    assert.equal(isOpenAIFrontiersStory("https://openai.com/index/ai-frontiers-report/"), false);
    assert.equal(isOpenAIFrontiersStory("https://openai.com/index/endava-frontiers"), true);
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
    // Slug multi-token pra evitar isCustomerSlug match (#1453)
    const art: Article = { url: "https://www.openai.com/blog/something-new-here" };
    assert.equal(categorize(art), "lancamento");
  });

  it("URL inválida cai em noticias sem crashar", () => {
    const art: Article = { url: "not-a-url" };
    assert.equal(categorize(art), "noticias");
  });
});

describe("categorize() — explainer/análise em domínio oficial → noticias (#1698)", () => {
  it("'How Cosmos 3 Helps Physical AI...' (blogs.nvidia.com) → noticias, não lancamento", () => {
    const art: Article = {
      url: "https://blogs.nvidia.com/blog/cosmos-3-physical-ai-open-world-foundation-model/",
      title: "How Cosmos 3 Helps Physical AI Think Before It Acts",
    };
    assert.equal(categorize(art), "noticias");
    // bucket-level (#1717 review): RADAR, não LANÇAMENTO.
    const { lancamento, radar } = categorizeArticles([art]);
    assert.equal(lancamento.length, 0);
    assert.equal(radar.length, 1);
  });

  it("'Beyond LLMs: Why Scalable Enterprise AI...' em domínio oficial → noticias", () => {
    const art: Article = {
      url: "https://blogs.nvidia.com/blog/enterprise-agent-logic/",
      title: "Beyond LLMs: Why Scalable Enterprise AI Adoption Depends on Agent Logic",
    };
    assert.equal(categorize(art), "noticias");
  });

  it("anúncio real ('Introducing X') no MESMO domínio continua lancamento", () => {
    const art: Article = {
      url: "https://blogs.nvidia.com/blog/mellum2-moe/",
      title: "Introducing Mellum2: A 12B MoE Model",
    };
    assert.equal(categorize(art), "lancamento");
  });

  it("#1717: type_hint='lancamento' (agent leu) vence o override de explainer", () => {
    // Decisão intencional: se o agent confirmou lançamento, o título explainer
    // NÃO desclassifica (evita FP em "Why we built X" launch blogs). O override
    // de explainer cobre só itens SEM type_hint (RSS/websearch) — o gap do #1698.
    const art: Article = {
      url: "https://blogs.nvidia.com/blog/cosmos-3-physical-ai/",
      title: "How Cosmos 3 Helps Physical AI Think Before It Acts",
      type_hint: "lancamento",
    };
    assert.equal(categorize(art), "lancamento");
  });

  it("PT-BR: 'Como o X funciona' em domínio oficial → noticias (#1717)", () => {
    const art: Article = {
      url: "https://blogs.nvidia.com/blog/cosmos-explainer/",
      title: "Como o Cosmos 3 funciona por dentro",
    };
    assert.equal(categorize(art), "noticias");
    assert.equal(isExplainerByTitle({ url: "x", title: "Por que os agentes importam" }), true);
  });

  it("'Understanding X' / 'A guide to Y' → explainer", () => {
    assert.equal(isExplainerByTitle({ url: "x", title: "Understanding diffusion transformers" }), true);
    assert.equal(isExplainerByTitle({ url: "x", title: "A guide to building agents" }), true);
    assert.equal(isExplainerByTitle({ url: "x", title: "Why context windows matter" }), true);
  });

  it("título product-name-only NÃO é explainer (não falso-positiva launch)", () => {
    assert.equal(isExplainerByTitle({ url: "x", title: "Gemini 2.0 Flash" }), false);
    assert.equal(isExplainerByTitle({ url: "x", title: "Claude 4 Sonnet" }), false);
  });

  it("verbo de anúncio vence o prefixo explainer (defensivo)", () => {
    // "Introducing: How X works" — anúncio explícito → não desclassifica
    assert.equal(
      isExplainerByTitle({ url: "x", title: "Introducing Atlas: how our new model works" }),
      false,
    );
  });

  it("'How to use X' continua tutorial (não vira explainer)", () => {
    // isTutorialByKeyword roda antes do bloco de lançamento.
    const art: Article = {
      url: "https://huggingface.co/blog/how-to-fine-tune",
      title: "How to fine-tune your first model",
    };
    assert.equal(categorize(art), "tutorial");
  });
});

describe("categorize() — tutorial domain poluído com notícia (#1712)", () => {
  it("comentário/notícia (type_hint) em domínio de tutorial NÃO vira use_melhor", () => {
    const art: Article = {
      url: "https://hamel.dev/2026/Jun/01/some-commentary/",
      title: "Thoughts on the latest model release",
      type_hint: "opiniao",
    };
    assert.equal(categorize(art), "noticias");
  });

  it("notícia (type_hint=noticia) em domínio de tutorial NÃO vira use_melhor", () => {
    const art: Article = {
      url: "https://hamel.dev/2026/Jun/01/news/",
      title: "OpenAI ships new API",
      type_hint: "noticia",
    };
    assert.notEqual(categorize(art), "tutorial");
  });

  it("#1717 CRÍTICO: tutorial explainer-titled em domínio de tutorial CONTINUA tutorial", () => {
    // "How X works" / "A guide to Y" / "Understanding Z" são títulos canônicos
    // de tutorial nesses domínios — NÃO devem ser ejetados pro RADAR. (isExplainer
    // foi deliberadamente removido de isNewsNotTutorial.)
    for (const title of [
      "How attention works",
      "A guide to fine-tuning LLMs",
      "Understanding LoRA from scratch",
    ]) {
      const art: Article = { url: "https://www.fast.ai/posts/x.html", title };
      assert.equal(categorize(art), "tutorial", `"${title}" deve permanecer tutorial`);
      assert.equal(isNewsNotTutorial(art), false, `"${title}" não é news`);
    }
  });

  it("#1717: deep-dive type_hint='analise' em domínio de tutorial CONTINUA tutorial", () => {
    // 'analise' NÃO ejeta (deep-dives analíticos são frequentemente tutoriais).
    const art: Article = {
      url: "https://magazine.sebastianraschka.com/p/llms-from-scratch",
      title: "Building an LLM from scratch, part 3",
      type_hint: "analise",
    };
    assert.equal(categorize(art), "tutorial");
  });

  it("tutorial real (product-name-only) em domínio de tutorial CONTINUA tutorial", () => {
    const art: Article = {
      url: "https://hamel.dev/2026/Jun/01/embeddings/",
      title: "Embeddings: a deep technical reference",
    };
    assert.equal(categorize(art), "tutorial");
  });

  it("tutorial com how-to keyword vence sinal de notícia (mixed)", () => {
    const art: Article = {
      url: "https://hamel.dev/2026/Jun/01/walkthrough/",
      title: "How to build your first agent — cookbook walkthrough",
      type_hint: "noticia",
    };
    assert.equal(categorize(art), "tutorial");
    assert.equal(isNewsNotTutorial(art), false);
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

describe("categorize() — relatório sinalizado no summary, NÃO lançamento (#1765)", () => {
  it("caso real 260603: título product-y + summary 'report explores' → não lançamento", () => {
    // O relatório 'The Next Era of Knowledge Work' caiu em lancamento porque
    // isReport só olhava o TÍTULO ("Codex is becoming a productivity tool...").
    const cat = categorize({
      url: "https://openai.com/index/codex-for-knowledge-work",
      title: "Codex is becoming a productivity tool for everyone",
      summary:
        "The Next Era of Knowledge Work report explores how Codex is transforming productivity through AI-powered research, data analysis",
    });
    assert.notEqual(cat, "lancamento", `esperado != lancamento, veio ${cat}`);
  });

  it("PT-BR: summary 'relatório mostra' em domínio oficial → não lançamento", () => {
    const cat = categorize({
      url: "https://openai.com/index/estado-do-trabalho",
      title: "Codex para todos os times",
      summary: "O relatório anual da OpenAI mostra como a IA muda o trabalho de conhecimento.",
    });
    assert.notEqual(cat, "lancamento");
  });

  it("guard: lançamento real continua lançamento (sem padrão de relatório)", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/index/gpt-6",
        title: "Introducing GPT-6",
        summary: "Today we are launching GPT-6, our most capable model.",
      }),
      "lancamento",
    );
  });

  it("guard: 'launching ... report' NÃO vira relatório (launch-verb vence)", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/index/ai-report-launch",
        title: "Launching our new AI report",
        summary: "Announcing our report exploring trends in AI.",
      }),
      "lancamento",
    );
  });

  it("guard (review #1769): título com verbo de lançamento ('Introducing X') + summary que cita 'report' continua lançamento", () => {
    // FP pego no review: o guard de launch-verb não listava "Introducing", então
    // um lançamento real com summary mencionando relatório era demovido. O
    // !hasLaunchVerb(title) protege.
    assert.equal(
      categorize({
        url: "https://openai.com/index/gpt-6",
        title: "Introducing GPT-6",
        summary: "Our report shows GPT-6 is our fastest model yet.",
      }),
      "lancamento",
    );
  });
});

describe("categorize() — geographic program announcement override (#1442)", () => {
  it("'Introducing OpenAI for Singapore' em domínio oficial vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/index/introducing-openai-for-singapore",
        title: "Introducing OpenAI for Singapore",
      }),
      "noticias",
    );
  });

  it("'Education for Countries' em domínio oficial vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/index/the-next-phase-of-education-for-countries",
        title: "The next phase of OpenAI's Education for Countries",
      }),
      "noticias",
    );
  });

  it("'Claude for Brazil' em domínio oficial vira noticias (programa geográfico PT)", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/claude-for-brazil",
        title: "Claude for Brazil",
      }),
      "noticias",
    );
  });

  it("'opens office in Tokyo' em domínio oficial vira noticias", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/tokyo-office",
        title: "Anthropic opens new office in Tokyo",
      }),
      "noticias",
    );
  });

  it("anti-case: 'Claude for Creative Work' continua lancamento (feature/audience, não geo)", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/claude-creative-work",
        title: "Claude for Creative Work",
      }),
      "lancamento",
    );
  });

  it("anti-case: 'Introducing Gemini Omni' continua lancamento", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/products/gemini/omni",
        title: "Introducing Gemini Omni",
      }),
      "lancamento",
    );
  });

  it("anti-case: 'Asset Studio multimodal' em domínio oficial continua lancamento (feature update PT)", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/products/asset-studio-multimodal",
        title: "Asset Studio ganha capacidades multimodais",
      }),
      "lancamento",
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
  it("hamel.dev → tutorial (dedicated domain)", () => {
    assert.equal(
      categorize({ url: "https://hamel.dev/2026/Jan/15/llm-tools/" }),
      "tutorial",
    );
  });

  it("#1760: simonwillison.net NÃO é mais tutorial domain (blacklist editorial)", () => {
    // Removido de TUTORIAL_DOMAINS — descartado no dedup (editorial-blocklist).
    // Se chegasse ao categorize (não deveria), não cai em use_melhor por domínio.
    assert.notEqual(
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

  describe("novas fontes #1568 (Use melhor)", () => {
    it("cookbook.openai.com → tutorial", () => {
      assert.equal(
        categorize({ url: "https://cookbook.openai.com/examples/agents" }),
        "tutorial",
      );
    });

    it("magazine.sebastianraschka.com → tutorial", () => {
      assert.equal(
        categorize({ url: "https://magazine.sebastianraschka.com/p/llms-from-scratch" }),
        "tutorial",
      );
    });

    it("fast.ai → tutorial", () => {
      assert.equal(
        categorize({ url: "https://www.fast.ai/posts/2026-01-15-course.html" }),
        "tutorial",
      );
    });

    it("blog.langchain.dev → tutorial", () => {
      assert.equal(
        categorize({ url: "https://blog.langchain.dev/agents-tutorial/" }),
        "tutorial",
      );
    });

    it("pinecone.io/learn/ → tutorial (path-prefix)", () => {
      assert.equal(
        categorize({ url: "https://www.pinecone.io/learn/series/rag/" }),
        "tutorial",
      );
    });

    it("hamel.dev → tutorial", () => {
      assert.equal(
        categorize({ url: "https://hamel.dev/posts/llm-eval.html" }),
        "tutorial",
      );
    });

    it("eugeneyan.com → tutorial", () => {
      assert.equal(
        categorize({ url: "https://eugeneyan.com/writing/llm-patterns/" }),
        "tutorial",
      );
    });

    it("hub.asimov.academy → tutorial", () => {
      assert.equal(
        categorize({ url: "https://hub.asimov.academy/blog/llms-praticos/" }),
        "tutorial",
      );
    });

    it("kaggle.com/learn → tutorial (path-prefix)", () => {
      assert.equal(
        categorize({ url: "https://www.kaggle.com/learn/intro-to-deep-learning" }),
        "tutorial",
      );
    });

    it("wandb.ai/site/articles → tutorial (path-prefix)", () => {
      assert.equal(
        categorize({ url: "https://wandb.ai/site/articles/llm-fine-tuning" }),
        "tutorial",
      );
    });

    it("learn.microsoft.com training path → tutorial", () => {
      assert.equal(
        categorize({
          url: "https://learn.microsoft.com/en-us/training/paths/get-started-azure-openai/",
        }),
        "tutorial",
      );
    });

    it("#1862: developers.openai.com/cookbook → tutorial (domínio migrado)", () => {
      assert.equal(
        categorize({ url: "https://developers.openai.com/cookbook/examples/how-to-stream" }),
        "tutorial",
      );
    });

    it("#1862: langchain.com/blog → tutorial; langchain.com (produto) NÃO", () => {
      assert.equal(
        categorize({ url: "https://www.langchain.com/blog/build-an-agent" }),
        "tutorial",
      );
      // Path-scoped: página de produto langchain.com não vira tutorial.
      assert.notEqual(
        categorize({ url: "https://www.langchain.com/langgraph", title: "LangGraph platform" }),
        "tutorial",
      );
    });

    it("#1862: wandb.ai/fully-connected → tutorial", () => {
      assert.equal(
        categorize({ url: "https://wandb.ai/fully-connected/how-to-finetune" }),
        "tutorial",
      );
    });
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

  // Finding #2: domain-extra tutorial domain wins over case-study filter.
  // AWS ML Blog with savings-style title should still land in tutorial (use_melhor).
  it("#2276 finding #2: AWS ML Blog with 'Saves X%' title -> tutorial (domain wins over case-study)", () => {
    // Without the fix, _isMarkCase=true would block isTutorialByDomainExtra.
    // After fix, isTutorialByDomainExtra check is not gated by _isMarkCase.
    assert.equal(
      categorize({ url: "https://aws.amazon.com/blogs/machine-learning/how-bedrock-saves-inference-costs/", title: "How Bedrock Saves 40% on Inference Costs" }),
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
      ...result.radar,
      ...(result.use_melhor ?? []),
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

describe("isCustomerStory (#898) — patterns de customer story / parceria", () => {
  it("detecta 'How {company} uses {product}'", () => {
    assert.equal(
      isCustomerStory({ url: "x", title: "How Singular Bank uses ChatGPT and Codex" }),
      true,
    );
  });

  it("detecta 'X uses OpenAI to help'", () => {
    assert.equal(
      isCustomerStory({ url: "x", title: "Uber uses OpenAI to help people earn smarter" }),
      true,
    );
  });

  it("detecta 'X helps Y move/grow/scale'", () => {
    assert.equal(
      isCustomerStory({ url: "x", title: "Singular Bank helps bankers move fast with ChatGPT" }),
      true,
    );
  });

  it("detecta 'Class of YYYY' (programa)", () => {
    assert.equal(
      isCustomerStory({ url: "x", title: "Introducing ChatGPT Futures: Class of 2026" }),
      true,
    );
  });

  it("detecta 'X collaborate with Y'", () => {
    assert.equal(
      isCustomerStory({ url: "x", title: "OpenAI and PwC collaborate on enterprise AI" }),
      true,
    );
  });

  it("detecta 'Frontier enterprises' / 'B2B Signals'", () => {
    assert.equal(
      isCustomerStory({ url: "x", title: "How frontier enterprises are building an AI advantage" }),
      true,
    );
    assert.equal(
      isCustomerStory({ url: "x", title: "B2B Signals: AI adoption trends" }),
      true,
    );
  });

  it("não dispara em lançamento real (Introducing X)", () => {
    assert.equal(
      isCustomerStory({ url: "x", title: "Introducing GPT-5" }),
      false,
    );
    assert.equal(
      isCustomerStory({ url: "x", title: "Claude 4.5 Sonnet now available" }),
      false,
    );
  });

  it("não dispara em title vazio", () => {
    assert.equal(isCustomerStory({ url: "x", title: "" }), false);
    assert.equal(isCustomerStory({ url: "x" }), false);
  });

  describe("#1321: integração em workflow/produto = customer story", () => {
    it("integração PT 'X integra Y em workflows' → true", () => {
      assert.equal(
        isCustomerStory({ url: "x", title: "Databricks adota GPT-5.5 em workflows empresariais" }),
        true,
      );
      assert.equal(
        isCustomerStory({ url: "x", title: "Empresa integra Claude em produtos" }),
        true,
      );
    });

    it("integração EN 'X integrates Y into workflows' → true", () => {
      assert.equal(
        isCustomerStory({ url: "x", title: "Snowflake integrates ChatGPT into workflows" }),
        true,
      );
      assert.equal(
        isCustomerStory({ url: "x", title: "Acme adopts Gemini in product stack" }),
        true,
      );
    });

    it("'Introducing X' não dispara mesmo com palavra 'in product'", () => {
      // Garante que verbos de anúncio ainda passam
      assert.equal(
        isCustomerStory({ url: "x", title: "Introducing new feature in product" }),
        false,
      );
    });
  });
});

describe("isNonLaunchPath (#898) — paths de programa/customer/marketing", () => {
  it("/customers/ → true", () => {
    assert.equal(isNonLaunchPath("https://openai.com/customers/uber"), true);
  });

  it("/customer-stories/ → true", () => {
    assert.equal(isNonLaunchPath("https://anthropic.com/customer-stories/foo"), true);
  });

  it("/futures/ → true", () => {
    assert.equal(isNonLaunchPath("https://openai.com/futures/class-of-2026"), true);
  });

  it("/scholars/ ou /fellowship/ → true", () => {
    assert.equal(isNonLaunchPath("https://research.google/scholars/2026"), true);
    assert.equal(isNonLaunchPath("https://anthropic.com/fellowship/cohort-2"), true);
  });

  it("/ads/ ou /marketing/ → true", () => {
    assert.equal(isNonLaunchPath("https://blog.google/products/ads/new-feature"), true);
    assert.equal(isNonLaunchPath("https://openai.com/marketing/ai-trends"), true);
  });

  it("/index/ ou /news/ ou /blog/ → false (paths legítimos de lançamento)", () => {
    assert.equal(isNonLaunchPath("https://openai.com/index/introducing-gpt-5"), false);
    assert.equal(isNonLaunchPath("https://anthropic.com/news/claude-launches"), false);
    assert.equal(isNonLaunchPath("https://huggingface.co/blog/new-model"), false);
  });
});

describe("hasLaunchVerb (#898)", () => {
  it("detecta verbos EN: Introducing, launches, unveils, announces", () => {
    assert.equal(hasLaunchVerb({ url: "x", title: "Introducing GPT-5" }), true);
    assert.equal(hasLaunchVerb({ url: "x", title: "OpenAI launches Sora" }), true);
    assert.equal(hasLaunchVerb({ url: "x", title: "Anthropic unveils Claude 5" }), true);
    assert.equal(hasLaunchVerb({ url: "x", title: "Google announces Gemini 3" }), true);
    assert.equal(hasLaunchVerb({ url: "x", title: "Meta presents Llama 4" }), true);
  });

  it("detecta verbos PT-BR: lança, apresenta, revela, disponibiliza", () => {
    assert.equal(hasLaunchVerb({ url: "x", title: "OpenAI lança GPT-5" }), true);
    assert.equal(hasLaunchVerb({ url: "x", title: "Anthropic apresenta Claude 5" }), true);
    assert.equal(hasLaunchVerb({ url: "x", title: "Google revela novidades" }), true);
    assert.equal(hasLaunchVerb({ url: "x", title: "Apple disponibiliza Apple Intelligence" }), true);
  });

  it("não confunde com customer story", () => {
    assert.equal(
      hasLaunchVerb({ url: "x", title: "How Singular Bank uses ChatGPT" }),
      false,
    );
    assert.equal(
      hasLaunchVerb({ url: "x", title: "OpenAI + PwC collaborate" }),
      false,
    );
  });
});

describe("categorize() — #898 customer-story / path-blocklist override", () => {
  it("openai.com customer story → noticias (não lancamento)", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/index/singular-bank",
        title: "Singular Bank helps bankers move fast with ChatGPT and Codex",
      }),
      "noticias",
    );
  });

  it("openai.com /futures/ Class of 2026 → noticias (path-blocklist + customer-story)", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/futures/class-of-2026",
        title: "Introducing ChatGPT Futures: Class of 2026",
      }),
      "noticias",
    );
  });

  it("anthropic.com partnership story → noticias", () => {
    assert.equal(
      categorize({
        url: "https://www.anthropic.com/news/openai-pwc-collaborate",
        title: "OpenAI and PwC collaborate on enterprise deployments",
      }),
      "noticias",
    );
  });

  it("blog.google customer story → noticias", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/products/gemini/uber-customer-story",
        title: "How Uber uses Gemini to help drivers earn smarter",
      }),
      "noticias",
    );
  });

  it("regression: openai.com lançamento real → continua lancamento", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/index/introducing-gpt-5-5",
        title: "Introducing GPT-5.5",
      }),
      "lancamento",
    );
  });

  it("regression: anthropic.com news real → continua lancamento", () => {
    assert.equal(
      categorize({
        url: "https://www.anthropic.com/news/claude-4-5-sonnet",
        title: "Claude 4.5 Sonnet",
      }),
      "lancamento",
    );
  });

  it("regression: huggingface.co/blog real → lancamento", () => {
    assert.equal(
      categorize({
        url: "https://huggingface.co/blog/new-vision-model",
        title: "Introducing the new vision model",
      }),
      "lancamento",
    );
  });
});

describe("categorize() — relatórios/análises NÃO são lançamentos (#1096)", () => {
  it("'Read our new report on X' em blog.google → noticias", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/google-threat-intelligence-group-report/",
        title: "Read our new report on AI-powered threats and our latest defenses.",
      }),
      "noticias",
    );
  });

  it("'The state of global AI diffusion in 2026' em blogs.microsoft.com → noticias", () => {
    assert.equal(
      categorize({
        url: "https://blogs.microsoft.com/on-the-issues/2026/05/07/the-state-of-global-ai-diffusion-in-2026/",
        title: "The state of global AI diffusion in 2026",
      }),
      "noticias",
    );
  });

  it("Microsoft '/on-the-issues/' path em geral → noticias (essays, não produtos)", () => {
    assert.equal(
      categorize({
        url: "https://blogs.microsoft.com/on-the-issues/2026/05/07/some-essay-about-ai",
        title: "Introducing some essay about AI policy",
      }),
      "noticias",
    );
  });

  it("'Annual report 2026' em openai.com → noticias", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/news/annual-report-2026/",
        title: "Our Annual report 2026",
      }),
      "noticias",
    );
  });

  it("'Inside the X report' → noticias", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/news/inside-the-ai-index",
        title: "Inside the AI Index 2026 report",
      }),
      "noticias",
    );
  });

  it("aceita lançamento que MENCIONA relatório no contexto ('Launching X alongside report')", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/products/something/",
        title: "Launching Threat Defense Suite alongside the GTIG report",
      }),
      "lancamento",
    );
  });

  it("'Introducing Gemini 4' em blog.google ainda É lançamento (regression)", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/products/gemini/gemini-4-launch/",
        title: "Introducing Gemini 4",
      }),
      "lancamento",
    );
  });
});

describe("categorize() — type_hint override em lançamento (#1173)", () => {
  it("openai.com/index/introducing-X COM type_hint='noticia' → noticias", () => {
    // Bug confirmado: openai.com/index/introducing-trusted-contact-in-chatgpt
    // foi pra Lançamentos quando deveria ser Notícias (feature/safety, não
    // produto novo). type_hint do source-researcher reflete leitura do conteúdo.
    assert.equal(
      categorize({
        url: "https://openai.com/index/introducing-trusted-contact-in-chatgpt",
        title: "Introducing Trusted Contact in ChatGPT",
        type_hint: "noticia",
      }),
      "noticias",
    );
  });

  it("deepmind.google/blog/X COM type_hint='pesquisa' → pesquisa", () => {
    // Bug confirmado: deepmind.google/blog/ai-co-clinician foi pra Lançamentos
    // quando deveria ser Pesquisas.
    assert.equal(
      categorize({
        url: "https://deepmind.google/blog/ai-co-clinician",
        title: "AI Co-Clinician",
        type_hint: "pesquisa",
      }),
      "pesquisa",
    );
  });

  it("type_hint='opiniao' em domínio oficial → noticias", () => {
    assert.equal(
      categorize({
        url: "https://blog.google/innovation-and-ai/some-essay/",
        title: "Reflections on AI safety",
        type_hint: "opiniao",
      }),
      "noticias",
    );
  });

  it("type_hint='analise' em domínio oficial → noticias", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/analise-x",
        title: "Analysis: agent reliability",
        type_hint: "analise",
      }),
      "noticias",
    );
  });

  it("regression: type_hint='ferramenta' em domínio oficial NÃO override → mantém lancamento", () => {
    // type_hint=ferramenta é genérico — não força override. URL official manda.
    assert.equal(
      categorize({
        url: "https://openai.com/index/introducing-gpt-5",
        title: "Introducing GPT-5",
        type_hint: "ferramenta",
      }),
      "lancamento",
    );
  });

  it("regression: sem type_hint, regra default mantém lancamento", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/claude-4-5",
        title: "Introducing Claude 4.5",
      }),
      "lancamento",
    );
  });
});

describe("categorize() — #1453 inversão de default + novos detectores", () => {
  it("OpenAI Erdős math proof → pesquisa (não lancamento)", () => {
    // Caso real 260522: foi LANÇAMENTO indevidamente.
    assert.equal(
      categorize({
        url: "https://openai.com/index/model-disproves-discrete-geometry-conjecture",
        title: "An OpenAI model has disproved a central conjecture in discrete geometry",
      }),
      "pesquisa",
    );
  });

  it("NVIDIA Vera CPU delivery → noticias (não lancamento)", () => {
    // Caso real 260522: \"Vera Arrives: NVIDIA's First CPU Built for Agents Lands at Top AI Labs\"
    // Domain oficial, mas é entrega/milestone — não disponibilidade geral.
    assert.equal(
      categorize({
        url: "https://blogs.nvidia.com/blog/vera-cpu-delivery/",
        title: "Vera Arrives: NVIDIA's First CPU Built for Agents Lands at Top AI Labs",
      }),
      "noticias",
    );
  });

  it("OpenAI + customer name slug → noticias", () => {
    // Caso real 260522: openai.com/index/adventhealth — partnership/customer story.
    assert.equal(
      categorize({
        url: "https://openai.com/index/adventhealth",
        title: "AdventHealth advances whole-person care with OpenAI",
      }),
      "noticias",
    );
    // Outros casos típicos
    assert.equal(
      categorize({
        url: "https://openai.com/index/databricks",
        title: "Databricks integrates ChatGPT",
      }),
      "noticias",
    );
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/kpmg",
        title: "Anthropic e KPMG",
      }),
      "noticias",
    );
  });

  it("domínio oficial + título product-name-only (sem verbo) → lancamento (default mantido)", () => {
    // #1453 — inversão de default foi rejeitada pra preservar product-name-only
    // launches como \"Claude 4 Sonnet\". A precisão extra vem dos 3 detectores
    // específicos (research/logistics/customer), não da inversão wholesale.
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/claude-haiku-5",
        title: "Claude Haiku 5",
      }),
      "lancamento",
    );
  });

  it("domínio oficial + verbo de lançamento explícito → lancamento", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/index/introducing-gpt-6",
        title: "Introducing GPT-6: our new flagship model",
      }),
      "lancamento",
    );
  });

  it("isLikelyResearchResult cobre 'breakthrough' e 'solves'", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/index/math-breakthrough",
        title: "Math breakthrough: model solves 80-year-old conjecture",
      }),
      "pesquisa",
    );
  });

  it("isLogisticsMilestone cobre 'ships to' e 'first units'", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/first-units-ship",
        title: "First units ship to enterprise customers",
      }),
      "noticias",
    );
  });

  it("isCustomerSlug NÃO casa slugs de produto (skip false positives)", () => {
    // Slug com verbo de lançamento → não trata como customer
    assert.equal(
      categorize({
        url: "https://openai.com/index/introducing-gpt-5",
        title: "Introducing GPT-5",
      }),
      "lancamento",
    );
    // Slug com versão → não trata como customer
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/claude-v3",
        title: "Claude v3 announces availability",
      }),
      "lancamento",
    );
  });

  // Review fixes — precedência de type_hint
  it("type_hint=lancamento do source-researcher curto-circuita customer-slug (#1173)", () => {
    // Agent LEU a página e disse "lancamento". URL parece customer (single-token),
    // mas type_hint vence — caso "Sora", "Codex", "Gemini" em /index/{name}.
    assert.equal(
      categorize({
        url: "https://openai.com/index/sora",
        title: "Sora",
        type_hint: "lancamento",
      }),
      "lancamento",
    );
  });

  it("type_hint=lancamento curto-circuita logistics (delivers/ships não derruba launch real)", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/claude-4-5",
        title: "Claude 4.5 delivers state-of-the-art performance",
        type_hint: "lancamento",
      }),
      "lancamento",
    );
  });

  it("isLogisticsMilestone NÃO casa 'delivers' bare (marketing copy comum)", () => {
    // Antes do tightening, "delivers state-of-the-art" virava noticias.
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/claude-4-5-perf",
        title: "Claude 4.5 delivers state-of-the-art coding performance",
      }),
      "lancamento",
    );
  });

  it("isLogisticsMilestone CASA 'ships to enterprise/select/etc' (contexto específico)", () => {
    assert.equal(
      categorize({
        url: "https://blogs.nvidia.com/blog/x",
        title: "Vera CPU ships to top AI labs",
      }),
      "noticias",
    );
  });

  it("isLikelyResearchResult NÃO casa 'breakthrough' bare em copy de marketing", () => {
    // Antes do tightening, "breakthrough in reasoning" virava pesquisa.
    assert.equal(
      categorize({
        url: "https://deepmind.google/blog/gemini-3-launch",
        title: "Gemini 3: a breakthrough in multimodal reasoning",
      }),
      "lancamento",
    );
  });

  it("isLikelyResearchResult CASA 'disproves the conjecture' (contexto acadêmico)", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/index/model-disproves-discrete-geometry-conjecture",
        title: "Model disproves the discrete geometry conjecture",
      }),
      "pesquisa",
    );
  });

  it("PT: 'resolveu conjectura' casa research result (fix resolv[eu]?)", () => {
    assert.equal(
      categorize({
        url: "https://exemplo.com.br/blog/erdos",
        title: "Modelo resolveu a conjectura de Erdős sobre distâncias unitárias",
      }),
      "noticias", // sem domain de lancamento — vai pra noticias mesmo
    );
    // Em domain de lancamento, PT 'resolveu' agora casa research → pesquisa
    assert.equal(
      categorize({
        url: "https://openai.com/index/x",
        title: "Modelo da OpenAI resolveu a conjectura de Erdős",
      }),
      "pesquisa",
    );
  });
});

// #1472: conference recaps, awards e third-party blogs → noticias
describe("categorize() — #1472 conference/award/third-party overrides", () => {
  it("NVIDIA GTC conference recap → noticias", () => {
    assert.equal(
      categorize({
        url: "https://blogs.nvidia.com/blog/nvidia-gtc-taipei-computex-2026-news/",
        title: "NVIDIA GTC Taipei at COMPUTEX: Live Updates on What's Next in AI",
      }),
      "noticias",
    );
  });

  it("Google I/O recap → noticias", () => {
    assert.equal(
      categorize({
        url: "https://cloud.google.com/blog/products/ai-machine-learning/innovations-from-google-io-26-on-google-cloud",
        title: "Everything Google Cloud customers need to know from I/O",
      }),
      "noticias",
    );
  });

  it("Gartner Magic Quadrant recognition → noticias", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/index/gartner-2026-agentic-coding-leader",
        title: "OpenAI named a Leader in enterprise coding agents by Gartner",
      }),
      "noticias",
    );
  });

  it("HuggingFace blog hosting NVIDIA content → noticias", () => {
    assert.equal(
      categorize({
        url: "https://huggingface.co/blog/nvidia/nemotron-labs-diffusion",
        title: "Towards Speed-of-Light Text Generation with Nemotron-Labs Diffusion Language Models",
      }),
      "noticias",
    );
  });

  it("HuggingFace own blog post (no company subdir) → lancamento", () => {
    assert.equal(
      categorize({
        url: "https://huggingface.co/blog/cool-new-feature",
        title: "Introducing Cool New Feature",
      }),
      "lancamento",
    );
  });

  it("WWDC → noticias", () => {
    assert.equal(
      categorize({
        url: "https://developer.apple.com/wwdc26/",
        title: "WWDC 2026 Highlights",
      }),
      "noticias",
    );
  });

  it("Forrester Wave → noticias", () => {
    assert.equal(
      categorize({
        url: "https://anthropic.com/news/forrester-wave-leader",
        title: "Anthropic named Leader in Forrester Wave for AI Platforms",
      }),
      "noticias",
    );
  });
});

// #1544: concepts, updates, policies and techniques misclassified as lancamento
describe("categorize() — #1544 non-launch items on official blogs", () => {
  it("Nvidia concept/vision post → noticias (not lancamento)", () => {
    assert.equal(
      categorize({
        url: "https://blogs.nvidia.com/blog/ai-factories-the-new-infrastructure-of-intelligence/",
        title: "AI Factories: The New Infrastructure of Intelligence",
      }),
      "noticias",
    );
  });

  it("HF blog 'goes fully local' → noticias (update, not launch)", () => {
    assert.equal(
      categorize({
        url: "https://huggingface.co/blog/local-reachy-mini-conversation",
        title: "Reachy Mini goes fully local",
      }),
      "noticias",
    );
  });

  it("OpenAI election safeguards → noticias (policy, not launch)", () => {
    assert.equal(
      categorize({
        url: "https://openai.com/index/election-safeguards-2026",
        title: "Election information and safeguards in 2026",
      }),
      "noticias",
    );
  });

  it("HF blog technique post → pesquisa (not lancamento)", () => {
    assert.equal(
      categorize({
        url: "https://huggingface.co/blog/delta-weight-sync",
        title: "Shipping a Trillion Parameters With a Hub Bucket: Delta Weight Sync in TRL",
      }),
      "pesquisa",
    );
  });

  it("HF blog real launch still works → lancamento", () => {
    assert.equal(
      categorize({
        url: "https://huggingface.co/blog/new-model-release",
        title: "Introducing SmolLM2: A New Family of Small Language Models",
      }),
      "lancamento",
    );
  });
});

describe("#1759 — recência de lançamento (produto re-anunciado → noticias)", () => {
  describe("hasPreExistenceSignal — sinais textuais de pré-existência", () => {
    const yes: Array<[string, Article]> = [
      ["available since {mês}", { title: "Foo", summary: "Available since March 2025, Foo now adds X" }],
      ["disponível desde {ano}", { title: "Bar disponível desde 2024" }],
      ["originally released", { title: "X", summary: "Originally released last year" }],
      ["back in {ano}", { title: "Y", summary: "first introduced back in 2023" }],
      ["{N} months ago", { title: "Launched 3 months ago, now improved" }],
      ["lançado há meses", { title: "Z lançado há meses chega a mais usuários" }],
      ["agora disponível no Brasil", { title: "Sora agora disponível no Brasil" }],
      ["chega ao Brasil", { title: "Gemini chega ao Brasil" }],
    ];
    for (const [label, art] of yes) {
      it(`detecta: ${label}`, () => assert.equal(hasPreExistenceSignal({ url: "https://x.com", ...art }), true));
    }

    // FP guards do review #1773: sinais frágeis REMOVIDOS de propósito —
    // ano-pelado e "first ..." casavam lançamentos do ano corrente / de estreia.
    const no: Array<[string, Article]> = [
      ["released today", { title: "GPT-5 released today" }],
      ["Gemini 2.0", { title: "Gemini 2.0" }],
      ["Introducing Claude 4", { title: "Introducing Claude 4 Sonnet" }],
      ["now available in the API", { title: "GPT-5 now available in the API" }],
      ["available in 100 languages", { title: "Now available in 100 languages" }],
      ["launched in {ano-corrente} (#1773: ano-pelado removido)", { title: "GPT-5, launched in 2026, sets benchmark" }],
      ["lançado em {ano} sem mais sinal (#1773)", { title: "Qux lançado em 2026 ganha update" }],
      ["first unveiled today (#1773: 'first' removido)", { title: "Introducing GPT-5: first unveiled today" }],
      ["available since this morning (#1773: exige data)", { title: "X", summary: "Available since this morning, our model..." }],
    ];
    for (const [label, art] of no) {
      it(`não detecta (lançamento real): ${label}`, () => assert.equal(hasPreExistenceSignal({ url: "https://x.com", ...art }), false));
    }
  });

  describe("isIncrementalReleaseOnThirdPartyBlog — versão-ponto em blog de terceiro", () => {
    it("Holo3.1 em huggingface.co/blog → true", () => {
      assert.equal(isIncrementalReleaseOnThirdPartyBlog({
        url: "https://huggingface.co/blog/Hcompany/holo31",
        title: "Holo3.1: Fast & Local Computer Use Agents",
      }), true);
    });
    it("versão .0 (major) colada em HF blog → false (mantém launch)", () => {
      assert.equal(isIncrementalReleaseOnThirdPartyBlog({
        url: "https://huggingface.co/blog/Newco/foo20",
        title: "Foo2.0",
      }), false);
    });
    it("versão-ponto em domínio oficial (NÃO terceiro) → false", () => {
      assert.equal(isIncrementalReleaseOnThirdPartyBlog({
        url: "https://ai.meta.com/blog/llama-3-1",
        title: "Introducing Llama 3.1",
      }), false);
    });
    it("sem versão em HF blog → false", () => {
      assert.equal(isIncrementalReleaseOnThirdPartyBlog({
        url: "https://huggingface.co/blog/Co/thing",
        title: "A new thing",
      }), false);
    });
    // FP guards do review #1773 — HF hospeda lançamentos first-party de open-models.
    it("#1773: versão espaçada (Llama 3.1) em HF blog → false", () => {
      assert.equal(isIncrementalReleaseOnThirdPartyBlog({
        url: "https://huggingface.co/blog/meta-llama/llama31",
        title: "Introducing Llama 3.1",
      }), false);
    });
    it("#1773: decimal-substantivo (rated 4.8) em HF blog → false", () => {
      assert.equal(isIncrementalReleaseOnThirdPartyBlog({
        url: "https://huggingface.co/blog/Someco/post",
        title: "Our model rated 4.8 stars by users",
      }), false);
    });
  });

  describe("categorize() integração", () => {
    it("caso real 260603: Holo3.1 (HF blog, versão-ponto) → noticias, não lancamento", () => {
      assert.equal(categorize({
        url: "https://huggingface.co/blog/Hcompany/holo31",
        title: "Holo3.1: Fast & Local Computer Use Agents",
        summary: "A Blog post by H company on Hugging Face",
      }), "noticias");
    });
    it("Holo3.1 sobrepõe type_hint=lancamento do agent", () => {
      assert.equal(categorize({
        url: "https://huggingface.co/blog/Hcompany/holo31",
        title: "Holo3.1: Fast & Local Computer Use Agents",
        type_hint: "lancamento",
      }), "noticias");
    });
    it("pré-existência textual sobrepõe type_hint=lancamento", () => {
      assert.equal(categorize({
        url: "https://openai.com/index/foo",
        title: "Foo expande recursos",
        summary: "Originally released last year, Foo now adds X",
        type_hint: "lancamento",
      }), "noticias");
    });
    it("FP guard: Gemini 2.0 (oficial, sem pré-existência) → lancamento", () => {
      assert.equal(categorize({
        url: "https://blog.google/technology/gemini-2",
        title: "Gemini 2.0",
        type_hint: "lancamento",
      }), "lancamento");
    });
    it("FP guard: Llama 3.1 oficial (versão-ponto mas NÃO blog terceiro) → lancamento", () => {
      assert.equal(categorize({
        url: "https://ai.meta.com/blog/llama-3-1",
        title: "Introducing Llama 3.1",
        type_hint: "lancamento",
      }), "lancamento");
    });
  });
});

describe("#1754 — curso/formação → use_melhor (tutorial), não radar", () => {
  it("isCoursePage: host .academy → true", () => {
    assert.equal(isCoursePage("https://hub.asimov.academy/formacao/engenheiro-de-agentes-de-ia/"), true);
  });
  it("isCoursePage: path /course/ → true", () => {
    assert.equal(isCoursePage("https://example.com/course/ai-agents"), true);
  });
  it("isCoursePage: path /curso/ → true", () => {
    assert.equal(isCoursePage("https://example.com/cursos/ia"), true);
  });
  it("isCoursePage: notícia comum sem path de curso → false", () => {
    assert.equal(isCoursePage("https://techcrunch.com/2026/06/01/empresa-lanca-formacao"), false);
  });
  it("caso real 260603: asimov.academy/formacao (agent rotulou noticia) → tutorial", () => {
    assert.equal(categorize({
      url: "https://hub.asimov.academy/formacao/engenheiro-de-agentes-de-ia/",
      title: "Engenheiro de Agentes de IA",
      type_hint: "noticia",
      summary: "Aprenda a usar o Claude Code para desenvolver aplicações",
    }), "tutorial");
  });
});

describe("#1899: routing por fonte use_melhor (lista-semente)", () => {
  it("artigo de fonte flagueada (prefixo) → tutorial (use_melhor)", () => {
    // github.com/anthropics/anthropic-cookbook é flagueado no seed; o host nu
    // github.com NÃO está em TUTORIAL_DOMAINS — é o branch #1899 que pega.
    assert.equal(
      categorize({
        url: "https://github.com/anthropics/anthropic-cookbook/blob/main/skills/x.ipynb",
        title: "Building agents with the Anthropic Cookbook",
      }),
      "tutorial",
    );
    // kaggle.com/learn flagueado
    assert.equal(
      categorize({ url: "https://www.kaggle.com/learn/intro-to-machine-learning" }),
      "tutorial",
    );
  });
  it("outro path do mesmo host largo NÃO vira tutorial (prefixo boundary-safe)", () => {
    // github.com/openai/... não é o cookbook flagueado → não cai no branch #1899
    const cat = categorize({ url: "https://github.com/openai/some-random-repo" });
    assert.notEqual(cat, "tutorial");
    // kaggle competitions (não /learn) também não
    assert.notEqual(
      categorize({ url: "https://www.kaggle.com/competitions/some-comp" }),
      "tutorial",
    );
  });
});

describe("#1984: vocabulário type_hint dos agentes alinhado com categorize.ts", () => {
  // Regressão: o short-circuit `type_hint==='lancamento'` em categorize.ts:1132
  // era dead-code porque os prompts não listavam 'lancamento' no enum.
  // Este teste garante que ambos os agentes incluam 'lancamento' para que o
  // short-circuit seja acessível em produção.
  const AGENTS = [".claude/agents/source-researcher.md", ".claude/agents/discovery-searcher.md"];
  for (const rel of AGENTS) {
    it(`${rel} inclui 'lancamento' no enum de type_hint`, () => {
      const content = readFileSync(resolve(ROOT, rel), "utf8");
      assert.match(
        content,
        /type_hint.*lancamento/,
        `${rel}: 'lancamento' ausente do type_hint — o short-circuit categorize.ts voltaria a ser dead-code`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// #2176 — path-mais-específico-vence: blog.google colisão host
// ---------------------------------------------------------------------------

describe("categorize() — #2176 path-mais-específico-vence no empate de host", () => {
  /**
   * Cenário REAL da issue:
   *   - 'Google' (Primária, use_melhor=0): URL base = blog.google → source-query: site:blog.google
   *   - 'Blog do Google Brasil (IA)' (Tutoriais, use_melhor=1): URL base = blog.google/intl/pt-br/novidades/tecnologia
   *
   * Um artigo em blog.google/intl/pt-br/novidades/tecnologia/X pode ser encontrado pelo
   * source-researcher da 'Google' (site:blog.google cobre TODA a árvore, incluindo /intl/pt-br/).
   * A atribuição correta é: Blog do Google Brasil (path mais específico) → use_melhor → tutorial.
   */
  it("#2176: URL em blog.google/intl/pt-br/novidades/tecnologia → tutorial (não noticias/radar)", () => {
    const art: Article = {
      url: "https://blog.google/intl/pt-br/novidades/tecnologia/google-gemini-atualizado/",
      title: "Como usar o Gemini 2.0 no Google Workspace — guia passo a passo",
    };
    // DEVE ir para tutorial → use_melhor bucket (via path-specificity: Blog do Google Brasil vence Google Primária)
    assert.equal(
      categorize(art),
      "tutorial",
      "URL em blog.google/intl/pt-br/novidades/tecnologia → path mais específico (Blog Brasil use_melhor=1) vence host-only (Google use_melhor=0)",
    );
  });

  it("#2176: categorizeArticles coloca o artigo em use_melhor, não radar", () => {
    const art: Article = {
      url: "https://blog.google/intl/pt-br/novidades/tecnologia/ia-ferramentas-2026/",
      title: "5 ferramentas de IA do Google pra usar hoje",
    };
    const { use_melhor, radar, lancamento } = categorizeArticles([art]);
    assert.equal(use_melhor.length, 1, "artigo deve estar em use_melhor");
    assert.equal(radar.length, 0, "artigo NÃO deve estar em radar");
    assert.equal(lancamento.length, 0, "artigo NÃO deve estar em lancamento");
  });

  it("#2176: atribuição é DETERMINÍSTICA — mesmo resultado independente da ordem de chamada", () => {
    const art: Article = {
      url: "https://blog.google/intl/pt-br/novidades/tecnologia/google-gemini-atualizado/",
    };
    const r1 = categorize(art);
    const r2 = categorize(art);
    const r3 = categorize(art);
    assert.equal(r1, r2, "categorize deve ser determinístico (r1 == r2)");
    assert.equal(r2, r3, "categorize deve ser determinístico (r2 == r3)");
    assert.equal(r1, "tutorial", "resultado deve ser tutorial");
  });

  it("#2176: URL em blog.google fora do /intl/pt-br/ → lancamento (Google Primária, use_melhor=0)", () => {
    // URL fora do path do Blog Brasil → só Google Primária (host-only) casa → use_melhor=false
    // → _useMelhorBySpecificity=false → não retorna tutorial via seed-list → cai no fluxo normal
    // → blog.google é LANCAMENTO_DOMAIN sem filtros de path/deal → lancamento.
    const art: Article = {
      url: "https://blog.google/products/search/nova-feature-search-ai/",
      title: "Nova feature de IA no Google Search",
    };
    // NÃO deve ser tutorial (use_melhor) — a fonte mais específica é Google Primária (use_melhor=0).
    // O bucket real esperado é "lancamento" (blog.google LANCAMENTO_DOMAIN, sem override de path).
    const cat = categorize(art);
    assert.equal(cat, "lancamento", "URL fora do path pt-br → lancamento (Google Primária, não tutorial)");
  });
});
