/**
 * review-use-melhor.test.ts (#1798)
 *
 * Regressão: em 260604 dois posts da latent.space (newsletter/podcast) caíram
 * no bucket use_melhor. O guard deve flagá-los (warn) sem flagar tutoriais reais.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reviewUseMelhor,
  isNewsletterLike,
  hasTutorialSignal,
  isCorporateBlog,
  reviewUseMelhorComposition,
} from "../scripts/review-use-melhor.ts";

describe("reviewUseMelhor — flag de não-tutorial (#1798)", () => {
  it("flaga os 2 itens latent.space de 260604 (newsletter mal-bucketada)", () => {
    const items = [
      { url: "https://www.latent.space/p/2025-ai-engineering", title: "The State of AI Engineering 2025" },
      { url: "https://www.latent.space/p/agents", title: "The Rise of Agents" },
    ];
    const { suspicious, total } = reviewUseMelhor(items);
    assert.equal(total, 2);
    assert.equal(suspicious.length, 2, "ambos latent.space devem ser flagados");
    assert.match(suspicious[0].reasons.join(" "), /newsletter\/agregador/);
  });

  it("NÃO flaga tutorial real de domínio de tutorial (cookbook.openai.com)", () => {
    const items = [
      { url: "https://cookbook.openai.com/examples/structured_outputs_intro", title: "Structured Outputs" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0, "cookbook.openai.com é tutorial domain → não flaga");
  });

  it("NÃO flaga artigo com sinal de tutorial no título (guia/how-to)", () => {
    const items = [
      { url: "https://blog.exemplo.com/post-123", title: "Guia prático: como usar NotebookLM no trabalho" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0, "título com 'guia'/'como usar' = tutorial");
  });

  it("flaga substack/beehiiv (newsletter) sem sinal de tutorial", () => {
    const items = [
      { url: "https://alguem.substack.com/p/analise", title: "Análise da semana em IA" },
      { url: "https://x.beehiiv.com/p/roundup", title: "Weekly roundup" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 2);
  });

  it("NÃO flaga newsletter COM sinal de tutorial (tutorial real de newsletter)", () => {
    // AND-logic: latent.space pode ter tutorial de verdade — não flagar nesse caso.
    const items = [
      { url: "https://www.latent.space/p/how-to-build-rag", title: "How to build a RAG pipeline" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0);
  });

  it("NÃO flaga tutorial de blog pessoal (não-newsletter) com título não-imperativo", () => {
    // Regressão do ruído da lógica OR (review do PR #1816): OR flagava todo
    // tutorial legítimo de domínio neutro sem verbo no título.
    const items = [
      { url: "https://eugeneyan.com/writing/llm-patterns", title: "LLM Patterns" },
      { url: "https://hamel.dev/blog/posts/evals", title: "Your AI Product Needs Evals" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0, "AND-logic: domínio neutro não é flagado");
  });

  it("ignora itens sem url; conta total corretamente", () => {
    const items = [{ title: "sem url" }, { url: "https://cookbook.openai.com/x", title: "Tutorial" }];
    const { suspicious, total } = reviewUseMelhor(items);
    assert.equal(total, 2);
    assert.equal(suspicious.length, 0);
  });
});

describe("helpers puros (#1798)", () => {
  it("isNewsletterLike: latent.space, substack, aggregator", () => {
    assert.ok(isNewsletterLike("https://www.latent.space/p/x"));
    assert.ok(isNewsletterLike("https://y.substack.com/p/x"));
    assert.ok(!isNewsletterLike("https://cookbook.openai.com/x"));
  });

  it("hasTutorialSignal: título com verbo, slug com verbo, tutorial host", () => {
    assert.ok(hasTutorialSignal("https://x.com/y", "Como criar um agente"));
    assert.ok(hasTutorialSignal("https://x.com/how-to-build-rag", "RAG"));
    assert.ok(hasTutorialSignal("https://huggingface.co/learn/x", "NLP"));
    assert.ok(!hasTutorialSignal("https://x.com/news-item", "OpenAI lança modelo"));
  });

  it("hasTutorialSignal: formas no gerúndio (fix #2321 finding 2)", () => {
    // AWS tutorials com gerúndio no título não devem ser falso-flagados
    assert.ok(hasTutorialSignal("https://aws.amazon.com/blogs/ml/x", "Deploying Gemma 4 on SageMaker Studio"));
    assert.ok(hasTutorialSignal("https://aws.amazon.com/blogs/ml/x", "Building a RAG pipeline with Bedrock"));
    assert.ok(hasTutorialSignal("https://aws.amazon.com/blogs/ml/x", "Creating a serverless API with Lambda"));
  });
});

describe("isCorporateBlog + reviewUseMelhor — guarda corporativo (#2313 / #2321)", () => {
  it("isCorporateBlog: aws.amazon.com e blog.langchain.dev são corporativos", () => {
    assert.ok(isCorporateBlog("https://aws.amazon.com/blogs/machine-learning/x"), "aws.amazon.com deve ser corporativo");
    assert.ok(isCorporateBlog("https://blog.langchain.dev/how-langchain-made-x/"), "blog.langchain.dev deve ser corporativo (fix #2321 finding 1)");
    assert.ok(isCorporateBlog("https://cloud.google.com/blog/topics/ai/x"), "cloud.google.com deve ser corporativo");
    assert.ok(!isCorporateBlog("https://huggingface.co/blog/x"), "huggingface.co NÃO é corporativo neste sentido");
  });

  it("flaga aws.amazon.com SEM sinal de tutorial (true positive — evita case study no use_melhor)", () => {
    const items = [
      { url: "https://aws.amazon.com/blogs/machine-learning/introducing-bedrock-enterprise/", title: "Introducing Amazon Bedrock Enterprise" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 1, "AWS case study/anúncio sem how-to deve ser flagado");
    assert.match(suspicious[0].reasons.join(" "), /corporativo/);
  });

  it("NÃO flaga aws.amazon.com COM sinal de tutorial (false positive evitado)", () => {
    const items = [
      { url: "https://aws.amazon.com/blogs/machine-learning/deploy-gemma-4-on-sagemaker/", title: "Deploying Gemma 4 on SageMaker Studio" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0, "AWS tutorial com gerúndio não deve ser flagado");
  });

  it("flaga blog.langchain.dev SEM sinal de tutorial (true positive)", () => {
    const items = [
      { url: "https://blog.langchain.dev/how-langchain-made-x-predictable/", title: "How LangChain Made X Predictable" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 1, "LangChain case study sem how-to deve ser flagado");
  });

  it("NÃO flaga blog.langchain.dev COM sinal de tutorial", () => {
    const items = [
      { url: "https://blog.langchain.dev/how-to-build-agents/", title: "Como construir agentes com LangChain" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0, "LangChain com how-to = tutorial real, não deve ser flagado");
  });
});

// ---------------------------------------------------------------------------
// #2339 — reviewUseMelhorComposition: guard casual/iniciante
// ---------------------------------------------------------------------------

describe("reviewUseMelhorComposition (#2339) — guard de composição casual/iniciante", () => {
  it("lista vazia: sem warnings, tudo zerado", () => {
    const result = reviewUseMelhorComposition([]);
    assert.equal(result.casualCount, 0);
    assert.equal(result.beginnerCount, 0);
    assert.equal(result.advancedCount, 0);
    assert.equal(result.missingCasual, true, "0 itens = 0 casual = missingCasual");
    assert.equal(result.missingBeginner, true, "0 itens = 0 iniciante = missingBeginner");
    assert.deepEqual(result.breakdown, []);
  });

  it("somente itens dev-avancado: missingCasual=true AND missingBeginner=true (caso 260617)", () => {
    // Replica o caso real de 260617: 4 itens todos avançados
    const items = [
      {
        url: "https://blog.langchain.dev/building-end-to-end-sentiment-analysis/",
        title: "Building an End-to-End Sentiment Analysis Pipeline with Scikit-LLM",
      },
      {
        url: "https://blog.langchain.dev/designing-efficient-verifiers/",
        title: "Designing Efficient Verifiers for Legal Agents",
      },
      {
        url: "https://developers.googleblog.com/gemma4-visual-guide",
        title: "A Visual Guide to Gemma 4 12B",
      },
      {
        url: "https://cloud.google.com/blog/topics/tpu-stack",
        title: "Unlocking the Power of the TPU Stack",
      },
    ];
    const result = reviewUseMelhorComposition(items);
    assert.equal(result.missingCasual, true, "caso 260617: zero casual itens");
    assert.equal(result.missingBeginner, true, "caso 260617: zero dev-iniciante itens");
    assert.equal(result.advancedCount, items.length);
  });

  it("missingCasual=false quando há item casual (howto_br:true no matched)", () => {
    const items = [
      {
        url: "https://canaltech.com.br/ia/como-usar-chatgpt-curriculo",
        title: "Como usar ChatGPT para criar currículo passo a passo",
        audience_affinity: { matched: ["howto_br:true", "howto_br_source:true"] },
      },
      {
        url: "https://blog.langchain.dev/rag-pipeline",
        title: "Building RAG Pipeline with LangGraph",
      },
    ];
    const result = reviewUseMelhorComposition(items);
    assert.equal(result.casualCount, 1, "item com howto_br:true deve ser casual");
    assert.equal(result.missingCasual, false, "tem item casual → missingCasual=false");
    assert.equal(result.missingBeginner, true, "ainda sem dev-iniciante");
  });

  it("missingBeginner=false quando há item dev-iniciante (academy:true no matched)", () => {
    const items = [
      {
        url: "https://learn.deeplearning.ai/courses/prompt-engineering",
        title: "Prompt Engineering for Developers",
        audience_affinity: { matched: ["academy:true"] },
      },
      {
        url: "https://blog.langchain.dev/rag-pipeline",
        title: "Building RAG Pipeline with LangGraph",
      },
    ];
    const result = reviewUseMelhorComposition(items);
    assert.equal(result.beginnerCount, 1, "academy:true = dev-iniciante");
    assert.equal(result.missingBeginner, false, "tem dev-iniciante → missingBeginner=false");
    assert.equal(result.missingCasual, true, "ainda sem casual");
  });

  it("2+2 perfeito: missingCasual=false AND missingBeginner=false", () => {
    const items = [
      {
        url: "https://canaltech.com.br/ia/chatgpt-produtividade",
        title: "ChatGPT para produtividade no trabalho passo a passo",
        audience_affinity: { matched: ["howto_br:true"] },
      },
      {
        url: "https://exame.com/ia/como-usar-ia-financas",
        title: "Como usar IA para finanças pessoais guia pratico",
        audience_affinity: { matched: ["howto_br_source:true"] },
      },
      {
        url: "https://learn.deeplearning.ai/courses/chatgpt-api",
        title: "ChatGPT API for Developers",
        audience_affinity: { matched: ["academy:true"] },
      },
      {
        url: "https://huggingface.co/learn/nlp-course",
        title: "Getting Started with NLP and Transformers",
        audience_affinity: { matched: ["academy:true"] },
      },
    ];
    const result = reviewUseMelhorComposition(items);
    assert.equal(result.casualCount, 2);
    assert.equal(result.beginnerCount, 2);
    assert.equal(result.missingCasual, false, "2 casuais → missingCasual=false");
    assert.equal(result.missingBeginner, false, "2 iniciantes → missingBeginner=false");
  });

  it("breakdown contém todos os itens com classe atribuída", () => {
    const items = [
      { url: "https://canaltech.com.br/ia/x", title: "ChatGPT passo a passo", audience_affinity: { matched: ["howto_br:true"] } },
      { url: "https://blog.langchain.dev/rag", title: "RAG Pipeline LangGraph" },
    ];
    const result = reviewUseMelhorComposition(items);
    assert.equal(result.breakdown.length, 2);
    const casual = result.breakdown.find((b) => b.url.includes("canaltech"));
    assert.ok(casual, "item canaltech deve estar no breakdown");
    assert.equal(casual?.class, "casual");
  });

  it("missingCasual=false quando item tem sinal casual no título (sem audience_affinity)", () => {
    // classifyAudienceClass usa o texto mesmo sem audience_affinity anotado
    const items = [
      {
        url: "https://example.com/chatgpt-para-trabalho",
        title: "ChatGPT para produtividade no trabalho passo a passo para iniciantes",
      },
    ];
    const result = reviewUseMelhorComposition(items);
    assert.equal(result.casualCount, 1, "sinal casual no título sem anotação = casual");
    assert.equal(result.missingCasual, false);
  });
});
