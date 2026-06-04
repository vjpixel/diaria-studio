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

  it("flaga substack/beehiiv via sufixo de host", () => {
    const items = [
      { url: "https://alguem.substack.com/p/analise", title: "Análise da semana em IA" },
      { url: "https://x.beehiiv.com/p/roundup", title: "Weekly roundup" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 2);
  });

  it("flaga item sem sinal de tutorial mesmo em domínio neutro", () => {
    const items = [{ url: "https://techblog.com/openai-announces-thing", title: "OpenAI anuncia novidade" }];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 1);
    assert.match(suspicious[0].reasons.join(" "), /sem sinal de tutorial/);
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
});
