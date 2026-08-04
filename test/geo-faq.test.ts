/**
 * test/geo-faq.test.ts (#4558 Parte B)
 *
 * Cobre `scripts/lib/shared/geo-faq.ts` — o bloco de estrutura GEO
 * (FAQ + JSON-LD FAQPage/Article + byline de autor) compartilhado por
 * livros/cursos/arquivo. Foco: o JSON-LD é válido e BATE com o conteúdo
 * visível (Google invalida o rich result se FAQPage divergir do HTML), e o
 * autor é sempre nomeado + com URL verificável.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GEO_AUTHOR,
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
    const html = renderGeoFaqSection(SAMPLE_FAQ, "faq-livros");
    assert.match(html, /id="faq-livros"/);
    assert.match(html, /aria-labelledby="faq-livros-heading"/);
    assert.match(html, /id="faq-livros-heading"/);
  });

  it("não usa <details>/accordion — a resposta fica direto no HTML (issue #4558)", () => {
    const html = renderGeoFaqSection(SAMPLE_FAQ);
    assert.doesNotMatch(html, /<details/);
    assert.doesNotMatch(html, /<summary/);
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

  it("FAQPage.mainEntity bate EXATAMENTE (pergunta e resposta) com o bloco visível", () => {
    const html = renderGeoJsonLd(baseOpts);
    const visible = renderGeoFaqSection(baseOpts.faq);
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([\s\S]*)<\/script>/.exec(html)![1]);
    const faqNode = jsonLd["@graph"].find((n: { "@type": string }) => n["@type"] === "FAQPage");
    assert.equal(faqNode.mainEntity.length, baseOpts.faq.length);
    for (let i = 0; i < baseOpts.faq.length; i++) {
      // JSON-LD carrega o texto CRU; o bloco visível carrega a versão
      // escapada em HTML do MESMO texto — checa as duas fontes contra o
      // mesmo array de entrada, nunca uma reformulação/subconjunto.
      assert.equal(faqNode.mainEntity[i].name, baseOpts.faq[i].question);
      assert.equal(faqNode.mainEntity[i].acceptedAnswer.text, baseOpts.faq[i].answer);
      assert.match(visible, new RegExp(faqNode.mainEntity[i].name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
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
});
