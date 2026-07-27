import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isPlaceholderHighlightTitle,
  demotePlaceholderTitleHighlights,
  type PlaceholderFinalistLike,
  type PlaceholderHighlightLike,
} from "../scripts/lib/placeholder-title-guard.ts";

describe("isPlaceholderHighlightTitle (#4102)", () => {
  it("reconhece (inbox)", () => {
    assert.equal(isPlaceholderHighlightTitle("(inbox)"), true);
    assert.equal(isPlaceholderHighlightTitle("(INBOX)"), true);
  });

  it("reconhece (no title) e (sem título)", () => {
    assert.equal(isPlaceholderHighlightTitle("(no title)"), true);
    assert.equal(isPlaceholderHighlightTitle("(sem título)"), true);
    assert.equal(isPlaceholderHighlightTitle("(sem titulo)"), true, "aceita sem acento também");
  });

  it("CASO REAL 260727: reconhece (newsletter:\"Lenny's Newsletter\")", () => {
    assert.equal(isPlaceholderHighlightTitle('(newsletter:"Lenny\'s Newsletter")'), true);
  });

  it("reconhece (newsletter:AI Roundup) — sender sem aspas", () => {
    assert.equal(isPlaceholderHighlightTitle("(newsletter:AI Roundup)"), true);
  });

  it("título vazio ou undefined é placeholder", () => {
    assert.equal(isPlaceholderHighlightTitle(""), true);
    assert.equal(isPlaceholderHighlightTitle(undefined), true);
    assert.equal(isPlaceholderHighlightTitle(null), true);
    assert.equal(isPlaceholderHighlightTitle("   "), true);
  });

  it("NÃO falso-positiva em título real com parênteses no meio", () => {
    assert.equal(isPlaceholderHighlightTitle("GPT-5 (versão de pesquisa) chega em outubro"), false);
  });

  it("NÃO falso-positiva em título que começa com '(' mas não é o padrão conhecido", () => {
    assert.equal(isPlaceholderHighlightTitle("(Atualização) modelo novo chega em outubro"), false);
  });

  it("NÃO falso-positiva em título real qualquer", () => {
    assert.equal(isPlaceholderHighlightTitle("OpenAI anuncia GPT-5"), false);
  });
});

describe("demotePlaceholderTitleHighlights (#4102)", () => {
  const finalists: PlaceholderFinalistLike[] = [
    { url: "https://yc.com/placeholder-item", score: 119, bucket: "radar", article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' } },
    { url: "https://real.com/good-article", score: 95, bucket: "radar", article: { url: "https://real.com/good-article", title: "Um título real e bom" } },
    { url: "https://real.com/second-best", score: 80, bucket: "lancamento", article: { url: "https://real.com/second-best", title: "Segundo melhor candidato" } },
  ];

  it("no-op quando nenhum highlight tem título placeholder", () => {
    const highlights: PlaceholderHighlightLike[] = [
      { rank: 1, score: 95, url: "https://real.com/good-article", article: { url: "https://real.com/good-article", title: "Um título real e bom" } },
    ];
    const out = demotePlaceholderTitleHighlights(highlights, finalists);
    assert.equal(out.highlights, highlights, "deve retornar a MESMA referência quando não demove (no-op)");
    assert.deepEqual(out.demotions, []);
  });

  it("CASO REAL 260727: highlight com score MAIS ALTO do pool mas título placeholder é substituído", () => {
    const highlights: PlaceholderHighlightLike[] = [
      {
        rank: 1,
        score: 119,
        url: "https://yc.com/placeholder-item",
        article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' },
      },
    ];
    const out = demotePlaceholderTitleHighlights(highlights, finalists);
    assert.equal(out.demotions.length, 1);
    assert.equal(out.demotions[0].demoted_url, "https://yc.com/placeholder-item");
    assert.equal(out.demotions[0].promoted_url, "https://real.com/good-article");
    assert.equal(out.highlights.length, 1);
    assert.equal(out.highlights[0].url, "https://real.com/good-article");
    assert.equal(out.highlights[0].article?.title, "Um título real e bom");
    // título placeholder nunca sobrevive na lista final, mesmo tendo o maior score do pool
    assert.ok(!out.highlights.some((h) => isPlaceholderHighlightTitle(h.article?.title as string | undefined)));
  });

  it("nunca reintroduz um candidato já escolhido como highlight", () => {
    const highlights: PlaceholderHighlightLike[] = [
      { rank: 1, score: 95, url: "https://real.com/good-article", article: { url: "https://real.com/good-article", title: "Um título real e bom" } },
      { rank: 2, score: 119, url: "https://yc.com/placeholder-item", article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' } },
    ];
    const out = demotePlaceholderTitleHighlights(highlights, finalists);
    assert.equal(out.highlights.length, 2);
    // substituto não pode ser "good-article" — já está nos highlights
    assert.equal(out.highlights[1].url, "https://real.com/second-best");
    const urls = out.highlights.map((h) => h.url);
    assert.equal(new Set(urls).size, urls.length, "sem duplicata de URL nos highlights finais");
  });

  it("sem substituto disponível: remove o highlight ofensor (contagem cai)", () => {
    const highlights: PlaceholderHighlightLike[] = [
      { rank: 1, score: 119, url: "https://yc.com/placeholder-item", article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' } },
    ];
    const noReplacementFinalists: PlaceholderFinalistLike[] = [
      { url: "https://yc.com/placeholder-item", score: 119, article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' } },
    ];
    const out = demotePlaceholderTitleHighlights(highlights, noReplacementFinalists);
    assert.equal(out.highlights.length, 0);
    assert.equal(out.demotions.length, 1);
    assert.equal(out.demotions[0].promoted_url, undefined);
  });

  it("preserva highlights não-ofensores intactos (mesma referência de objeto)", () => {
    const goodHighlight: PlaceholderHighlightLike = {
      rank: 1,
      score: 95,
      url: "https://real.com/good-article",
      article: { url: "https://real.com/good-article", title: "Um título real e bom" },
    };
    const highlights: PlaceholderHighlightLike[] = [
      goodHighlight,
      { rank: 2, score: 119, url: "https://yc.com/placeholder-item", article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' } },
    ];
    const out = demotePlaceholderTitleHighlights(highlights, finalists);
    assert.equal(out.highlights[0], goodHighlight, "highlight não-ofensor preserva a mesma referência");
  });
});
