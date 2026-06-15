/**
 * use-melhor-curation.test.ts (#2276, #2278)
 *
 * Testes unitários para scripts/lib/use-melhor-curation.ts.
 * Cobre todas as funções determinísticas exportadas:
 *   #2276: isTutorialAcademy, isMarketingCaseStudy, rootDomain, topicTokens, dedupeUseMelhorBucket
 *   #2278: isHowtoBrAllowlisted, hasHowToBrSignal, getHowToDiscoveryQueries
 *
 * Regressões documentadas:
 *   - 260615: 3/5 itens em use_melhor eram AWS Bedrock (domain cap fix)
 *   - 260615: 2 near-duplicates "document processing" (thematic dedup fix)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isTutorialAcademy,
  isMarketingCaseStudy,
  rootDomain,
  topicTokens,
  dedupeUseMelhorBucket,
  isHowtoBrAllowlisted,
  hasHowToBrSignal,
  getHowToDiscoveryQueries,
  HOWTO_BR_DISCOVERY_TOPICS,
  HOWTO_BR_ALLOWLIST,
  TUTORIAL_ACADEMY_DOMAINS,
} from "../scripts/lib/use-melhor-curation.ts";

// ---------------------------------------------------------------------------
// isTutorialAcademy (#2276)
// ---------------------------------------------------------------------------

describe("isTutorialAcademy (#2276)", () => {
  it("reconhece domínio de ensino oficial (deeplearning.ai)", () => {
    assert.ok(isTutorialAcademy("https://learn.deeplearning.ai/courses/chatgpt-prompt-eng", ""));
  });

  it("reconhece Hugging Face /learn path", () => {
    assert.ok(isTutorialAcademy("https://huggingface.co/learn/nlp-course/chapter1/1", ""));
  });

  it("reconhece OpenAI cookbook path", () => {
    assert.ok(isTutorialAcademy("https://cookbook.openai.com/examples/structured_outputs_intro", ""));
  });

  it("reconhece Microsoft Learn /en-us/training path", () => {
    assert.ok(isTutorialAcademy("https://learn.microsoft.com/en-us/training/paths/intro-to-ml-ai", ""));
  });

  it("reconhece título com 'curso'", () => {
    assert.ok(isTutorialAcademy("https://blog.exemplo.com/post", "Curso completo de LangChain para iniciantes"));
  });

  it("reconhece título com 'trilha'", () => {
    assert.ok(isTutorialAcademy("https://blog.exemplo.com/post", "Trilha de aprendizado: IA generativa"));
  });

  it("reconhece título com 'bootcamp'", () => {
    assert.ok(isTutorialAcademy("https://blog.exemplo.com/post", "Bootcamp de MLOps: do zero ao deploy"));
  });

  it("reconhece título com 'formação'", () => {
    assert.ok(isTutorialAcademy("https://blog.exemplo.com/post", "Formação em IA: guia prático"));
  });

  it("reconhece título com 'learning path'", () => {
    assert.ok(isTutorialAcademy("https://blog.exemplo.com/post", "Learning Path: Build AI Applications"));
  });

  it("NÃO reconhece artigo de notícia genérico", () => {
    assert.ok(!isTutorialAcademy("https://techcrunch.com/2026/01/01/openai-launches-gpt5", "OpenAI lança GPT-5"));
  });

  it("NÃO reconhece case study de blog corporativo", () => {
    assert.ok(!isTutorialAcademy(
      "https://aws.amazon.com/solutions/case-studies/acme-bedrock",
      "How ACME Corp optimized document processing with AWS Bedrock",
    ));
  });

  it("reconhece Kaggle", () => {
    assert.ok(isTutorialAcademy("https://kaggle.com/learn/intro-to-machine-learning", "Intro to ML"));
  });

  it("reconhece Alura (BR)", () => {
    assert.ok(isTutorialAcademy("https://cursos.alura.com.br/course/chatgpt-api", "ChatGPT API"));
  });
});

// ---------------------------------------------------------------------------
// isMarketingCaseStudy (#2276)
// ---------------------------------------------------------------------------

describe("isMarketingCaseStudy (#2276)", () => {
  it("detecta 'How Rocket Close optimized document processing'", () => {
    assert.ok(isMarketingCaseStudy(
      "How Rocket Close Optimized Document Processing with AWS Bedrock",
      "",
    ));
  });

  it("detecta 'How Acme Corp leveraged AI to cut costs'", () => {
    assert.ok(isMarketingCaseStudy(
      "How Acme Corp Leveraged AI to Cut Costs by 40%",
      "",
    ));
  });

  it("detecta case study com 'case study:' no título", () => {
    assert.ok(isMarketingCaseStudy(
      "Case Study: How Bank XYZ automated customer service",
      "",
    ));
  });

  it("detecta 'how we built' com sinal de ROI no summary", () => {
    assert.ok(isMarketingCaseStudy(
      "How We Built Our AI Customer Service Bot",
      "We achieved 60% cost savings and 3x productivity gain in 6 months.",
    ));
  });

  it("NÃO detecta 'how we built' sem sinal de ROI/business (editorial genuíno)", () => {
    assert.ok(!isMarketingCaseStudy(
      "How We Built a RAG Pipeline with LangChain",
      "Step-by-step guide to building retrieval-augmented generation.",
    ));
  });

  it("NÃO detecta 'How to build...' (tutorial genuíno)", () => {
    assert.ok(!isMarketingCaseStudy(
      "How to Build a Simple Chatbot with Python",
      "This tutorial covers the basics of building a chatbot from scratch.",
    ));
  });

  it("NÃO detecta 'Como usar IA para entrevista' (how-to PT-BR)", () => {
    assert.ok(!isMarketingCaseStudy(
      "Como usar IA para se preparar para entrevista de emprego",
      "Aprenda a usar ChatGPT e outras ferramentas de IA para se destacar.",
    ));
  });

  it("NÃO detecta artigo de lançamento", () => {
    assert.ok(!isMarketingCaseStudy(
      "Google lança Gemini 2.0 com suporte a raciocínio",
      "Nova versão do modelo multimodal do Google chega com melhorias.",
    ));
  });

  it("detecta 'Company X cuts processing time by 50%'", () => {
    assert.ok(isMarketingCaseStudy(
      "Startup Fintech Cuts Processing Time by 50% Using AI",
      "",
    ));
  });
});

// ---------------------------------------------------------------------------
// rootDomain (#2276)
// ---------------------------------------------------------------------------

describe("rootDomain (#2276)", () => {
  it("extrai domínio raiz simples", () => {
    assert.equal(rootDomain("https://techcrunch.com/post"), "techcrunch.com");
  });

  it("remove subdomínio (aws.amazon.com → amazon.com)", () => {
    assert.equal(rootDomain("https://aws.amazon.com/bedrock/tutorials"), "amazon.com");
  });

  it("preserva ccTLD duplo .com.br (canaltech)", () => {
    assert.equal(rootDomain("https://canaltech.com.br/post/123"), "canaltech.com.br");
  });

  it("preserva ccTLD duplo .com.br (techtudo)", () => {
    assert.equal(rootDomain("https://techtudo.globo.com/artigo"), "globo.com");
  });

  it("trata URL inválida como vazio", () => {
    assert.equal(rootDomain("nao-e-uma-url"), "");
  });

  it("amazon.co.uk → amazon.co.uk (ccTLD .co.uk)", () => {
    assert.equal(rootDomain("https://amazon.co.uk/shop"), "amazon.co.uk");
  });
});

// ---------------------------------------------------------------------------
// topicTokens (#2276)
// ---------------------------------------------------------------------------

describe("topicTokens (#2276)", () => {
  it("extrai tokens do título (remove stopwords)", () => {
    const tokens = topicTokens("Como usar IA para processar documentos com AWS Bedrock");
    // "como", "usar", "para", "com" são stopwords; "IA" < 4 chars
    assert.ok(tokens.has("documentos"));
    assert.ok(tokens.has("bedrock"));
    assert.ok(!tokens.has("como"));
    assert.ok(!tokens.has("usar"));
    assert.ok(!tokens.has("para"));
  });

  it("extrai tokens de título inglês", () => {
    const tokens = topicTokens("Building a RAG Pipeline with LangChain");
    assert.ok(tokens.has("pipeline"));
    assert.ok(tokens.has("langchain"));
    assert.ok(!tokens.has("with")); // stopword
    assert.ok(!tokens.has("building")); // stopword "build"
  });

  it("retorna Set vazio para título vazio", () => {
    const tokens = topicTokens("");
    assert.equal(tokens.size, 0);
  });
});

// ---------------------------------------------------------------------------
// dedupeUseMelhorBucket (#2276) — regressão 260615
// ---------------------------------------------------------------------------

describe("dedupeUseMelhorBucket (#2276) — regressão 260615", () => {
  const awsItems = [
    { url: "https://aws.amazon.com/blogs/machine-learning/bedrock-intro", title: "AWS Bedrock: introdução ao serviço" },
    { url: "https://aws.amazon.com/blogs/machine-learning/bedrock-agents", title: "AWS Bedrock: criando agentes" },
    { url: "https://aws.amazon.com/blogs/machine-learning/bedrock-rag", title: "AWS Bedrock: retrieval augmented generation" },
  ];

  it("cap por domínio: 3 itens AWS → 1 após cap (maxPerDomain=1)", () => {
    const result = dedupeUseMelhorBucket(awsItems, { maxPerDomain: 1 });
    assert.equal(result.length, 1, "deve manter só 1 de amazon.com");
    assert.equal(result[0].url, awsItems[0].url, "deve manter o primeiro (maior score presumido)");
  });

  it("cap por domínio: maxPerDomain=2 → mantém 2", () => {
    const result = dedupeUseMelhorBucket(awsItems, { maxPerDomain: 2 });
    assert.equal(result.length, 2);
  });

  it("de-dup temático: 2 artigos sobre 'document processing' → 1", () => {
    const items = [
      { url: "https://blog.a.com/post1", title: "Automated Document Processing with AI" },
      { url: "https://blog.b.com/post2", title: "Document Processing Automation using LLMs" },
    ];
    const result = dedupeUseMelhorBucket(items, { minSharedTokens: 2 });
    assert.equal(result.length, 1, "segundo é near-duplicate do primeiro");
    assert.equal(result[0].url, items[0].url, "mantém o primeiro");
  });

  it("de-dup temático NÃO remove artigos distintos", () => {
    const items = [
      { url: "https://blog.a.com/post1", title: "Como usar IA para entrevista de emprego" },
      { url: "https://blog.b.com/post2", title: "Transformers.js: run models in the browser" },
    ];
    const result = dedupeUseMelhorBucket(items);
    assert.equal(result.length, 2, "artigos distintos devem ser mantidos");
  });

  it("mistura de cap e dedup: 5 itens → máximo razoável", () => {
    const items = [
      { url: "https://aws.amazon.com/bedrock/a", title: "AWS Bedrock tutorial completo" },
      { url: "https://aws.amazon.com/bedrock/b", title: "AWS Bedrock agentes inteligentes" }, // bloqueado: domínio cap
      { url: "https://aws.amazon.com/bedrock/c", title: "AWS Bedrock RAG pipeline" },         // bloqueado: domínio cap
      { url: "https://huggingface.co/blog/text-generation", title: "Text Generation with Transformers" },
      { url: "https://huggingface.co/blog/agents-intro", title: "Agents Introduction and Tutorial" }, // bloqueado: domínio cap
    ];
    const result = dedupeUseMelhorBucket(items, { maxPerDomain: 1 });
    // amazon.com: 1 item (a); huggingface.co: 1 item (text-generation)
    assert.equal(result.length, 2);
  });

  it("itens sem título não são removidos por dedup temático", () => {
    const items = [
      { url: "https://blog.a.com/post1" },
      { url: "https://blog.b.com/post2" },
    ];
    const result = dedupeUseMelhorBucket(items);
    assert.equal(result.length, 2, "itens sem título passam pelo dedup");
  });

  it("lista vazia retorna vazia", () => {
    assert.deepEqual(dedupeUseMelhorBucket([]), []);
  });
});

// ---------------------------------------------------------------------------
// isHowtoBrAllowlisted (#2278)
// ---------------------------------------------------------------------------

describe("isHowtoBrAllowlisted (#2278)", () => {
  it("canaltech.com.br está na allowlist", () => {
    assert.ok(isHowtoBrAllowlisted("https://canaltech.com.br/ia/como-usar-chatgpt-nas-entrevistas/"));
  });

  it("tecnoblog.net está na allowlist", () => {
    assert.ok(isHowtoBrAllowlisted("https://tecnoblog.net/responde/como-usar-ia"));
  });

  it("techtudo.globo.com está na allowlist", () => {
    assert.ok(isHowtoBrAllowlisted("https://techtudo.globo.com/noticias/2026/05/tutorial.html"));
  });

  it("exame.com está na allowlist", () => {
    assert.ok(isHowtoBrAllowlisted("https://exame.com/tecnologia/como-usar-ia-no-trabalho"));
  });

  it("findskill.ai NÃO está na allowlist (SEO farm)", () => {
    assert.ok(!isHowtoBrAllowlisted("https://findskill.ai/como-usar-chatgpt"));
  });

  it("gptprompts.ai NÃO está na allowlist (SEO farm)", () => {
    assert.ok(!isHowtoBrAllowlisted("https://gptprompts.ai/guia-ia"));
  });

  it("techcrunch.com NÃO está na allowlist (EN)", () => {
    assert.ok(!isHowtoBrAllowlisted("https://techcrunch.com/post"));
  });

  it("URL inválida retorna false", () => {
    assert.ok(!isHowtoBrAllowlisted("nao-e-url"));
  });

  it("todos os 9 itens da allowlist são detectados", () => {
    const urls = [
      "https://canaltech.com.br/ia/x",
      "https://tecnoblog.net/x",
      "https://techtudo.globo.com/x",
      "https://olhardigital.com.br/x",
      "https://meiobit.com/x",
      "https://startups.com.br/x",
      "https://exame.com/x",
      "https://infomoney.com.br/x",
      "https://b9.com.br/x",
    ];
    for (const url of urls) {
      assert.ok(isHowtoBrAllowlisted(url), `${url} deve estar na allowlist`);
    }
    assert.equal(HOWTO_BR_ALLOWLIST.size, 9);
  });
});

// ---------------------------------------------------------------------------
// hasHowToBrSignal (#2278)
// ---------------------------------------------------------------------------

describe("hasHowToBrSignal (#2278)", () => {
  it("detecta 'Como usar IA para entrevista' no título", () => {
    assert.ok(hasHowToBrSignal(
      "https://canaltech.com.br/ia/post",
      "Como usar IA para se preparar para uma entrevista de emprego",
    ));
  });

  it("detecta 'Como usar ChatGPT para criar currículo'", () => {
    assert.ok(hasHowToBrSignal(
      "https://tecnoblog.net/post",
      "Como usar ChatGPT para criar um currículo impactante",
    ));
  });

  it("detecta 'IA para produtividade no trabalho'", () => {
    assert.ok(hasHowToBrSignal(
      "https://exame.com/post",
      "Inteligência artificial para produtividade no trabalho: guia 2026",
    ));
  });

  it("detecta 'passo a passo para IA' no título", () => {
    assert.ok(hasHowToBrSignal(
      "https://blog.com/post",
      "Passo a passo para usar IA no seu negócio",
    ));
  });

  it("detecta sinal no slug da URL (título neutro)", () => {
    assert.ok(hasHowToBrSignal(
      "https://canaltech.com.br/ia/como-usar-ia-para-entrevista-de-emprego",
      "5 dicas para se destacar no mercado de trabalho",
    ));
  });

  it("detecta 'como usar claude para' no título", () => {
    assert.ok(hasHowToBrSignal(
      "https://blog.com/post",
      "Como usar Claude para automatizar tarefas repetitivas",
    ));
  });

  it("NÃO detecta artigo de lançamento em PT-BR", () => {
    assert.ok(!hasHowToBrSignal(
      "https://olhardigital.com.br/noticia/google-lanca-gemini-2",
      "Google lança Gemini 2.0 com suporte a raciocínio avançado",
    ));
  });

  it("NÃO detecta tutorial genérico inglês", () => {
    assert.ok(!hasHowToBrSignal(
      "https://blog.com/how-to-build-rag",
      "How to Build a RAG Pipeline with LangChain",
    ));
  });

  it("NÃO detecta artigo de análise sem howto signal", () => {
    assert.ok(!hasHowToBrSignal(
      "https://exame.com/tecnologia/ia-no-mercado-2026",
      "O estado da IA no mercado brasileiro em 2026",
    ));
  });
});

// ---------------------------------------------------------------------------
// getHowToDiscoveryQueries (#2278)
// ---------------------------------------------------------------------------

describe("getHowToDiscoveryQueries (#2278)", () => {
  it("retorna 3 queries por default", () => {
    const queries = getHowToDiscoveryQueries(260615);
    assert.equal(queries.length, 3);
  });

  it("retorna count customizado", () => {
    const queries = getHowToDiscoveryQueries(260615, 5);
    assert.equal(queries.length, 5);
  });

  it("retorna strings não-vazias", () => {
    const queries = getHowToDiscoveryQueries(260615);
    for (const q of queries) {
      assert.ok(q.length > 10, `query muito curta: ${q}`);
    }
  });

  it("edições diferentes rotacionam queries (variedade)", () => {
    const q1 = getHowToDiscoveryQueries(260615);
    const q2 = getHowToDiscoveryQueries(260616);
    // Devem ser distintas (rotação por edição)
    assert.notDeepEqual(q1, q2, "edições consecutivas devem ter queries distintas");
  });

  it("rotação é determinística (mesma edição = mesmos resultados)", () => {
    const q1 = getHowToDiscoveryQueries(260615);
    const q2 = getHowToDiscoveryQueries(260615);
    assert.deepEqual(q1, q2, "saída é determinística para a mesma edição");
  });

  it("usa somente queries do HOWTO_BR_DISCOVERY_TOPICS", () => {
    const queries = getHowToDiscoveryQueries(260615, HOWTO_BR_DISCOVERY_TOPICS.length);
    for (const q of queries) {
      assert.ok(HOWTO_BR_DISCOVERY_TOPICS.includes(q), `query desconhecida: ${q}`);
    }
  });

  it("pool tem 12 temas distintos", () => {
    assert.equal(HOWTO_BR_DISCOVERY_TOPICS.length, 12);
    const unique = new Set(HOWTO_BR_DISCOVERY_TOPICS);
    assert.equal(unique.size, 12, "todos os temas devem ser únicos");
  });

  it("count=0 retorna vazio", () => {
    const queries = getHowToDiscoveryQueries(260615, 0);
    assert.deepEqual(queries, []);
  });
});

// ---------------------------------------------------------------------------
// TUTORIAL_ACADEMY_DOMAINS sanity check
// ---------------------------------------------------------------------------

describe("TUTORIAL_ACADEMY_DOMAINS sanity (#2276)", () => {
  it("contém pelo menos 10 domínios conhecidos", () => {
    assert.ok(TUTORIAL_ACADEMY_DOMAINS.size >= 10, `esperado >= 10, got ${TUTORIAL_ACADEMY_DOMAINS.size}`);
  });

  it("kaggle.com está presente", () => {
    assert.ok(TUTORIAL_ACADEMY_DOMAINS.has("kaggle.com"));
  });

  it("learn.deeplearning.ai está presente", () => {
    assert.ok(TUTORIAL_ACADEMY_DOMAINS.has("learn.deeplearning.ai"));
  });
});
