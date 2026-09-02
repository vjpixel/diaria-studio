/**
 * #6647: instrumentação de proveniência do categorizador — categorizeWithRule()
 * devolve, além do bucket, QUAL regra decidiu (ou o fallback), sem alterar a
 * decisão em si. `categorizeArticles()` persiste isso como `category_rule`.
 *
 * O que este arquivo NÃO prova (correção do review da PR, item 1): que
 * `categorize()` continua devolvendo a MESMA categoria que devolvia antes do
 * #6647 para casos reais. Um describe que compara `categorize(a)` com
 * `categorizeWithRule(a).category` na mesma revisão é tautológico — as duas
 * chamam literalmente o mesmo código (`categorize` é
 * `categorizeWithRule(article).category`), então não existe execução em que
 * divirjam, nem um bug em qualquer um dos 41 branches reescritos faria esse
 * tipo de teste falhar. O describe "delegação estrutural" abaixo trava só
 * isso — que o wrapper não seja desfeito no futuro — nunca "sem regressão de
 * classificação".
 *
 * A evidência real de que nenhuma classificação mudou é EXTERNA a este
 * arquivo:
 *   (a) os 458 testes pré-existentes de test/categorize*.test.ts, não
 *       tocados por este PR, que exercitam `categorize()` com dezenas de
 *       casos reais documentados por issue — e que passam inalterados
 *       através do caminho novo (categorize → categorizeWithRule);
 *   (b) o fleet review pré-merge da PR #7133 extraiu `categorize()` de
 *       master e `categorizeWithRule()` desta branch, normalizou
 *       mecanicamente os 41 pontos de retorno e diffou a árvore de decisão
 *       condição a condição — idêntica, mesma ordem.
 *
 * O que ESTE arquivo cobre, que nada mais cobria antes: qual `rule` id cada
 * branch produz — ver "categorizeWithRule() — 1 gatilho verificado por regra
 * (cobertura completa)" abaixo. Sem isso, dois branches que devolvem a MESMA
 * categoria com ids TROCADOS por engano numa edição mecânica não quebrariam
 * nenhum teste existente (nem os 458 antigos, que só checam `category`) —
 * silenciosamente corromperiam a estatística de `analyze-bucket-overrides.ts
 * --rules`, que é o dado do qual a próxima decisão (LLM ou não) depende.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  categorize,
  categorizeWithRule,
  isFallbackCategorizationRule,
  categorizeArticles,
  categoryToBucket,
  type Article,
  type CategorizationRule,
} from "../scripts/categorize.ts";
import {
  collectRuleUsage,
  summarizeRuleUsage,
} from "../scripts/analyze-bucket-overrides.ts";

describe("categorize() — delegação estrutural para categorizeWithRule() (guard, não regressão)", () => {
  it("categorize(article) === categorizeWithRule(article).category (contrato de delegação, trivial por construção)", () => {
    // Não é evidência de correção da classificação — é um guard que falha se
    // algum refactor futuro desfizer a delegação (ex: reintroduzir uma cópia
    // separada da lógica em categorize()). Ver docblock do arquivo acima.
    const article: Article = { url: "https://example.com/whatever", title: "X" };
    assert.equal(categorize(article), categorizeWithRule(article).category);
  });
});

// ---------------------------------------------------------------------------
// categorizeWithRule() — 1 gatilho verificado por regra (cobertura completa)
// ---------------------------------------------------------------------------
//
// Um artigo por rule id, escolhido/verificado para bater EXATAMENTE aquele
// branch (não só a categoria final) — cada comentário registra por que o
// gatilho não é interceptado por um branch anterior na ordem de avaliação de
// categorizeWithRule(). `Record<CategorizationRule, Article>` é
// exaustivo por construção: se um novo id entrar em CATEGORIZATION_RULE_IDS
// (scripts/lib/launch-heuristics.ts) sem uma entrada aqui, o arquivo não
// compila — não depende de alguém lembrar de atualizar esta lista.
//
// Todos os 41 branches se mostraram alcançáveis — nenhum achado de branch
// morto nesta rodada (2 casos exigiram gatilho propositalmente artificial,
// anotados abaixo: pesquisa-pattern-offtopic e lancamento-non-launch-path).
const RULE_TRIGGERS: Record<CategorizationRule, Article> = {
  "video-url": { url: "https://www.youtube.com/watch?v=abc123", title: "Como usar IA" },
  "course-page": { url: "https://example.com/cursos/ia-generativa-para-iniciantes" },
  "tutorial-domain": {
    url: "https://cookbook.openai.com/examples/how_to_stream_completions",
    title: "Structured Outputs",
  },
  "tutorial-pattern": {
    url: "https://github.com/anthropics/anthropic-cookbook/blob/main/skills/x.ipynb",
    title: "Building agents with the Anthropic Cookbook",
  },
  "use-melhor-specificity": {
    // "Blog do Google Brasil (IA)" é fonte use_melhor=1 no seed com prefixo
    // /intl/pt-br/novidades/tecnologia/ — mais específico que "Google
    // Primária" (host-only, use_melhor=0) para esse path (#2176).
    url: "https://blog.google/intl/pt-br/novidades/tecnologia/google-gemini-atualizado/",
    title: "Como usar o Gemini 2.0 no Google Workspace — guia passo a passo",
  },
  "pesquisa-domain-offtopic": {
    url: "https://arxiv.org/abs/2501.00001",
    title: "On the topology of exotic 7-manifolds",
  },
  "pesquisa-domain": {
    url: "https://arxiv.org/abs/2501.12345",
    title: "Scaling Laws for Large Language Models",
  },
  "pesquisa-pattern-offtopic": {
    // Achado ao construir o gatilho: isArxivRelevant() só avalia off-topic
    // quando a URL contém a SUBSTRING "arxiv.org" em algum lugar — para
    // qualquer host coberto por PESQUISA_PATTERNS que NÃO seja arxiv.org
    // (huggingface.co/papers/, ai.meta.com/research/, etc.), essa condição
    // nunca é verdadeira em uso real (a URL real desses hosts não contém
    // "arxiv.org"). O host arxiv.org em si é sempre interceptado ANTES por
    // PESQUISA_DOMAINS (rule pesquisa-domain/-offtopic), nunca chega no
    // branch de PATTERN. Este gatilho é, portanto, deliberadamente
    // artificial — um query param incidental citando "arxiv.org" — para
    // provar que o branch É alcançável mecanicamente, não que ele
    // corresponde a um cenário editorial plausível.
    url: "https://huggingface.co/papers/2501.00000?ref=arxiv.org-mirror",
    title: "Uma cerâmica pré-colombiana encontrada no Peru",
  },
  "pesquisa-pattern": {
    url: "https://huggingface.co/papers/2501.12345",
    title: "Scaling laws for transformer language models",
  },
  "tutorial-keyword": {
    url: "https://randomsite.example.com/blog/how-to-use-chatgpt-for-writing",
    title: "How to use ChatGPT for writing better emails",
  },
  "tutorial-domain-extra": {
    // developers.googleblog.com/en/ai/ é fonte use_melhor=1 no seed — path
    // FORA desse prefixo específico (/es/, não /en/ai/) não é interceptado
    // por use-melhor-specificity, mas ainda bate o pattern amplo (host
    // inteiro) de TUTORIAL_DOMAIN_EXTRA_PATTERNS.
    url: "https://developers.googleblog.com/es/algun-articulo-de-ia",
    title: "Un artículo cualquiera sobre IA",
  },
  "tutorial-title-extra": {
    // TUTORIAL_TITLE_EXTRA_RE casa "step-by-step" — ausente de
    // TUTORIAL_KEYWORDS_RE (que tem "how-to build/create/...", não a frase
    // solta "step-by-step") — não interceptado por tutorial-keyword.
    url: "https://openai.com/index/deploying-agents-overview",
    title: "Deploying agents: a step-by-step overview",
  },
  "lancamento-research-path": {
    url: "https://blog.google/innovation-and-ai/models-and-research/google-research/firesat-satellites/",
    title: "Three new satellites join the fight against wildfires",
  },
  "lancamento-research-slug": {
    url: "https://blogs.nvidia.com/blog/cvpr-research-highlights/",
    title: "NVIDIA at CVPR: Research Highlights",
  },
  "lancamento-roundup": {
    url: "https://www.langchain.com/blog/monthly-newsletter-january-2026",
    title: "LangChain Monthly Newsletter — January 2026",
  },
  "lancamento-non-launch-path": {
    // openai.com só entra em LANCAMENTO_PATTERNS via path_pattern restrito a
    // /blog|index|news/ — um "/customers/" nem chega no bloco lançamento
    // pra esse domínio. blogs.nvidia.com está registrado por DOMÍNIO
    // inteiro (LANCAMENTO_DOMAINS), então qualquer path — incluindo um
    // "/customers/" fabricado, sem correspondente real conhecido — entra
    // no bloco e bate NON_LAUNCH_PATH_PATTERNS. Gatilho deliberadamente
    // artificial pela mesma razão que pesquisa-pattern-offtopic acima.
    url: "https://blogs.nvidia.com/blog/customers/acme-partnership/",
    title: "Acme scales manufacturing with NVIDIA",
  },
  "lancamento-openai-frontiers": {
    url: "https://openai.com/index/endava-frontiers",
    title: "Endava Frontiers",
  },
  "lancamento-first-party-tooling-blog": {
    url: "https://huggingface.co/blog/hf-cli-for-agents",
    title: "Introducing the Hugging Face CLI for agents",
  },
  "lancamento-pre-existence": {
    url: "https://openai.com/index/some-feature",
    title: "Some feature, available since 2024",
  },
  "lancamento-incremental-third-party": {
    // Caso real do docblock de isIncrementalReleaseOnThirdPartyBlog: Holo3.1
    // (huggingface.co/blog/Hcompany/holo31) — versão-ponto COLADA ("Holo3.1",
    // sem espaço) em blog de terceiro (2+ segments após /blog/), empresa
    // "Hcompany" fora de KNOWN_COMPANY_SLUGS.
    url: "https://huggingface.co/blog/Hcompany/holo31",
    title: "Holo3.1",
  },
  "lancamento-non-product-official": {
    url: "https://blog.google/technology/ai/celebrating-one-billion-gemma-downloads/",
    title: "Celebrating one billion Gemma downloads",
  },
  "lancamento-type-hint": {
    url: "https://openai.com/index/gpt-6",
    title: "GPT-6",
    type_hint: "lancamento",
  },
  "lancamento-how-collective": {
    // Caso real do docblock de isHowCollectiveReportTitle.
    url: "https://blogs.nvidia.com/blog/nations-deploying-ai/",
    title: "How Nations Are Deploying AI for Strategic Priorities",
  },
  "lancamento-business-deal": {
    url: "https://openai.com/index/openai-acquires-startup-x",
    title: "OpenAI acquires Startup X",
  },
  "lancamento-non-product-announcement": {
    url: "https://openai.com/index/announcing-research-fellowship",
    title: "Announcing the OpenAI Research Fellowship",
  },
  "lancamento-customer-story": {
    url: "https://openai.com/index/how-acme-uses-chatgpt",
    title: "How Acme uses ChatGPT to move faster",
  },
  "lancamento-update": {
    url: "https://openai.com/index/api-changelog-update",
    title: "API changelog: minor update",
  },
  "lancamento-report": {
    // "state of X" sozinho bate NON_PRODUCT_OFFICIAL_PATTERNS antes (rule
    // lancamento-non-product-official), e o path real do exemplo do
    // docblock de isReport (/threat-intelligence-group-report/) já é
    // bloqueado por NON_LAUNCH_PATH_PATTERNS (rule lancamento-non-launch-
    // path) — usar o mesmo sinal de TÍTULO ("read our new report") num
    // path neutro isola o branch de isReport especificamente.
    url: "https://blog.google/technology/safety/latest-defenses-update/",
    title: "Read our new report on AI-powered threats and our latest defenses",
  },
  "lancamento-explainer-title": {
    url: "https://openai.com/index/why-we-built-this",
    title: "Why we built this the way we did",
  },
  "lancamento-likely-news": {
    url: "https://openai.com/index/chatgpt-for-brazil",
    title: "ChatGPT for Brazil",
  },
  "lancamento-third-party-blog": {
    // huggingface.co/blog/{org}/{slug} — 2+ segmentos após /blog/ = terceiro
    // (huggingface.co/blog/{slug}, 1 segmento, é o próprio blog da HF, #2595).
    url: "https://huggingface.co/blog/nvidia/blackwell-architecture-overview",
    title: "An overview of NVIDIA Blackwell architecture",
  },
  "lancamento-research-result": {
    url: "https://openai.com/index/model-disproves-discrete-geometry-conjecture",
    title: "Our model disproves a 30-year-old discrete geometry conjecture",
  },
  "lancamento-logistics-milestone": {
    url: "https://blogs.nvidia.com/blog/vera-cpu-delivery/",
    title: "First Vera CPU units delivered to partners",
  },
  "lancamento-customer-slug": {
    url: "https://openai.com/index/adventhealth",
    title: "AdventHealth",
  },
  "lancamento-research-title": {
    url: "https://openai.com/index/a-new-theory-of-generalization",
    title: "Toward a new theory of generalization",
  },
  "lancamento-technique-title": {
    // Caso real do comentário de TECHNIQUE_IN_LAUNCH_DOMAIN.
    url: "https://huggingface.co/blog/delta-weight-sync-trl",
    title: "Delta Weight Sync in TRL",
  },
  "lancamento-type-hint-pesquisa": {
    url: "https://openai.com/index/some-neutral-post",
    title: "Some neutral post",
    type_hint: "pesquisa",
  },
  "lancamento-type-hint-noticia": {
    url: "https://openai.com/index/some-neutral-post-2",
    title: "Some neutral post two",
    type_hint: "noticia",
  },
  "lancamento-default": {
    // Domínio oficial (blog.google) sem NENHUM override — path fora do
    // prefixo use_melhor=1 do "Blog do Google Brasil", então só "Google
    // Primária" (host-only) casa, e nenhum dos ~25 overrides do bloco
    // lançamento dispara. Fallback verdadeiro.
    url: "https://blog.google/products/search/nova-feature-search-ai/",
    title: "Nova feature de IA no Google Search",
  },
  "type-hint-pesquisa-secondary": {
    url: "https://randomsite.example.com/artigo/pesquisa-nova",
    title: "Artigo qualquer",
    type_hint: "pesquisa",
  },
  "noticias-default": {
    url: "https://techcrunch.com/2026/01/01/random-ai-story",
    title: "Random AI story",
  },
};

describe("categorizeWithRule() — 1 gatilho verificado por regra (cobertura completa, #6647)", () => {
  for (const [expectedRule, article] of Object.entries(RULE_TRIGGERS) as Array<[CategorizationRule, Article]>) {
    it(`"${article.url}" → rule "${expectedRule}"`, () => {
      const result = categorizeWithRule(article);
      assert.equal(result.rule, expectedRule, `esperava rule="${expectedRule}", obteve "${result.rule}"`);
    });
  }

  it("cobre exatamente os 41 rule ids conhecidos (nenhum a mais, nenhum a menos)", () => {
    assert.equal(Object.keys(RULE_TRIGGERS).length, 41);
  });
});

describe("isFallbackCategorizationRule()", () => {
  it("true só para os 2 defaults do motor", () => {
    assert.equal(isFallbackCategorizationRule("lancamento-default"), true);
    assert.equal(isFallbackCategorizationRule("noticias-default"), true);
  });

  it("false para qualquer regra com sinal concreto", () => {
    for (const rule of Object.keys(RULE_TRIGGERS)) {
      if (rule === "lancamento-default" || rule === "noticias-default") continue;
      assert.equal(isFallbackCategorizationRule(rule), false, `${rule} não deveria ser fallback`);
    }
  });
});

describe("categorizeArticles() — category_rule é aditivo, bucket idêntico (#6647)", () => {
  const SAMPLE_ARTICLES: Article[] = Object.values(RULE_TRIGGERS);

  it("cada artigo recebe category_rule sem mudar o bucket resultante", () => {
    const result = categorizeArticles(SAMPLE_ARTICLES);
    for (const bucket of Object.keys(result) as Array<keyof typeof result>) {
      for (const article of result[bucket]) {
        assert.ok((article as any).category, `artigo sem category: ${article.url}`);
        assert.ok((article as any).category_rule, `artigo sem category_rule: ${article.url}`);
      }
    }
  });

  it("bucket de cada artigo bate com categorize() chamado direto (regressão de delegação)", () => {
    const result = categorizeArticles(SAMPLE_ARTICLES);
    const bucketByUrl = new Map<string, string>();
    for (const bucket of Object.keys(result) as Array<keyof typeof result>) {
      for (const article of result[bucket]) {
        bucketByUrl.set(article.url, bucket as string);
      }
    }
    for (const article of SAMPLE_ARTICLES) {
      const expectedCategory = categorize(article);
      const expectedBucket = categoryToBucket(expectedCategory);
      const actualBucket = bucketByUrl.get(article.url);
      // #2986/#697 podem descartar/truncar (gate de relevância-IA, teto de
      // vídeos) — se o artigo sobreviveu ao categorizeArticles, o bucket
      // precisa bater; se não sobreviveu, não é uma divergência de bucket.
      if (actualBucket === undefined) continue;
      assert.equal(actualBucket, expectedBucket, `bucket divergente para ${article.url}`);
    }
  });
});

describe("analyze-bucket-overrides.ts --rules (#6647)", () => {
  it("editionsDirMissing=true quando o diretório nem existe (review item 6)", () => {
    const collected = collectRuleUsage(join(tmpdir(), "does-not-exist-6647-" + Date.now()));
    assert.equal(collected.editionsDirMissing, true);
    assert.equal(collected.totalEditionsDiscovered, 0);
    assert.equal(collected.entries.length, 0);

    const summary = summarizeRuleUsage(collected);
    assert.equal(summary.editionsDirMissing, true);
    assert.equal(summary.articlesWithRule, 0);
  });

  it("totalEditionsDiscovered conta TODAS as edições descobertas, não só as com dado (review item 5)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bucket-rules-discovered-"));
    try {
      // 260901 tem 01-categorized.json com category_rule; 260902 tem a pasta
      // mas SEM 01-categorized.json (edição em progresso); 260903 nem tem
      // _internal — as 3 contam em totalEditionsDiscovered, só a 1ª conta
      // em editionsWithRuleData.
      mkdirSync(join(dir, "260901", "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "260901", "_internal", "01-categorized.json"),
        JSON.stringify({
          lancamento: [{ url: "https://openai.com/index/a", category_rule: "lancamento-type-hint" }],
          radar: [],
          use_melhor: [],
          video: [],
        }),
        "utf8",
      );
      mkdirSync(join(dir, "260902", "_internal"), { recursive: true });
      mkdirSync(join(dir, "260903"), { recursive: true });

      const collected = collectRuleUsage(dir);
      assert.equal(collected.editionsDirMissing, false);
      assert.equal(collected.totalEditionsDiscovered, 3);

      const summary = summarizeRuleUsage(collected);
      assert.equal(summary.totalEditionsDiscovered, 3);
      assert.equal(summary.editionsWithRuleData, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collectRuleUsage/summarizeRuleUsage agregam category_rule de 01-categorized.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "bucket-rules-"));
    try {
      const editionDir = join(dir, "260901");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", "01-categorized.json"),
        JSON.stringify({
          lancamento: [
            { url: "https://openai.com/index/a", category_rule: "lancamento-type-hint" },
            { url: "https://openai.com/index/b", category_rule: "lancamento-default" },
          ],
          radar: [
            { url: "https://techcrunch.com/c", category_rule: "noticias-default" },
          ],
          use_melhor: [
            { url: "https://cookbook.openai.com/d", category_rule: "tutorial-domain" },
          ],
          video: [],
        }),
        "utf8",
      );

      const collected = collectRuleUsage(dir);
      assert.equal(collected.entries.length, 4);

      const summary = summarizeRuleUsage(collected);
      assert.equal(summary.editionsWithRuleData, 1);
      assert.equal(summary.articlesWithRule, 4);
      assert.equal(summary.fallbackArticles, 2); // lancamento-default + noticias-default
      assert.equal(summary.fallbackPct, 50);
      assert.equal(summary.editionsWithPartialRuleData, 0);
      assert.equal(summary.articlesMissingRuleInInstrumentedEditions, 0);

      const lancamentoBucket = summary.byBucket.find((b) => b.bucket === "lancamento");
      assert.ok(lancamentoBucket);
      assert.equal(lancamentoBucket!.total, 2);
      assert.equal(lancamentoBucket!.fallback, 1);

      const defaultRule = summary.byRule.find((r) => r.rule === "lancamento-default");
      assert.ok(defaultRule);
      assert.equal(defaultRule!.fallback, true);
      assert.equal(defaultRule!.count, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("artigo sem category_rule (edição pré-#6647 inteira) é ignorado, não conta como fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "bucket-rules-legacy-"));
    try {
      const editionDir = join(dir, "260801");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", "01-categorized.json"),
        JSON.stringify({
          lancamento: [{ url: "https://openai.com/index/legacy" }], // sem category_rule
          radar: [],
          use_melhor: [],
          video: [],
        }),
        "utf8",
      );

      const collected = collectRuleUsage(dir);
      assert.equal(collected.entries.length, 0);

      const summary = summarizeRuleUsage(collected);
      assert.equal(summary.articlesWithRule, 0);
      assert.equal(summary.fallbackPct, 0);
      // edição legada inteira (0 artigos com regra) não é "parcialmente
      // instrumentada" — distinto do próximo teste (review item 7).
      assert.equal(summary.editionsWithPartialRuleData, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição PARCIALMENTE instrumentada (≥1 artigo com regra, ≥1 sem) é sinalizada (review item 7)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bucket-rules-partial-"));
    try {
      const editionDir = join(dir, "260904");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", "01-categorized.json"),
        JSON.stringify({
          lancamento: [
            { url: "https://openai.com/index/a", category_rule: "lancamento-type-hint" },
            // sem category_rule — dentro de uma edição que TEM outros
            // artigos instrumentados. Semanticamente esperado hoje (item
            // adicionado à mão via apply-gate-edits.ts, sem passar por
            // categorizeWithRule), mas o contador existe pra detectar
            // regressão futura de instrumentação.
            { url: "https://openai.com/index/b-manual" },
          ],
          radar: [],
          use_melhor: [],
          video: [],
        }),
        "utf8",
      );

      const collected = collectRuleUsage(dir);
      const summary = summarizeRuleUsage(collected);
      assert.equal(summary.editionsWithPartialRuleData, 1);
      assert.equal(summary.articlesMissingRuleInInstrumentedEditions, 1);
      assert.equal(summary.articlesWithRule, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
