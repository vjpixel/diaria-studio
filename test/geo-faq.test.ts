/**
 * test/geo-faq.test.ts (#4558 Parte B)
 *
 * Cobre `scripts/lib/shared/geo-faq.ts` — o bloco de estrutura GEO
 * (FAQ + JSON-LD FAQPage/Article + byline de autor) compartilhado por
 * livros/cursos/arquivo/hub. Foco: o JSON-LD é válido e bate com o
 * conteúdo visível pra resposta sem markdown (Google invalida o rich
 * result se FAQPage divergir do HTML) — pra resposta COM `[texto](url)`
 * (hub, #4635 item 3) a divergência é intencional e testada à parte:
 * JSON-LD recebe texto puro, visível recebe `<a href>`. Autor é sempre
 * nomeado + com URL verificável.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GEO_AUTHOR,
  formatMonthYear,
  renderGeoByline,
  renderGeoFaqSection,
  renderGeoJsonLd,
  type GeoFaqItem,
} from "../scripts/lib/shared/geo-faq.ts";

const SAMPLE_FAQ: GeoFaqItem[] = [
  { question: "Quantos livros tem a lista?", answer: "29 livros, sendo 21 em português e 8 em inglês." },
  { question: "Como os livros são escolhidos?", answer: "Por prêmios do autor/livro e nota na Amazon." },
];

describe("renderGeoFaqSection", () => {
  it("renderiza um <h2> por pergunta, com o texto exato (escapado)", () => {
    const html = renderGeoFaqSection(SAMPLE_FAQ);
    assert.match(html, /<h2>Quantos livros tem a lista\?<\/h2>/);
    assert.match(html, /<h2>Como os livros são escolhidos\?<\/h2>/);
    assert.match(html, /29 livros, sendo 21 em português e 8 em inglês\./);
  });

  it("escapa HTML na pergunta e na resposta", () => {
    const html = renderGeoFaqSection([{ question: 'Tem "aspas" & <tags>?', answer: "Sim <script>alert(1)</script>" }]);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&amp;/);
  });

  it("aceita um sectionId customizado (aria-labelledby bate com o id do heading)", () => {
    const html = renderGeoFaqSection(SAMPLE_FAQ, { sectionId: "faq-livros" });
    assert.match(html, /id="faq-livros"/);
    assert.match(html, /aria-labelledby="faq-livros-heading"/);
    assert.match(html, /id="faq-livros-heading"/);
  });

  it("não usa <details>/accordion — a resposta fica direto no HTML (issue #4558)", () => {
    const html = renderGeoFaqSection(SAMPLE_FAQ);
    assert.doesNotMatch(html, /<details/);
    assert.doesNotMatch(html, /<summary/);
  });

  it("heading default é 'Perguntas frequentes' — comportamento de livros/cursos/arquivo preservado (#4642)", () => {
    const html = renderGeoFaqSection(SAMPLE_FAQ);
    assert.match(html, /class="geo-faq-heading">Perguntas frequentes</);
  });

  it("aceita heading customizado — usado pelo hub pra não ler como 2º bloco de FAQ idêntico (#4642)", () => {
    const html = renderGeoFaqSection(SAMPLE_FAQ, { heading: "Perguntas rápidas" });
    assert.match(html, /class="geo-faq-heading">Perguntas rápidas</);
    assert.doesNotMatch(html, /Perguntas frequentes/);
  });

  it("resposta com [texto](url) renderiza <a href> de verdade (#4635 item 3)", () => {
    const html = renderGeoFaqSection([
      { question: "Onde?", answer: "Veja [a fonte](https://diar.ia.br/p/x) pra mais detalhes." },
    ]);
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\/p\/x">a fonte<\/a>/);
    assert.doesNotMatch(html, /\[a fonte\]/);
  });
});

describe("renderGeoByline", () => {
  it("nomeia o autor e linka pra um perfil externo verificável", () => {
    const html = renderGeoByline();
    assert.match(html, /Por <a href="https:\/\/www\.linkedin\.com\/in\/vjpixel\/" rel="author">Pixel<\/a>/);
  });

  it("aceita um autor customizado", () => {
    const html = renderGeoByline({ name: "Outro Nome", url: "https://example.com/outro" });
    assert.match(html, /Outro Nome/);
    assert.match(html, /https:\/\/example\.com\/outro/);
  });

  it("acrescenta o dateLabel quando fornecido", () => {
    const html = renderGeoByline(GEO_AUTHOR, "agosto de 2026");
    assert.match(html, /· agosto de 2026/);
  });
});

describe("formatMonthYear (#4616 achado 6 — byline derivado de GEO_CONTENT_DATE, não hardcoded)", () => {
  it("formata YYYY-MM-DD como '{mês} de {ano}' em pt-BR", () => {
    assert.equal(formatMonthYear("2026-08-04"), "agosto de 2026");
  });

  it("cobre os 12 meses corretamente", () => {
    assert.equal(formatMonthYear("2026-01-15"), "janeiro de 2026");
    assert.equal(formatMonthYear("2026-02-01"), "fevereiro de 2026");
    assert.equal(formatMonthYear("2026-03-01"), "março de 2026");
    assert.equal(formatMonthYear("2026-04-01"), "abril de 2026");
    assert.equal(formatMonthYear("2026-05-01"), "maio de 2026");
    assert.equal(formatMonthYear("2026-06-01"), "junho de 2026");
    assert.equal(formatMonthYear("2026-07-01"), "julho de 2026");
    assert.equal(formatMonthYear("2026-09-01"), "setembro de 2026");
    assert.equal(formatMonthYear("2026-10-01"), "outubro de 2026");
    assert.equal(formatMonthYear("2026-11-01"), "novembro de 2026");
    assert.equal(formatMonthYear("2026-12-31"), "dezembro de 2026");
  });

  it("nunca fica dessincronizado de um bump futuro de GEO_CONTENT_DATE — deriva DA data, não hardcoded (regressão #4616)", () => {
    // O bug original: build-cursos-page.ts/build-livros-page.ts chamavam
    // renderGeoByline(undefined, "atualizado em agosto de 2026") como string
    // literal, independente de GEO_CONTENT_DATE. Um bump futuro da constante
    // não atualizava esse texto visível. Este teste prova que o mesmo valor
    // usado no JSON-LD (datePublished/dateModified) produz o texto visível —
    // não podem divergir porque um deriva do outro.
    const futureContentDate = "2027-03-10";
    assert.equal(formatMonthYear(futureContentDate), "março de 2027");
    assert.notEqual(formatMonthYear(futureContentDate), "agosto de 2026");
  });

  it("lança (fail loud) pra formato inválido, nunca imprime uma data quebrada em silêncio", () => {
    assert.throws(() => formatMonthYear("04/08/2026"));
    assert.throws(() => formatMonthYear("2026-8-4"));
    assert.throws(() => formatMonthYear(""));
  });

  it("lança pra mês fora do intervalo 01-12", () => {
    assert.throws(() => formatMonthYear("2026-13-01"));
    assert.throws(() => formatMonthYear("2026-00-01"));
  });

  it("renderGeoByline(undefined, `atualizado em ${formatMonthYear(...)}`) produz o mesmo texto visível de antes (regressão de valor)", () => {
    const html = renderGeoByline(undefined, `atualizado em ${formatMonthYear("2026-08-04")}`);
    assert.match(html, /· atualizado em agosto de 2026/);
  });
});

describe("renderGeoJsonLd", () => {
  const baseOpts = {
    pageUrl: "https://livros.diar.ia.br/",
    headline: "Livros sobre IA",
    description: "Curadoria de livros sobre inteligência artificial.",
    datePublished: "2026-08-04",
    dateModified: "2026-08-04",
    faq: SAMPLE_FAQ,
  };

  it("produz um único <script type=application/ld+json> com JSON válido", () => {
    const html = renderGeoJsonLd(baseOpts);
    const m = /<script type="application\/ld\+json">([\s\S]*)<\/script>/.exec(html);
    assert.ok(m, "deve ter exatamente 1 <script type=application/ld+json>");
    const parsed = JSON.parse(m![1]);
    assert.equal(parsed["@context"], "https://schema.org");
    assert.ok(Array.isArray(parsed["@graph"]));
    assert.equal(parsed["@graph"].length, 2);
  });

  it("FAQPage.mainEntity bate EXATAMENTE (pergunta e resposta) com o bloco visível — SAMPLE_FAQ sem markdown", () => {
    const html = renderGeoJsonLd(baseOpts);
    const visible = renderGeoFaqSection(baseOpts.faq);
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([\s\S]*)<\/script>/.exec(html)![1]);
    const faqNode = jsonLd["@graph"].find((n: { "@type": string }) => n["@type"] === "FAQPage");
    assert.equal(faqNode.mainEntity.length, baseOpts.faq.length);
    for (let i = 0; i < baseOpts.faq.length; i++) {
      // Válido só quando `answer` NÃO tem `[texto](url)` (caso de SAMPLE_FAQ,
      // igual às respostas reais de livros/cursos/arquivo hoje) — nesse
      // caso `stripMarkdownLinks`/`renderInlineLinks` são no-op e as duas
      // fontes batem com o mesmo array de entrada, sem reformulação. Pra
      // resposta COM markdown, ver o teste seguinte — a divergência ali é
      // intencional, não um bug (achado do fleet review da PR #4642, que
      // apontou este comentário como desatualizado depois de #4635 item 3).
      assert.equal(faqNode.mainEntity[i].name, baseOpts.faq[i].question);
      assert.equal(faqNode.mainEntity[i].acceptedAnswer.text, baseOpts.faq[i].answer);
      assert.match(visible, new RegExp(faqNode.mainEntity[i].name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("resposta com [texto](url): JSON-LD recebe texto puro (sem colchete), visível recebe <a href> — divergência intencional (#4635 item 3)", () => {
    const faqWithLink: GeoFaqItem[] = [
      { question: "Onde?", answer: "Veja [a fonte](https://diar.ia.br/p/x) pra mais detalhes." },
    ];
    const html = renderGeoJsonLd({ ...baseOpts, faq: faqWithLink });
    const visible = renderGeoFaqSection(faqWithLink);
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([\s\S]*)<\/script>/.exec(html)![1]);
    const faqNode = jsonLd["@graph"].find((n: { "@type": string }) => n["@type"] === "FAQPage");
    const jsonLdText = faqNode.mainEntity[0].acceptedAnswer.text;
    // JSON-LD: texto legível, sem [ ] ( ) — schema.org não espera markup ali.
    assert.equal(jsonLdText, "Veja a fonte pra mais detalhes.");
    assert.doesNotMatch(jsonLdText, /[[\]]/);
    // Visível: link de verdade.
    assert.match(visible, /<a href="https:\/\/diar\.ia\.br\/p\/x">a fonte<\/a>/);
    // As duas fontes DIVERGEM de propósito pra esta resposta — não é o
    // caso "bate EXATAMENTE" do teste anterior.
    assert.notEqual(jsonLdText, faqWithLink[0].answer);
  });

  it("Article traz autor nomeado com url verificável (default GEO_AUTHOR)", () => {
    const html = renderGeoJsonLd(baseOpts);
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([\s\S]*)<\/script>/.exec(html)![1]);
    const articleNode = jsonLd["@graph"].find((n: { "@type": string }) => n["@type"] === "Article");
    assert.equal(articleNode.author["@type"], "Person");
    assert.equal(articleNode.author.name, GEO_AUTHOR.name);
    assert.equal(articleNode.author.url, GEO_AUTHOR.url);
    assert.equal(articleNode.headline, baseOpts.headline);
    assert.equal(articleNode.datePublished, baseOpts.datePublished);
    assert.equal(articleNode.dateModified, baseOpts.dateModified);
    assert.equal(articleNode.inLanguage, "pt-BR");
    assert.equal(articleNode.publisher.name, "diar.ia.br");
  });

  it("é </script>-safe — nunca fecha a tag cedo mesmo com '<' no conteúdo", () => {
    const html = renderGeoJsonLd({
      ...baseOpts,
      headline: "Título com </script> embutido",
    });
    // Só 1 tag de fechamento real — a maliciosa foi escapada pra </script>.
    const closingTags = html.match(/<\/script>/g) ?? [];
    assert.equal(closingTags.length, 1);
  });

  it("aceita um author customizado, sobrepondo o default", () => {
    const html = renderGeoJsonLd({ ...baseOpts, author: { name: "Outra Pessoa", url: "https://example.com/x" } });
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([\s\S]*)<\/script>/.exec(html)![1]);
    const articleNode = jsonLd["@graph"].find((n: { "@type": string }) => n["@type"] === "Article");
    assert.equal(articleNode.author.name, "Outra Pessoa");
    assert.equal(articleNode.author.url, "https://example.com/x");
  });

  // #4558 Parte B: ItemList opcional — espelha uma lista de itens com URL
  // já visível no HTML (ex: fontes citadas de um hub) em dado estruturado.
  it("sem itemList (caso de livros/cursos/arquivo hoje): @graph continua com só 2 nodes, nenhum ItemList", () => {
    const html = renderGeoJsonLd(baseOpts);
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([\s\S]*)<\/script>/.exec(html)![1]);
    assert.equal(jsonLd["@graph"].length, 2);
    assert.ok(!jsonLd["@graph"].some((n: { "@type": string }) => n["@type"] === "ItemList"));
  });

  it("itemList com items vazio: nenhum node ItemList (não polui o @graph com uma lista vazia)", () => {
    const html = renderGeoJsonLd({ ...baseOpts, itemList: { name: "Fontes", items: [] } });
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([\s\S]*)<\/script>/.exec(html)![1]);
    assert.equal(jsonLd["@graph"].length, 2);
  });

  it("itemList com items: gera um node ItemList com posição 1-based e mesma ordem de entrada", () => {
    const html = renderGeoJsonLd({
      ...baseOpts,
      itemList: {
        name: "Edições citadas",
        items: [
          { name: "Primeira edição", url: "https://diar.ia.br/p/primeira" },
          { name: "Segunda edição", url: "https://diar.ia.br/p/segunda" },
        ],
      },
    });
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([\s\S]*)<\/script>/.exec(html)![1]);
    assert.equal(jsonLd["@graph"].length, 3);
    const listNode = jsonLd["@graph"].find((n: { "@type": string }) => n["@type"] === "ItemList");
    assert.ok(listNode);
    assert.equal(listNode.name, "Edições citadas");
    assert.equal(listNode.numberOfItems, 2);
    assert.equal(listNode.itemListElement.length, 2);
    assert.equal(listNode.itemListElement[0].position, 1);
    assert.equal(listNode.itemListElement[0].name, "Primeira edição");
    assert.equal(listNode.itemListElement[0].url, "https://diar.ia.br/p/primeira");
    assert.equal(listNode.itemListElement[1].position, 2);
    assert.equal(listNode.itemListElement[1].name, "Segunda edição");
  });

  it("itemList: é </script>-safe também (name com '<' embutido não fecha a tag cedo)", () => {
    const html = renderGeoJsonLd({
      ...baseOpts,
      itemList: { name: "Título com </script> embutido", items: [{ name: "x", url: "https://diar.ia.br/p/x" }] },
    });
    const closingTags = html.match(/<\/script>/g) ?? [];
    assert.equal(closingTags.length, 1);
  });
});
