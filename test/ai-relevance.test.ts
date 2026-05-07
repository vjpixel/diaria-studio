/**
 * ai-relevance.test.ts (#642) — tests for scripts/lib/ai-relevance.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AI_RELEVANT_TERMS,
  AI_RELEVANT_URL_SLUG,
  AI_RELEVANT_DOMAINS,
  containsAITerms,
  urlHasAISlug,
  isAIRelevantDomain,
  isArticleAIRelevant,
} from "../scripts/lib/ai-relevance.ts";

describe("AI_RELEVANT_TERMS regex (#642)", () => {
  it("match em LLM, llm, Llm (case-insensitive com flag i)", () => {
    assert.ok(AI_RELEVANT_TERMS.test("LLM benchmarks"));
    assert.ok(AI_RELEVANT_TERMS.test("the llm landscape"));
    assert.ok(AI_RELEVANT_TERMS.test("Llm comparison study"));
  });

  it("match em termos compostos: language model, neural network, deep learning", () => {
    assert.ok(AI_RELEVANT_TERMS.test("a new language model"));
    assert.ok(AI_RELEVANT_TERMS.test("neural networks at scale"));
    assert.ok(AI_RELEVANT_TERMS.test("deep learning advances"));
  });

  it("match em termos modernos: RAG, agent, alignment, fine-tuning", () => {
    assert.ok(AI_RELEVANT_TERMS.test("RAG with vector DBs"));
    assert.ok(AI_RELEVANT_TERMS.test("agent framework"));
    assert.ok(AI_RELEVANT_TERMS.test("alignment research"));
    assert.ok(AI_RELEVANT_TERMS.test("fine-tuning workflow"));
    assert.ok(AI_RELEVANT_TERMS.test("fine_tuning"));
    assert.ok(AI_RELEVANT_TERMS.test("fine tuning"));
  });

  it("match em domínios aplicados: protein, genomic, drug discovery", () => {
    assert.ok(AI_RELEVANT_TERMS.test("protein folding via diffusion"));
    assert.ok(AI_RELEVANT_TERMS.test("genomic sequence analysis"));
    assert.ok(AI_RELEVANT_TERMS.test("drug discovery pipeline"));
  });

  it("não confunde substrings — boundary `\\b` evita false-positive", () => {
    // "llm" como prefixo de palavra maior não match (\b antes/depois)
    assert.equal(AI_RELEVANT_TERMS.test("controllment"), false);
    assert.equal(AI_RELEVANT_TERMS.test("rage quit"), false);
  });

  it("texto sem termo de IA → false", () => {
    assert.equal(AI_RELEVANT_TERMS.test("market analysis trends"), false);
    assert.equal(AI_RELEVANT_TERMS.test("eclipse coverage 2024"), false);
    assert.equal(AI_RELEVANT_TERMS.test(""), false);
  });
});

describe("containsAITerms (#642)", () => {
  it("string com termo → true", () => {
    assert.equal(containsAITerms("transformers are everywhere"), true);
  });

  it("string sem termo → false", () => {
    assert.equal(containsAITerms("food recipes 2024"), false);
  });

  it("null/undefined → false sem crashar", () => {
    assert.equal(containsAITerms(null), false);
    assert.equal(containsAITerms(undefined), false);
  });

  it("string vazia → false", () => {
    assert.equal(containsAITerms(""), false);
  });
});

describe("isArticleAIRelevant (#642)", () => {
  it("article com termo no título → true", () => {
    assert.equal(isArticleAIRelevant({ title: "New diffusion model from Anthropic" }), true);
  });

  it("article com termo só no summary → true", () => {
    assert.equal(
      isArticleAIRelevant({
        title: "OpenAI announces new product",
        summary: "The product uses transformer architecture for reasoning",
      }),
      true,
    );
  });

  it("article sem termo em ambos os campos → false", () => {
    assert.equal(
      isArticleAIRelevant({ title: "Tech market roundup", summary: "stocks and trends" }),
      false,
    );
  });

  it("article sem title nem summary → false", () => {
    assert.equal(isArticleAIRelevant({}), false);
  });

  it("article com title vazio + summary com termo → true", () => {
    assert.equal(
      isArticleAIRelevant({ title: "", summary: "GPT-4 alignment research" }),
      true,
    );
  });
});

describe("AI_RELEVANT_TERMS regex — expansão #901 (produtos/empresas/PT-BR)", () => {
  it("match em nomes de produto: ChatGPT, Claude, Gemini, Codex, Copilot, Grok, Sora", () => {
    assert.ok(containsAITerms("Anthropic launches Claude 5"));
    assert.ok(containsAITerms("ChatGPT update for enterprise"));
    assert.ok(containsAITerms("Google Gemini surpasses benchmarks"));
    assert.ok(containsAITerms("GitHub Copilot now supports voice"));
    assert.ok(containsAITerms("Grok 4 from xAI"));
    assert.ok(containsAITerms("OpenAI Sora video generation"));
    assert.ok(containsAITerms("Codex available for developers"));
  });

  it("match em nomes de empresa: OpenAI, Anthropic, DeepMind, xAI, Cohere, HuggingFace", () => {
    assert.ok(containsAITerms("OpenAI tem novo deal de compute"));
    assert.ok(containsAITerms("Anthropic agreement with SpaceX"));
    assert.ok(containsAITerms("DeepMind research paper"));
    assert.ok(containsAITerms("xAI raises Series E"));
    assert.ok(containsAITerms("HuggingFace launches new tool"));
    assert.ok(containsAITerms("Hugging Face em parceria"));
  });

  it("match em termos PT-BR compostos: 'inteligência artificial', 'chips de IA', 'agente de IA'", () => {
    assert.ok(containsAITerms("notícias sobre inteligência artificial"));
    assert.ok(containsAITerms("plano para fábrica de chips de IA"));
    assert.ok(containsAITerms("agente de IA para suporte"));
    assert.ok(containsAITerms("data center de IA na Bahia"));
    assert.ok(containsAITerms("modelo de linguagem brasileiro"));
    assert.ok(containsAITerms("aprendizado de máquina aplicado"));
  });

  it("match em hardware: GPU, TPU, H100, B200, CUDA", () => {
    assert.ok(containsAITerms("Nvidia anuncia novas GPUs"));
    assert.ok(containsAITerms("Cluster com H100 da Nvidia"));
    assert.ok(containsAITerms("B200 supera anterior"));
    assert.ok(containsAITerms("Otimização CUDA para LLMs"));
  });

  it("match em conceitos modernos: agente, tool use, MCP, context window", () => {
    assert.ok(containsAITerms("Novo padrão MCP da Anthropic"));
    assert.ok(containsAITerms("Tool use em agentes"));
    assert.ok(containsAITerms("Context window de 1M tokens"));
    assert.ok(containsAITerms("Sistema agentic complexo"));
  });

  it("não confunde: 'opensea' não match 'openai'", () => {
    // boundary \b deve evitar substring match
    assert.equal(containsAITerms("opensea marketplace"), false);
  });
});

describe("AI_RELEVANT_URL_SLUG / urlHasAISlug (#901)", () => {
  it("URL com /ai- segment → true", () => {
    assert.equal(
      urlHasAISlug("https://tomshardware.com/news/let-us-government-test-ai-models"),
      true,
    );
    assert.equal(
      urlHasAISlug("https://gizmochina.com/2026/05/02/sam-altman-ai-jobs-future/"),
      true,
    );
  });

  it("URL com /inteligencia-artificial/ → true", () => {
    assert.equal(
      urlHasAISlug("https://canaltech.com.br/inteligencia-artificial/algum-artigo"),
      true,
    );
  });

  it("URL com /artificial-intelligence/ → true", () => {
    assert.equal(
      urlHasAISlug("https://reuters.com/technology/artificial-intelligence/article"),
      true,
    );
  });

  it("URL com /machine-learning/ → true", () => {
    assert.equal(
      urlHasAISlug("https://aws.amazon.com/blogs/machine-learning/post"),
      true,
    );
  });

  it("URL sem slug AI → false", () => {
    assert.equal(
      urlHasAISlug("https://example.com/some-random-article"),
      false,
    );
  });

  it("URL undefined/null → false (não crasha)", () => {
    assert.equal(urlHasAISlug(undefined), false);
    assert.equal(urlHasAISlug(null), false);
    assert.equal(urlHasAISlug(""), false);
  });
});

describe("isAIRelevantDomain (#901)", () => {
  it("anthropic.com → true", () => {
    assert.equal(isAIRelevantDomain("https://www.anthropic.com/news/foo"), true);
  });

  it("openai.com → true", () => {
    assert.equal(isAIRelevantDomain("https://openai.com/index/bar"), true);
  });

  it("huggingface.co → true", () => {
    assert.equal(isAIRelevantDomain("https://huggingface.co/blog/x"), true);
  });

  it("arxiv.org → true (papers de ML)", () => {
    assert.equal(isAIRelevantDomain("https://arxiv.org/abs/2604.01234"), true);
  });

  it("cnnbrasil.com.br → false (generalista)", () => {
    assert.equal(isAIRelevantDomain("https://www.cnnbrasil.com.br/economia"), false);
  });

  it("URL inválida não crasha", () => {
    assert.equal(isAIRelevantDomain("not a url"), false);
    assert.equal(isAIRelevantDomain(undefined), false);
  });
});

describe("isArticleAIRelevant — fixtures #901 (regression)", () => {
  // Fixtures retiradas do issue #901: artigos que validate-stage-1-output
  // marcava como off-topic mas que são claramente de IA.
  it("Anthropic + SpaceX deal → on-topic (via domínio)", () => {
    assert.equal(
      isArticleAIRelevant({
        url: "https://www.anthropic.com/news/higher-limits-spacex",
        title: "Higher usage limits for Claude and a compute deal with SpaceX",
      }),
      true,
    );
  });

  it("MITTechReview Brasil — treinamento duplos → on-topic (título tem 'IA' + slug)", () => {
    assert.equal(
      isArticleAIRelevant({
        url: "https://mittechreview.com.br/treinamento-duplos-ia-trabalhadores-china/",
        title: "Treinamento de duplos com IA na China",
      }),
      true,
    );
  });

  it("CNN Brasil — chips de IA da SpaceX → on-topic (slug + termo composto PT-BR)", () => {
    assert.equal(
      isArticleAIRelevant({
        url: "https://www.cnnbrasil.com.br/economia/spacex-apresenta-plano-de-us-55-bi-para-fabrica-de-chips-de-ia/",
        title: "SpaceX apresenta plano de US$ 55 bi para fábrica de chips de IA",
      }),
      true,
    );
  });

  it("OpenAI customer story → on-topic (via domínio openai.com)", () => {
    assert.equal(
      isArticleAIRelevant({
        url: "https://openai.com/index/singular-bank",
        title: "Singular Bank helps bankers move fast with ChatGPT and Codex",
      }),
      true,
    );
  });

  it("Tom's Hardware AI models → on-topic (slug)", () => {
    assert.equal(
      isArticleAIRelevant({
        url: "https://www.tomshardware.com/let-us-government-test-ai-models-before-public-release",
        title: "Let US government test AI models before public release",
      }),
      true,
    );
  });

  it("Gizmochina ai-jobs → on-topic (slug)", () => {
    assert.equal(
      isArticleAIRelevant({
        url: "https://www.gizmochina.com/2026/05/02/sam-altman-ai-jobs-future/",
        title: "Sam Altman discusses AI jobs future",
      }),
      true,
    );
  });

  // Negative regression: garantir que off-topic continua off-topic
  it("Apple devolve R$ 466 (sem IA) → off-topic", () => {
    assert.equal(
      isArticleAIRelevant({
        url: "https://example.com/apple-devolve-466",
        title: "Apple devolve R$ 466 milhões",
      }),
      false,
    );
  });

  it("Selic Pessoa (sem IA) → off-topic", () => {
    assert.equal(
      isArticleAIRelevant({
        url: "https://example.com/selic-pessoa",
        title: "Selic e a pessoa física",
      }),
      false,
    );
  });

  it("STF penduricalhos (sem IA) → off-topic", () => {
    assert.equal(
      isArticleAIRelevant({
        url: "https://example.com/stf-penduricalhos",
        title: "STF discute penduricalhos no judiciário",
      }),
      false,
    );
  });
});
