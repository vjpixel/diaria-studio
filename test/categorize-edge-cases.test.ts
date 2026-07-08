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
        // #2986: título/summary precisam de sinal de IA explícito (ChatGPT) —
        // desde #2986 o gate de relevância-IA descarta itens de bucket
        // secundário (radar/use_melhor) sem esse sinal.
        url: "https://example.com/real-article",
        title: "Artigo real sobre o ChatGPT",
        summary: "Este artigo tem conteúdo real sobre o ChatGPT e vai para o pipeline.",
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

describe("categorizeArticles() — gate de relevância-IA em buckets secundários (#2986)", () => {
  it("#2986 CASO REAL: AltStore PAL (loja alternativa iOS, sem ângulo de IA) é excluído", () => {
    const art: Article = {
      url: "https://canaltech.com.br/apps/altstore-pal-no-brasil-vale-a-pena-usar-loja-alternativa-do-iphone/",
      title: "AltStore PAL no Brasil: vale a pena usar loja alternativa do iPhone?",
      summary: "AltStore PAL é uma loja alternativa de apps para iOS na União Europeia. O que é iOS?",
    };
    const result = categorizeArticles([art]);
    const all = [...result.lancamento, ...result.radar, ...result.use_melhor, ...result.video];
    assert.equal(all.length, 0, "item sem ângulo de IA não deve sobreviver em nenhum bucket");
  });

  it("item AI-relevante em veículo generalista continua no RADAR (sem falso-positivo)", () => {
    const art: Article = {
      url: "https://canaltech.com.br/inteligencia-artificial/openai-lanca-novo-modelo-gpt/",
      title: "OpenAI lança novo modelo GPT com foco em raciocínio",
      summary: "A OpenAI anunciou o GPT mais recente, com ganhos de desempenho em benchmarks de raciocínio.",
    };
    const result = categorizeArticles([art]);
    assert.equal(result.radar.length, 1);
    assert.equal(result.radar[0].url, art.url);
  });

  it("#2986 sem-regressão: tutorial de domínio dedicado (cookbook.openai.com) sem keyword de IA no título continua em use_melhor", () => {
    // "Structured Outputs" não bate AI_RELEVANT_TERMS, mas o domínio já garante
    // relevância — categoria tutorial fica FORA do gate #2986 (só `noticias`).
    const art: Article = {
      url: "https://cookbook.openai.com/examples/structured_outputs_intro",
      title: "Structured Outputs",
      summary: "A quick primer on structured outputs.",
    };
    const result = categorizeArticles([art]);
    assert.equal(result.use_melhor.length, 1);
    assert.equal(result.use_melhor[0].url, art.url);
  });

  it("bucket lancamento NÃO passa pelo gate de relevância-IA (fora de escopo do #2986)", () => {
    // Domínio oficial cadastrado como lançamento — não checado pelo gate extra,
    // mesmo que título/summary não tenham keyword de IA explícita.
    const art: Article = {
      url: "https://openai.com/index/introducing-new-feature",
      title: "Introducing a new feature",
      summary: "A short announcement.",
    };
    const result = categorizeArticles([art]);
    assert.equal(result.lancamento.length, 1);
  });
});

// ---------------------------------------------------------------------------
// #3099 — fixtures de regressão da auditoria 260708 (6 casos reais)
// ---------------------------------------------------------------------------

describe("categorize() — #3099 auditoria 260708: guias-de-uso, explainer/ensaio, iniciativa de pesquisa", () => {
  it("caso 1: 'A Visual Guide to Gemma 4 12B' (explainer conceitual) → noticias, não tutorial", () => {
    // newsletter.maartengrootendorst.com é fonte cadastrada use_melhor=1 no
    // seed, e o título bate `\bguide\s+(to|for)\b` (TUTORIAL_KEYWORDS_RE) —
    // sem o override, os dois sinais combinados classificavam como tutorial.
    // É leitura conceitual sobre arquitetura de modelo, não hands-on ≤2h.
    const art: Article = {
      url: "https://newsletter.maartengrootendorst.com/p/a-visual-guide-to-gemma-4-12b",
      title: "A Visual Guide to Gemma 4 12B",
    };
    assert.equal(categorize(art), "noticias");
  });

  it("caso 2: 'Tools vs. Subagents: Building Effective AI Agents...' (ensaio) → noticias, não tutorial", () => {
    // latent.space é host misto (tutoriais reais + ensaio/opinião, #2985).
    // Framing de comparação "X vs. Y:" no início do título é ensaio, não
    // passo-a-passo hands-on.
    const art: Article = {
      url: "https://www.latent.space/p/tools-vs-subagents",
      title: "Tools vs. Subagents: Building Effective AI Agents at Scale",
    };
    assert.equal(categorize(art), "noticias");
  });

  it("caso 3: 'Improving Agents is a Data Mining Problem' (ensaio LangChain) → noticias, não tutorial", () => {
    // blog.langchain.dev agora está em MIXED_TUTORIAL_ESSAY_HOSTS — o LangChain
    // Blog também publica ensaio/opinião, não só cookbook/how-to.
    const art: Article = {
      url: "https://blog.langchain.dev/improving-agents-is-a-data-mining-problem/",
      title: "Improving Agents is a Data Mining Problem",
    };
    assert.equal(categorize(art), "noticias");
  });

  it("caso 4: 'O que é o NotebookLM e 8 maneiras de usar a ferramenta' → tutorial (USE MELHOR), não noticias", () => {
    // exame.com é veículo jornalístico (NOTICIAS_DOMAINS) — mas o título é
    // claramente guia-de-uso prático, não cobertura de notícia.
    const art: Article = {
      url: "https://exame.com/inteligencia-artificial/o-que-e-o-notebooklm-e-8-maneiras-de-usar-a-ferramenta-de-inteligencia-artificial/",
      title: "O que é o NotebookLM e 8 maneiras de usar a ferramenta de inteligência artificial",
      type_hint: "noticia",
    };
    assert.equal(categorize(art), "tutorial");
  });

  it("caso 5: 'Quais são os modelos do ChatGPT? Entenda as diferenças entre eles' → tutorial (USE MELHOR), não noticias", () => {
    const art: Article = {
      url: "https://exame.com/inteligencia-artificial/quais-sao-os-modelos-do-chatgpt-entenda-as-diferencas-entre-eles/",
      title: "Quais são os modelos do ChatGPT? Entenda as diferenças entre eles",
      type_hint: "noticia",
    };
    assert.equal(categorize(art), "tutorial");
  });

  it("caso 6: 'Three new satellites join the fight against wildfires' (google-research) → pesquisa, não lancamento", () => {
    // blog.google/innovation-and-ai/.../google-research/... bate o path
    // pattern oficial do Google (LANÇAMENTO), mas é iniciativa de
    // pesquisa/deployment (Google Research + Earth Fire Alliance), não
    // produto que o leitor usa. O path tem "models-and-research" e
    // "google-research" como segmentos compostos — nenhum bate o antigo
    // `/\/research\//` exato.
    const art: Article = {
      url: "https://blog.google/innovation-and-ai/models-and-research/google-research/firesat-satellites/",
      title: "Three new satellites join the fight against wildfires",
    };
    assert.equal(categorize(art), "pesquisa");
  });

  it("sem-regressão: 'New Guide to Prompt Engineering in LangChain' (sem 'visual'/'illustrated') continua tutorial (#2469)", () => {
    const art: Article = {
      url: "https://developers.googleblog.com/blog/new-guide-to-prompt-engineering-in-langchain/",
      title: "New Guide to Prompt Engineering in LangChain",
    };
    assert.equal(categorize(art), "tutorial");
  });

  it("sem-regressão: latent.space tutorial real com how-to explícito continua tutorial mesmo com 'vs' incidental", () => {
    const art: Article = {
      url: "https://www.latent.space/p/agent-eng-howto-vs",
      title: "How to build an agent: RAG vs fine-tuning, step by step",
    };
    assert.equal(categorize(art), "tutorial");
  });
});
