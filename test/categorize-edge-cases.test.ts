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
