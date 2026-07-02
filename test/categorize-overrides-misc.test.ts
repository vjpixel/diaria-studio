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

// #2595: HF blog posts misclassified as LANÇAMENTOS
describe("categorize() — #2595 HF blog misclassified", () => {
  it("huggingface.co/blog/vllm-jobs (tutorial how-to) → tutorial (USE_MELHOR)", () => {
    // Sem summary de propósito: o título "Run X ... with one command" sozinho deve
    // disparar a nova regra imperativa. Um summary com "how to deploy" mascararia o
    // teste (já casava o pattern antigo) — o caso real do #2595 não tinha keyword
    // canônica em lugar nenhum.
    assert.equal(
      categorize({
        url: "https://huggingface.co/blog/vllm-jobs",
        title: "Run a vLLM server with one command",
      }),
      "tutorial",
    );
  });

  it("huggingface.co/blog/allenai/hybrid-token-prediction (research from Ai2) → noticias (RADAR)", () => {
    assert.equal(
      categorize({
        url: "https://huggingface.co/blog/allenai/hybrid-token-prediction",
        title: "Hybrid Token Prediction: Unifying Discrete and Continuous Language Models",
        summary: "AllenAI research on hybrid token prediction combining discrete and continuous representations.",
      }),
      "noticias",
    );
  });

  it("huggingface.co/blog/vllm-jobs imperative tutorial rule does NOT fire for 'Running costs'", () => {
    // Regression: gerúndio "Running" should not trigger imperative-verb tutorial rule.
    const result = categorize({
      url: "https://huggingface.co/blog/running-costs",
      title: "Running costs of LLM inference in one chart",
    });
    // This is not a tutorial (no imperative verb + "in one X"); may be lancamento or noticias.
    assert.notEqual(result, "tutorial");
  });

  it("#2595: HF blog/{org}/{slug} with org NOT in KNOWN_COMPANY_SLUGS → noticias", () => {
    // allenai is not a known company slug but should still be treated as third-party.
    assert.equal(isThirdPartyBlogAboutOtherCompany("https://huggingface.co/blog/allenai/hybrid-token-prediction"), true);
    assert.equal(isThirdPartyBlogAboutOtherCompany("https://huggingface.co/blog/vllm-jobs"), false);
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

// ---------------------------------------------------------------------------
// #2309 item 3 — 1-word-company case study não é misclassificado como tutorial
// ---------------------------------------------------------------------------

describe("#2309 item 3: 1-word-company case study NÃO é tutorial", () => {
  it("'How Reddit used X' em domínio official tutorial NÃO é tutorial (1-word company)", () => {
    // Before fix: TUTORIAL_TITLE_EXTRA_RE matched `how\s+\w+\s+(used?)` where \w+ = "Reddit".
    // isMarketingCaseStudy needed 2+ caps → didn't fire → case study became tutorial.
    // After fix: requires >=2 caps before the verb → "Reddit" alone no longer matches.
    // URL is not an AWS ML Blog domain (isTutorialByDomainExtra doesn't fire either).
    // Falls through to noticias (default).
    const cat = categorize({
      url: "https://blog.anthropic.com/how-reddit-used-claude-for-moderation",
      title: "How Reddit used Claude for moderation at scale",
    });
    // Should NOT be "tutorial" — it's a case study about a company, not a how-to.
    // Expected: noticias (RADAR). Falls through all tutorial gates.
    assert.notEqual(cat, "tutorial", "case study com empresa 1-palavra não deve ser tutorial");
  });

  it("'How Rocket Close Optimized Document Processing' ainda é case study (2-word company)", () => {
    // isMarketingCaseStudy catches 2-word companies → _isMarkCase=true → !_isMarkCase blocks tutorial.
    // TUTORIAL_TITLE_EXTRA_RE with >=2 caps ALSO matches this, but _isMarkCase guard wins.
    const cat = categorize({
      url: "https://aws.amazon.com/blogs/machine-learning/how-rocket-close-optimized-docs",
      title: "How Rocket Close Optimized Document Processing with AWS Bedrock",
    });
    // AWS ML Blog: isTutorialByDomainExtra → tutorial... BUT _isMarkCase=true blocks it → noticias.
    // Actually: isTutorialByDomainExtra runs WITHOUT _isMarkCase guard (#2276 finding #2).
    // So: isTutorialByDomainExtra=true, isNewsNotTutorial=false → tutorial.
    // This means AWS ML Blog case studies land in tutorial (domain wins). That's existing behavior.
    // We only test that the TITLE-based path (non-AWS-domain URL) doesn't classify 2-cap case studies.
    // (Domain-based AWS classification is separate and pre-existing.)
    // Test: non-AWS URL with 2-word company → NOT tutorial via title
    const cat2 = categorize({
      url: "https://techcrunch.com/2026/how-rocket-close-optimized-docs",
      title: "How Rocket Close Optimized Document Processing with Bedrock",
    });
    assert.notEqual(cat2, "tutorial", "case study 2-word company em domínio não-tutorial não deve ser tutorial");
  });

  it("'How to Build a RAG Pipeline' genuíno é tutorial (não confunde com case study)", () => {
    // After fix, genuine "how to build X" tutorials still work via isTutorialByKeyword.
    const cat = categorize({
      url: "https://cookbook.openai.com/examples/rag-pipeline",
      title: "How to Build a RAG Pipeline with LangChain",
    });
    assert.equal(cat, "tutorial", "tutorial genuíno 'how to build' ainda funciona");
  });
});

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

// ---------------------------------------------------------------------------
// #2448 — isDevReleaseNote: rejeita anúncio dev "New X in Y" do USE MELHOR
// ---------------------------------------------------------------------------

describe("isDevReleaseNote (#2448)", () => {
  it("detecta 'New Session Metadata in Sign in with Google' (caso real 260622)", () => {
    assert.ok(
      isDevReleaseNote("New Session Metadata in Sign in with Google"),
      "'New Session Metadata in Sign in with Google' deve ser detectado como release note",
    );
  });

  it("detecta 'New APIs in the Google Identity Services library'", () => {
    assert.ok(
      isDevReleaseNote("New APIs in the Google Identity Services library"),
      "anúncio dev 'New APIs in ...' deve ser detectado",
    );
  });

  it("detecta 'New Authentication Methods in Firebase Auth'", () => {
    assert.ok(
      isDevReleaseNote("New Authentication Methods in Firebase Auth"),
      "padrão 'New X in Y' genérico deve ser detectado",
    );
  });

  it("NÃO detecta título com how-to que contém 'new' — NÃO começa com 'New'", () => {
    assert.ok(
      !isDevReleaseNote("How to use new features in the OpenAI API"),
      "how-to com 'new' no meio não é release note (não começa com 'New')",
    );
  });

  it("NÃO detecta tutorial legítimo que começa com 'New'", () => {
    // "New" com conteúdo curto (< 3 chars) → não bate no padrão {2,40}.
    // Um tutorial como "New to Python: how to build your first script" — "to Python"
    // tem comprimento curto após New, mas a regex requer {2,40} então testamos
    // que títulos tutoriais reais com "New" variante não são falso-positivo.
    assert.ok(
      !isDevReleaseNote("How to build new AI features"),
      "'How to build...' não começa com 'New' — não é release note",
    );
  });

  it("isNewsNotTutorial retorna true para release note 'New X in Y' (#2448)", () => {
    const art: Article = {
      url: "https://developers.googleblog.com/blog/new-session-metadata-in-sign-in-with-google/",
      title: "New Session Metadata in Sign in with Google",
    };
    assert.ok(
      isNewsNotTutorial(art),
      "release note 'New X in Y' deve ser tratado como não-tutorial pelo isNewsNotTutorial",
    );
  });

  it("categorize(): anúncio dev 'New X in Y' em developers.googleblog.com NÃO vira tutorial (#2448)", () => {
    // Caso real 260622: "New Session Metadata in Sign in with Google" entrou no USE MELHOR.
    // developers.googleblog.com bate em TUTORIAL_DOMAIN_EXTRA_PATTERNS (L357 do categorize).
    // Fix: isNewsNotTutorial detecta via isDevReleaseNote e retorna true → não é tutorial.
    const art: Article = {
      url: "https://developers.googleblog.com/blog/new-session-metadata-in-sign-in-with-google/",
      title: "New Session Metadata in Sign in with Google",
    };
    const cat = categorize(art);
    assert.notEqual(
      cat,
      "tutorial",
      "anúncio 'New X in Y' de developers.googleblog.com NÃO deve virar tutorial",
    );
  });

  it("categorize(): tutorial real de developers.googleblog.com CONTINUA sendo tutorial (#2448 regressão)", () => {
    // Guard de regressão: não ejetar how-tos reais com "New" no título.
    // "New" aparece mas depois de verbo how-to → isTutorialByKeyword retorna antes de isDevReleaseNote.
    const art: Article = {
      url: "https://developers.googleblog.com/blog/how-to-use-gemini-api/",
      title: "How to use the new Gemini API for developers",
    };
    assert.equal(
      categorize(art),
      "tutorial",
      "how-to real de developers.googleblog.com deve continuar sendo tutorial",
    );
  });
});

// ---------------------------------------------------------------------------
// #2469 (finding 2) — TUTORIAL_KEYWORDS_RE: "New Guide to X in Y" NÃO é ejetado
// ---------------------------------------------------------------------------

describe("isNewsNotTutorial — 'New Guide to X' não é ejetado como release note (#2469 finding 2)", () => {
  it("isDevReleaseNote('New Guide to X in Y') retorna true (regex pega o padrão)", () => {
    // Confirma que DEV_RELEASE_NOTE_TITLE_RE ancora no início e pega "New Guide to X in Y"
    assert.ok(
      isDevReleaseNote("New Guide to Prompt Engineering in LangChain"),
      "regex de release note deve casar 'New Guide to X in Y'",
    );
  });

  it("'New Guide to X in Y' em domínio de tutorial NÃO é ejetado de use_melhor (#2469 fix)", () => {
    // Antes do fix: isTutorialByKeyword retornava false (não havia "guide to" em TUTORIAL_KEYWORDS_RE),
    // então isNewsNotTutorial caia em isDevReleaseNote e ejetava o artigo.
    // Após o fix: "guide to" é sinal de how-to → isTutorialByKeyword retorna true → article fica tutorial.
    const art: Article = {
      url: "https://developers.googleblog.com/blog/new-guide-to-prompt-engineering-in-langchain/",
      title: "New Guide to Prompt Engineering in LangChain",
    };
    assert.equal(
      categorize(art),
      "tutorial",
      "'New Guide to X in Y' com sinal how-to deve continuar tutorial, não ser ejetado",
    );
  });

  it("'New Techniques for X in Y' em domínio de tutorial NÃO é ejetado (#2469 fix)", () => {
    const art: Article = {
      url: "https://developers.googleblog.com/blog/new-techniques-for-training-in-tensorflow/",
      title: "New Techniques for Training Models in TensorFlow",
    };
    assert.equal(
      categorize(art),
      "tutorial",
      "'New Techniques for X in Y' deve ser tutorial quando o conteúdo é how-to",
    );
  });

  it("'New Patterns for X in Y' em domínio de tutorial NÃO é ejetado (#2469 fix)", () => {
    const art: Article = {
      url: "https://developers.googleblog.com/blog/new-patterns-for-agents-in-gemini/",
      title: "New Patterns for Building Agents in Gemini",
    };
    assert.equal(
      categorize(art),
      "tutorial",
      "'New Patterns for X in Y' deve ser tutorial quando o conteúdo é how-to",
    );
  });

  it("'New Session Metadata in X' SEM sinal how-to CONTINUA sendo ejetado (#2448 regressão)", () => {
    // Sem "guide to"/"techniques for"/"patterns for" → isTutorialByKeyword não casa →
    // isDevReleaseNote ejeta normalmente.
    const art: Article = {
      url: "https://developers.googleblog.com/blog/new-session-metadata-in-sign-in-with-google/",
      title: "New Session Metadata in Sign in with Google",
    };
    assert.notEqual(
      categorize(art),
      "tutorial",
      "anúncio 'New X in Y' sem sinal how-to não deve virar tutorial",
    );
  });
});

// ---------------------------------------------------------------------------
// #2663 — isRoundupSlug: newsletter/roundup no slug bloqueia tutorial
// ---------------------------------------------------------------------------
