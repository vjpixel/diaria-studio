/** Regression coverage for #8594: summary de outra matéria no RADAR. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summaryMatchesArticle } from "../scripts/lib/summary-matches-title.ts";
import { checkRadarSummaryMatchesTitle } from "../scripts/lib/lint-checks/radar-summary-matches-title.ts";
import { enrichArticles } from "../scripts/enrich-inbox-articles.ts";

const EXAME_URL =
  "https://exame.com/inteligencia-artificial/clonagem-de-voz-e-identidade-como-os-golpes-com-ia-mudaram-no-brasil/";
const EXAME_TITLE = "Clonagem de voz e identidade: como os golpes com IA mudaram no Brasil";
const WRONG_SUMMARY =
  "Cofundador da TypeSafe AI, Diogo Almeida ajudou a criar as bases do ChatGPT e Claude; agora, sua nova startup capta US$ 40 milhões para segurança de código · Segundo a CNN, relatório de inteligência feito com IA quase levou as Forças Armadas a um erro grave · Outra matéria qualquer sobre chips e data centers na Ásia";

describe("summaryMatchesArticle (#8594)", () => {
  it("reprova o caso real: digest de outras matérias no item da Exame", () => {
    const r = summaryMatchesArticle({ title: EXAME_TITLE, url: EXAME_URL, summary: WRONG_SUMMARY });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "multi-story-digest");
  });

  it("reprova resumo simples sem relação (2 trechos)", () => {
    const r = summaryMatchesArticle({
      title: EXAME_TITLE,
      url: EXAME_URL,
      summary:
        "Cofundador da TypeSafe AI, Diogo Almeida ajudou a criar as bases do ChatGPT e Claude; agora, sua nova startup capta US$ 40 milhões · Segundo a CNN, relatório de inteligência quase levou as Forças Armadas a erro",
    });
    assert.equal(r.ok, false);
  });

  it("aprova par legítimo PT/PT", () => {
    const r = summaryMatchesArticle({
      title: EXAME_TITLE,
      url: EXAME_URL,
      summary:
        "Golpistas usam clonagem de voz e documentos falsos gerados por IA para enganar bancos e vítimas; casos de fraude de identidade cresceram no Brasil neste ano.",
    });
    assert.equal(r.ok, true);
  });

  it("aprova título EN com summary PT quando há entidades em comum", () => {
    const r = summaryMatchesArticle({
      title: "OpenAI launches GPT-5.6 Sol for developers",
      url: "https://openai.com/index/gpt-5-6-sol/",
      summary:
        "A OpenAI lançou o GPT-5.6 Sol, modelo voltado a desenvolvedores, com janela de contexto maior e preço menor por token na API.",
    });
    assert.equal(r.ok, true);
  });

  it("summary vazio ou pouca evidência não acusa", () => {
    assert.equal(summaryMatchesArticle({ title: "X", url: "https://a.com/x", summary: "" }).ok, true);
    assert.equal(summaryMatchesArticle({ title: "Oi", url: "https://a.com/x", summary: "Texto curto qualquer." }).ok, true);
  });
});

describe("checkRadarSummaryMatchesTitle (#8594)", () => {
  it("acusa o item do caso real e poupa o legítimo", () => {
    const md = [
      "**RADAR**",
      "",
      `[${EXAME_TITLE}](${EXAME_URL}) ${WRONG_SUMMARY}`,
      "",
      "[OpenAI lança GPT-5.6 Sol para desenvolvedores](https://openai.com/index/gpt-5-6-sol/) A OpenAI lançou o GPT-5.6 Sol, modelo voltado a desenvolvedores, com contexto maior e preço menor na API.",
      "",
    ].join("\n");
    const r = checkRadarSummaryMatchesTitle(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].url, EXAME_URL);
  });
});

describe("enrichArticles descarta summary trocado (#8594)", () => {
  it("esvazia o summary, registra em stats e tenta refetch", async () => {
    const html = `<html><head><meta property="og:description" content="Golpistas usam clonagem de voz e identidade falsa gerada por IA para fraudar vítimas no Brasil, alertam especialistas em segurança."></head></html>`;
    const { articles, stats } = await enrichArticles(
      [{ url: EXAME_URL, title: EXAME_TITLE, summary: WRONG_SUMMARY, source: "Exame" }],
      async () => html,
    );
    assert.deepEqual(stats.summary_discarded, [EXAME_URL]);
    assert.ok(!/TypeSafe/.test(String(articles[0].summary ?? "")));
  });

  it("não toca summary legítimo", async () => {
    const good =
      "Golpistas usam clonagem de voz e documentos falsos gerados por IA para enganar bancos e vítimas no Brasil.";
    const { articles, stats } = await enrichArticles(
      [{ url: EXAME_URL, title: EXAME_TITLE, summary: good, source: "Exame" }],
      async () => null,
    );
    assert.equal(stats.summary_discarded, undefined);
    assert.equal(articles[0].summary, good);
  });
});
