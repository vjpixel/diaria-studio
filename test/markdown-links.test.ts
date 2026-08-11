/**
 * test/markdown-links.test.ts (#4558 Parte A, movido de test/hub-page.test.ts em #4635/#4635-seguinte)
 *
 * Cobre `findParagraphLinks`/`renderInlineLinks`/`stripMarkdownLinks`
 * (scripts/lib/shared/markdown-links.ts) — o parser de markdown `[texto](url)`
 * usado tanto nas `HubSection.paragraphs` (hub-page.ts) quanto nas respostas
 * de FAQ (geo-faq.ts, #4635 item 3). Reimplementação self-contained de
 * `findMarkdownLinks`/`mdInlineToHtml` (scripts/lib/newsletter-render-html.ts,
 * coberto por test/render-newsletter-mdinline.test.ts) — este arquivo
 * espelha os casos de borda mais relevantes daquela suíte pra essa
 * reimplementação, achado do fleet review da PR #4635: `[texto]()` com URL
 * vazia divergia do comportamento já testado da função original antes do
 * fix.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  findParagraphLinks,
  renderInlineLinks,
  stripMarkdownLinks,
  isSafeUrlScheme,
} from "../scripts/lib/shared/markdown-links.ts";

describe("findParagraphLinks (#4558 Parte A)", () => {
  it("acha um link simples", () => {
    const links = findParagraphLinks("veja [o texto](https://diar.ia.br/p/x) aqui");
    assert.equal(links.length, 1);
    assert.equal(links[0].label, "o texto");
    assert.equal(links[0].url, "https://diar.ia.br/p/x");
  });

  it("URL com parênteses balanceados não é truncada", () => {
    // Mesmo caso que motivou o paren-balance parsing em findMarkdownLinks
    // (#1634) — ex: URL de Wikipedia com desambiguação "(language_model)".
    const links = findParagraphLinks("[GPT-4](https://en.wikipedia.org/wiki/GPT-4_(language_model))");
    assert.equal(links.length, 1);
    assert.equal(links[0].url, "https://en.wikipedia.org/wiki/GPT-4_(language_model)");
  });

  it("múltiplos links no mesmo parágrafo, em ordem", () => {
    const links = findParagraphLinks("[A](https://a) e depois [B](https://b)");
    assert.equal(links.length, 2);
    assert.equal(links[0].label, "A");
    assert.equal(links[1].label, "B");
  });

  it("link sem `)` de fechamento é ignorado (não é link válido)", () => {
    const links = findParagraphLinks("isto é [quase um link](https://x sem fechar");
    assert.deepEqual(links, []);
  });

  it("`[texto]()` com URL vazia NÃO é tratado como link — regression do fleet review", () => {
    // mdInlineToHtml (newsletter-render-html.ts) já tinha esse guard
    // ("URL vazia — preserva texto bruto"); a 1ª versão desta
    // reimplementação não replicou e produzia <a href="">.
    const links = findParagraphLinks("[clique aqui]() pra nada");
    assert.deepEqual(links, []);
  });

  it("um `[` solto antes de um link real não engole o label do link — regression do fleet review PR #4642", () => {
    // Achado: o label regex original ([^\]]+), herdado de
    // findMarkdownLinks, exclui só `]`, não `[`. Um colchete solto ANTES de
    // um link real fazia o parser capturar tudo entre os dois `[` como
    // label — corrompendo o link e o texto ao redor em silêncio, sem erro.
    const links = findParagraphLinks("texto [solto e depois [Claude](https://claude.ai) real");
    assert.equal(links.length, 1);
    assert.equal(links[0].label, "Claude");
    assert.equal(links[0].url, "https://claude.ai");
  });

  it("parágrafo sem nenhum link retorna array vazio", () => {
    assert.deepEqual(findParagraphLinks("texto sem link nenhum"), []);
  });

  it("URL de esquema não-https é rejeitada, mesmo tratamento do guard de URL vazia (#4919 item 7)", () => {
    assert.deepEqual(findParagraphLinks("[clique](javascript:alert(1))"), []);
    assert.deepEqual(findParagraphLinks("[clique](http://exemplo.com)"), []);
  });
});

describe("isSafeUrlScheme (#4919 item 7)", () => {
  it("aceita https:", () => {
    assert.equal(isSafeUrlScheme("https://diar.ia.br/p/x"), true);
  });

  it("rejeita http:, javascript: e URL malformada", () => {
    assert.equal(isSafeUrlScheme("http://diar.ia.br"), false);
    assert.equal(isSafeUrlScheme("javascript:alert(1)"), false);
    assert.equal(isSafeUrlScheme("não é uma url"), false);
  });
});

describe("renderInlineLinks (#4558 Parte A)", () => {
  it("sem link, retorna o texto escapado (esc puro)", () => {
    assert.equal(renderInlineLinks(`<script>&"'`), "&lt;script&gt;&amp;&quot;&#39;");
  });

  it("escapa label e url — nunca interpola HTML cru", () => {
    const html = renderInlineLinks('[<b>negrito</b>](https://x?a=1&b="2")');
    assert.doesNotMatch(html, /<b>negrito<\/b>/);
    assert.match(html, /&lt;b&gt;negrito&lt;\/b&gt;/);
    assert.match(html, /href="https:\/\/x\?a=1&amp;b=&quot;2&quot;"/);
  });

  it("`[texto]()` com URL vazia renderiza texto plano, nunca <a href=\"\">", () => {
    const html = renderInlineLinks("[clique aqui]() pra nada");
    assert.doesNotMatch(html, /<a href="">/);
    assert.match(html, /\[clique aqui\]\(\) pra nada/);
  });

  it("mistura texto + link + texto, preservando a ordem", () => {
    const html = renderInlineLinks("antes [meio](https://x) depois");
    assert.equal(html, 'antes <a href="https://x">meio</a> depois');
  });

  it("múltiplos links no mesmo parágrafo renderizam todos", () => {
    const html = renderInlineLinks("[A](https://a) e [B](https://b)");
    assert.match(html, /<a href="https:\/\/a">A<\/a>/);
    assert.match(html, /<a href="https:\/\/b">B<\/a>/);
  });

  it("URL javascript: renderiza texto plano, nunca <a href=\"javascript:...\"> (#4919 item 7)", () => {
    const html = renderInlineLinks("[clique](javascript:alert(1)) aqui");
    assert.doesNotMatch(html, /<a /);
    assert.match(html, /\[clique\]\(javascript:alert\(1\)\) aqui/);
  });
});

describe("stripMarkdownLinks (#4635 item 3)", () => {
  it("sem link, retorna a string intacta", () => {
    assert.equal(stripMarkdownLinks("texto sem link nenhum"), "texto sem link nenhum");
  });

  it("substitui [label](url) só pelo label — pra acceptedAnswer.text do FAQPage", () => {
    assert.equal(
      stripMarkdownLinks("veja [o texto](https://diar.ia.br/p/x) aqui"),
      "veja o texto aqui",
    );
  });

  it("múltiplos links, todos substituídos", () => {
    assert.equal(stripMarkdownLinks("[A](https://a) e [B](https://b)"), "A e B");
  });

  it("não escapa HTML — quem consome (JSON.stringify) não precisa", () => {
    assert.equal(stripMarkdownLinks("<b>[x](https://a)</b>"), "<b>x</b>");
  });
});
