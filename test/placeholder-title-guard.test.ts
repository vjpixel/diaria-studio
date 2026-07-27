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

  // Finding 5 do self-review (#4102): remoção sem substituto pode deixar
  // `rank` com buraco (ex: 1, 2, 4) — reindexar por posição corrige isso.
  describe("reindexação de rank após remoção sem substituto (finding 5, #4102)", () => {
    it("remoção do highlight do MEIO (rank 2 de 3) compacta ranks pra 1, 2 (sem buraco)", () => {
      const h1: PlaceholderHighlightLike = { rank: 1, score: 100, url: "https://a.com/1", article: { url: "https://a.com/1", title: "Título real A" } };
      const h3: PlaceholderHighlightLike = { rank: 3, score: 80, url: "https://c.com/3", article: { url: "https://c.com/3", title: "Título real C" } };
      const highlights: PlaceholderHighlightLike[] = [
        h1,
        { rank: 2, score: 119, url: "https://yc.com/placeholder-item", article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' } },
        h3,
      ];
      // finalists sem nenhum substituto disponível (nenhum finalist não-placeholder e não já escolhido)
      const noReplacementFinalists: PlaceholderFinalistLike[] = [
        { url: "https://yc.com/placeholder-item", score: 119, article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' } },
        { url: "https://a.com/1", score: 100, article: { url: "https://a.com/1", title: "Título real A" } },
        { url: "https://c.com/3", score: 80, article: { url: "https://c.com/3", title: "Título real C" } },
      ];
      const out = demotePlaceholderTitleHighlights(highlights, noReplacementFinalists);
      assert.equal(out.highlights.length, 2);
      assert.deepEqual(out.highlights.map((h) => h.rank), [1, 2], "ranks remanescentes devem ser contíguos 1..N, sem buraco");
      assert.equal(out.highlights[0].url, "https://a.com/1");
      assert.equal(out.highlights[1].url, "https://c.com/3");
    });

    it("exemplo do finding: 6 highlights, offender na posição 3 (rank 3) removido sem substituto → ranks finais 1,2,3,4,5 (não 1,2,4,5,6)", () => {
      const mk = (rank: number, url: string, title: string): PlaceholderHighlightLike => ({
        rank,
        score: 100 - rank,
        url,
        article: { url, title },
      });
      const highlights: PlaceholderHighlightLike[] = [
        mk(1, "https://a.com/1", "Título 1"),
        mk(2, "https://a.com/2", "Título 2"),
        { rank: 3, score: 119, url: "https://yc.com/placeholder-item", article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' } },
        mk(4, "https://a.com/4", "Título 4"),
        mk(5, "https://a.com/5", "Título 5"),
        mk(6, "https://a.com/6", "Título 6"),
      ];
      // Nenhum finalist substituto disponível além dos já escolhidos (todos os 5 títulos
      // reais já estão em highlights; só sobra o próprio ofensor, que é filtrado por título).
      const noReplacementFinalists: PlaceholderFinalistLike[] = [
        { url: "https://yc.com/placeholder-item", score: 119, article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' } },
      ];
      const out = demotePlaceholderTitleHighlights(highlights, noReplacementFinalists);
      assert.equal(out.highlights.length, 5);
      assert.deepEqual(out.highlights.map((h) => h.rank), [1, 2, 3, 4, 5], "sem buraco (não deve ficar 1,2,4,5,6)");
    });

    it("no-op (nenhuma remoção): ranks originais preservados sem reindexar (substituição no lugar não conta como remoção)", () => {
      const highlights: PlaceholderHighlightLike[] = [
        { rank: 1, score: 95, url: "https://real.com/good-article", article: { url: "https://real.com/good-article", title: "Um título real e bom" } },
        { rank: 2, score: 119, url: "https://yc.com/placeholder-item", article: { url: "https://yc.com/placeholder-item", title: '(newsletter:"Lenny\'s Newsletter")' } },
      ];
      const out = demotePlaceholderTitleHighlights(highlights, finalists);
      // substituição (não remoção) — count preservado, ranks já contíguos 1,2
      assert.equal(out.highlights.length, 2);
      assert.deepEqual(out.highlights.map((h) => h.rank), [1, 2]);
    });
  });
});
