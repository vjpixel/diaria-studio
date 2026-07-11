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

  it("#2985 CASO REAL: latent.space ensaio 'the website of the future...' → noticias (RADAR), não tutorial", () => {
    assert.equal(
      categorize({
        url: "https://www.latent.space/p/agent-web",
        title: "The website of the future may assemble itself for every visitor",
      }),
      "noticias",
    );
  });

  it("#2985: latent.space tutorial real com how-to no título ainda vai para tutorial (sem regressão)", () => {
    assert.equal(
      categorize({
        url: "https://www.latent.space/p/agent-eng-howto",
        title: "How to build an agent with tool use",
      }),
      "tutorial",
    );
  });

  it("#3027 CASO REAL 260707: latent.space entrevista 'X on why Y' → noticias (RADAR), não tutorial", () => {
    // "Vercel's Andrew Qu on why agents are a new kind of software" caiu em
    // USE MELHOR na edição 260707 — formato de entrevista ("Pessoa on why X")
    // não era coberto por ESSAY_ANALYSIS_TITLE_RE antes do #3027 (só cobria
    // "interview with"/"in conversation with"/"Q&A with"/"explains why").
    assert.equal(
      categorize({
        url: "https://www.latent.space/p/andrew-qu-vercel-agents",
        title: "Vercel's Andrew Qu on why agents are a new kind of software",
      }),
      "noticias",
    );
  });

  it("#3027: latent.space tutorial real com 'on why' incidental não é bloqueado se também tiver how-to explícito", () => {
    // Precedência preservada: se o título também tem sinal how-to explícito,
    // isNewsNotTutorial roda isTutorialByKeyword ANTES de ESSAY_ANALYSIS_TITLE_RE
    // (ver ordem em isNewsNotTutorial) — how-to explícito vence.
    assert.equal(
      categorize({
        url: "https://www.latent.space/p/howto-on-why",
        title: "How to build an agent: on why state matters, step by step",
      }),
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

  // #2313 — regressão 260616: anúncios em domínio de tutorial não devem virar tutorial.
  it("regressão 260616: 'Introducing Gemma 4 on Amazon Bedrock' (AWS ML Blog) NÃO é tutorial (#2313)", () => {
    // AWS ML Blog está em TUTORIAL_DOMAIN_EXTRA_PATTERNS, mas o slug "introducing-*"
    // indica anúncio de produto. isNewsNotTutorial deve retornar true via isLaunchSlug.
    const art: Article = {
      url: "https://aws.amazon.com/blogs/machine-learning/introducing-gemma-4-on-amazon-bedrock/",
      title: "Introducing Gemma 4 on Amazon Bedrock",
    };
    // Não deve virar tutorial (seria use_melhor — errado, é lançamento/notícia).
    assert.notEqual(categorize(art), "tutorial", "anúncio em domínio tutorial não deve virar tutorial");
  });

  it("isLaunchSlug detecta slug 'introducing-*' (#2313)", () => {
    assert.ok(isLaunchSlug("https://aws.amazon.com/blogs/machine-learning/introducing-gemma-4-on-amazon-bedrock/"));
    assert.ok(isLaunchSlug("https://blog.langchain.com/announcing-langsmith-2-0/"));
    assert.ok(!isLaunchSlug("https://aws.amazon.com/blogs/machine-learning/how-to-build-rag-pipeline/"));
    assert.ok(!isLaunchSlug("https://aws.amazon.com/blogs/machine-learning/re-introducing-bedrock-agents/"), "re-introducing não é launch slug");
  });

  it("#2691 item 4: isLaunchSlug decodifica percent-encoding no pathname (consistência com isRoundupSlug)", () => {
    // Antes do #2691 item 4, isLaunchSlug testava new URL(url).pathname CRU
    // (sem decodeURIComponent), divergindo de isRoundupSlug/urlSlugText que
    // sempre decodificam. LAUNCH_SLUG_RE só casa tokens ASCII então isso não
    // afeta os casos comuns — mas um slug com o prefixo percent-encoded
    // (ex: "%69ntroducing-x", i genérico encoded) só bate depois do decode.
    assert.ok(
      isLaunchSlug("https://example.com/blog/%69ntroducing-new-model/"),
      "prefixo 'introducing-' percent-encoded deve ser detectado após decode",
    );
  });

  it("isNewsNotTutorial detecta slug de lançamento (#2313)", () => {
    const art: Article = {
      url: "https://aws.amazon.com/blogs/machine-learning/introducing-gemma-4-on-amazon-bedrock/",
      title: "Introducing Gemma 4 on Amazon Bedrock",
    };
    assert.ok(isNewsNotTutorial(art), "slug 'introducing-*' deve ser detectado como news-not-tutorial");
  });

  it("tutorial real do AWS ML Blog ainda é tutorial (#2313 — sem regressão)", () => {
    // "How to build a RAG pipeline" — slug não é launch, é how-to.
    const art: Article = {
      url: "https://aws.amazon.com/blogs/machine-learning/how-to-build-rag-pipeline/",
      title: "How to Build a RAG Pipeline with Amazon Bedrock",
    };
    assert.equal(categorize(art), "tutorial");
  });

  it("case study LangChain sem type_hint 'noticia' vai para isNewsNotTutorial via isLaunchSlug ausente (#2313 — review-use-melhor guard)", () => {
    // "How LangChain Made X Predictable" não tem slug de lançamento, mas também
    // não tem sinal how-to → isNewsNotTutorial = false → isTutorialByDomainExtra vence → tutorial.
    // O gate real pra este caso é review-use-melhor (corporate blog guard).
    // Este teste documenta o comportamento esperado atual.
    const art: Article = {
      url: "https://www.langchain.com/blog/how-langchain-made-x-predictable",
      title: "How LangChain Made X Predictable",
    };
    // categorize retorna "tutorial" porque langchain.com/blog é TUTORIAL_PATTERNS
    // e o slug não tem sinal de lançamento nem de howto.
    // O editor vê este item no gate via review-use-melhor (corporate blog flag).
    assert.equal(categorize(art), "tutorial");
  });
});

describe("categorize() — #2334: isTutorialByKeyword guarda !isNewsNotTutorial", () => {
  // #2334: path L1154 (isTutorialByKeyword) não tinha guard !isNewsNotTutorial, ao contrário
  // de L1093/1094/1116/1164. Anúncio com keyword how-to no TÍTULO (não no slug) em domínio
  // genérico batia no keyword check e retornava "tutorial" antes do check de lançamento.

  it("regressão #2334: anúncio 'Introducing Gemma 4 — how to deploy' em domínio genérico NÃO é tutorial", () => {
    // Slug "introducing-*" → isLaunchSlug=true → isNewsNotTutorial=true.
    // Título tem "how to deploy" que DISPARA TUTORIAL_KEYWORDS_RE (verbo 'deploy' listado).
    // Sem o fix, isTutorialByKeyword retornava "tutorial" na L1154 (domínio genérico
    // não está em TUTORIAL_DOMAINS/TUTORIAL_PATTERNS, então L1093/1094 não acionavam;
    // tampouco usa_melhor seed, então L1116 não acionava; L1154 era o primeiro match).
    // Com o fix, !isNewsNotTutorial(article) bloqueia via isLaunchSlug → não é tutorial.
    const art: Article = {
      url: "https://someblog.example.com/introducing-gemma-4-on-bedrock/",
      title: "Introducing Gemma 4 — how to deploy",
    };
    // Deve ser noticias (domínio genérico, slug introducing-*, sem LANCAMENTO_DOMAINS match).
    assert.notEqual(
      categorize(art),
      "tutorial",
      "anúncio com keyword how-to no título não deve virar tutorial via isTutorialByKeyword (#2334)",
    );
  });

  it("#2334: sem fix, keyword path (L1154) era o vetor — domínio genérico não aciona L1093/L1094/L1116", () => {
    // Confirma que "someblog.example.com" não está em TUTORIAL_DOMAINS/TUTORIAL_PATTERNS
    // (L1093/1094 passam) e não é use_melhor seed (L1116 passa) — portanto o bug
    // estava em L1154 (isTutorialByKeyword), e NÃO em L1164 (isTutorialByDomainExtra).
    // O TUTORIAL_KEYWORDS_RE bate em "how to deploy" (verbo 'deploy' listado).
    // Com o fix: isNewsNotTutorial via isLaunchSlug bloqueia na L1154 antes de L1164.
    const art: Article = {
      url: "https://someblog.example.com/introducing-gemma-4-on-bedrock/",
      title: "Introducing Gemma 4 — how to deploy",
    };
    const result = categorize(art);
    assert.notEqual(result, "tutorial", "L1154 keyword path com guard !isNewsNotTutorial bloqueia tutorial");
  });

  it("#2334: 'how to build X' em domínio genérico SEM slug de lançamento ainda é tutorial", () => {
    // Sem slug de lançamento, isNewsNotTutorial retorna false → isTutorialByKeyword vence normalmente.
    const art: Article = {
      url: "https://someblog.example.com/how-to-build-rag-with-gemini/",
      title: "How to build a RAG pipeline with Gemini",
    };
    assert.equal(categorize(art), "tutorial", "tutorial legítimo com how-to keyword sem lançamento deve continuar tutorial");
  });

  it("regressão #2334 (titleExtra path): anúncio com 'step-by-step' no título em domínio genérico com slug de lançamento NÃO é tutorial", () => {
    // TUTORIAL_TITLE_EXTRA_RE bate em "step-by-step" no título → isTutorialByTitleExtra=true.
    // Slug "introducing-*" → isLaunchSlug=true → isNewsNotTutorial=true.
    // Domínio genérico: não está em TUTORIAL_DOMAINS/TUTORIAL_PATTERNS (L1093/L1094 passam),
    // nem em use_melhor seed (L1116 passa), nem em isTutorialByKeyword (L1154 — sem how-to keyword).
    // Sem o fix em L1168, isTutorialByTitleExtra retornava "tutorial" aqui.
    // Com o fix, !isNewsNotTutorial(article) bloqueia via isLaunchSlug → não é tutorial.
    const art: Article = {
      url: "https://someblog.example.com/introducing-gemma-4-step-by-step/",
      title: "Introducing Gemma 4: a step-by-step overview",
    };
    assert.notEqual(
      categorize(art),
      "tutorial",
      "anúncio com 'step-by-step' no título e slug introducing-* não deve virar tutorial via isTutorialByTitleExtra (#2334)",
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

  // #3288 REGRESSÃO: isVideoUrl (usado por categorize()) e a versão
  // duplicada em verify-accessibility.ts ficaram desatualizadas quando
  // #3273 ampliou só isYoutubeUrl (validação de 2º estágio, dentro do
  // bucket video) pra aceitar /live/, /shorts/ e m.youtube.com. Sem o
  // gate de 1º estágio (categorize()) reconhecer esses formatos, o
  // artigo nunca entrava no bucket `video` — o fix do #3273 nunca
  // chegava a ser exercitado. Caso motivador real: #3202/#3273
  // "Introducing GPT-Live" (youtube.com/live/{id}).
  it("#3288: youtube.com/live/{id} (livestream) → video", () => {
    assert.equal(
      categorize({ url: "https://www.youtube.com/live/EAN5Cj347PY" }),
      "video",
    );
  });

  it("#3288: youtube.com/shorts/{id} → video", () => {
    assert.equal(
      categorize({ url: "https://www.youtube.com/shorts/EAN5Cj347PY" }),
      "video",
    );
  });

  it("#3288: host m.youtube.com (mobile) → video", () => {
    assert.equal(
      categorize({ url: "https://m.youtube.com/watch?v=EAN5Cj347PY" }),
      "video",
    );
    assert.equal(
      categorize({ url: "https://m.youtube.com/live/EAN5Cj347PY" }),
      "video",
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

  // #3288: isVideoUrl (re-exportado de video-youtube-resolve.ts) precisa
  // aceitar os mesmos formatos que isYoutubeUrl reconhece desde #3273.
  it("#3288: youtube.com/live/{id} (livestream) → true", () => {
    assert.ok(isVideoUrl("https://www.youtube.com/live/EAN5Cj347PY"));
  });

  it("#3288: youtube.com/shorts/{id} → true", () => {
    assert.ok(isVideoUrl("https://www.youtube.com/shorts/EAN5Cj347PY"));
  });

  it("#3288: host m.youtube.com (mobile) → true", () => {
    assert.ok(isVideoUrl("https://m.youtube.com/watch?v=EAN5Cj347PY"));
    assert.ok(isVideoUrl("https://m.youtube.com/live/EAN5Cj347PY"));
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
