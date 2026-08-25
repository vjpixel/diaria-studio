/**
 * test/render-newsletter-mdinline.test.ts
 *
 * Testes para mdInlineToHtml — garante que URLs com parênteses (ex: Wikipedia
 * disambiguation) não são truncadas (#2001 follow-up: substituiu regex ingênua
 * [^)]+ por findMarkdownLinks paren-balanced).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mdInlineToHtml } from "../scripts/lib/newsletter-render-html.ts";

describe("mdInlineToHtml (#2001 follow-up: URLs com parênteses)", () => {
  it("URL simples sem parênteses (caminho existente, não regride)", () => {
    const out = mdInlineToHtml("[GPT-4](https://openai.com/gpt-4)");
    assert.ok(out.includes('href="https://openai.com/gpt-4"'), `href ausente: ${out}`);
    assert.ok(out.includes(">GPT-4<"), `label ausente: ${out}`);
  });

  it("URL com parênteses (caso que a regex ingênua truncava)", () => {
    const out = mdInlineToHtml("[GPT-4](https://en.wikipedia.org/wiki/GPT-4_(language_model))");
    assert.ok(
      out.includes('href="https://en.wikipedia.org/wiki/GPT-4_(language_model)"'),
      `href truncado ou ausente: ${out}`,
    );
    assert.ok(out.includes(">GPT-4<"), `label ausente: ${out}`);
  });

  it("texto misto: antes + link com parênteses + depois", () => {
    const out = mdInlineToHtml(
      "Veja [esta página](https://example.com/path_(1)) para detalhes.",
    );
    assert.ok(
      out.includes('href="https://example.com/path_(1)"'),
      `href truncado: ${out}`,
    );
    assert.ok(out.includes("para detalhes."), `texto após link ausente: ${out}`);
  });

  it("bold **texto** preservado", () => {
    const out = mdInlineToHtml("**negrito** normal");
    assert.ok(out.includes("<b>negrito</b>"), `bold ausente: ${out}`);
  });

  it("link + bold na mesma string", () => {
    const out = mdInlineToHtml(
      "Acesse [o site](https://example.com/page_(v2)) com **novidades**.",
    );
    assert.ok(out.includes('href="https://example.com/page_(v2)"'), `href: ${out}`);
    assert.ok(out.includes("<b>novidades</b>"), `bold: ${out}`);
  });

  it("[text]() URL vazia — preserva texto bruto sem emitir <a href=''>", () => {
    const out = mdInlineToHtml("[clique aqui]()");
    assert.doesNotMatch(out, /<a\b/, `não deve emitir tag <a>: ${out}`);
    assert.ok(out.includes("[clique aqui]()"), `texto bruto deve ser preservado: ${out}`);
  });

  it("#6084: itálico *texto* (asterisco único) vira <em>", () => {
    const out = mdInlineToHtml("*Desde sexta-feira, rodando 24/7.*");
    assert.ok(
      out.includes("<em>Desde sexta-feira, rodando 24/7.</em>"),
      `itálico ausente: ${out}`,
    );
  });

  it("#6084: bold **texto** e itálico *texto* na mesma string não colidem", () => {
    const out = mdInlineToHtml("Isto é **negrito** e isto é *itálico*.");
    assert.ok(out.includes("<b>negrito</b>"), `bold ausente: ${out}`);
    assert.ok(out.includes("<em>itálico</em>"), `itálico ausente: ${out}`);
    assert.doesNotMatch(out, /<em>[^<]*negrito/, `bold não deve virar itálico: ${out}`);
  });
});
