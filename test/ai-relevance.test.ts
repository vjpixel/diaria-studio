/**
 * ai-relevance.test.ts (#642) — tests for scripts/lib/ai-relevance.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AI_RELEVANT_TERMS,
  containsAITerms,
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
