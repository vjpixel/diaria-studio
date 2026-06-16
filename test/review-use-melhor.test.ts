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
