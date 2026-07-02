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
  isLaunchSlug,
  isRoundupSlug,
  isCoursePage,
  hasPreExistenceSignal,
  isIncrementalReleaseOnThirdPartyBlog,
  isResearchBySlug,
  isOpenAIFrontiersStory,
  isFirstPartyToolingBlog,
  isDevReleaseNote,
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

  it("#2370: classifica blog da Anthropic em claude.com como lancamento (via pattern)", () => {
    // Caso real 260618: claude.com/blog/ (categoria "Product announcements")
    // era categorizado como RADAR/noticias porque claude.com não era oficial.
    const art: Article = {
      url: "https://claude.com/blog/claude-design-stays-on-brand-for-daily-work",
      title: "Claude design stays on brand for daily work",
    };
    assert.equal(categorize(art), "lancamento");
  });

  it("#2370: claude.com/product/* (marketing estático) NÃO é lancamento", () => {
    // /product/claude-code é página de marketing evergreen sem data — não anúncio.
    const art: Article = {
      url: "https://claude.com/product/claude-code",
      title: "Claude Code",
    };
    assert.notEqual(categorize(art), "lancamento");
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
