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

  it("#6084: itálico *texto* (asterisco único) vira <em> (mesmo estilo inline de processInlineItalics, compat Outlook)", () => {
    const out = mdInlineToHtml("*Desde sexta-feira, rodando 24/7.*");
    assert.ok(
      out.includes('<em style="font-style:italic;">Desde sexta-feira, rodando 24/7.</em>'),
      `itálico ausente: ${out}`,
    );
  });

  it("#6084: bold **texto** e itálico *texto* na mesma string não colidem", () => {
    const out = mdInlineToHtml("Isto é **negrito** e isto é *itálico*.");
    assert.ok(out.includes("<b>negrito</b>"), `bold ausente: ${out}`);
    assert.ok(out.includes("<em"), `itálico ausente: ${out}`);
    assert.ok(out.includes(">itálico</em>"), `itálico ausente: ${out}`);
    assert.doesNotMatch(out, /<em[^>]*>[^<]*negrito/, `bold não deve virar itálico: ${out}`);
  });

  it("#6087 (review da #6084): asterisco literal dentro de URL não colide com itálico fora do link — href não corrompe", () => {
    const out = mdInlineToHtml("Confira [aqui](https://web.archive.org/web/*/example.com) e *depois*.");
    assert.ok(
      out.includes('href="https://web.archive.org/web/*/example.com"'),
      `href corrompido ou ausente: ${out}`,
    );
    assert.doesNotMatch(out, /href="[^"]*<em/, `<em> vazou pro atributo href: ${out}`);
    assert.ok(out.includes(">depois</em>"), `itálico fora do link ausente: ${out}`);
  });

  it("#6087 (review da #6084): itálico com underscore _texto_ também suportado (paridade com processInlineItalics)", () => {
    const out = mdInlineToHtml("Isto é _itálico_ com underscore.");
    assert.ok(out.includes(">itálico</em>"), `itálico com underscore ausente: ${out}`);
  });

  it("#6087 CI: *[texto](url)* (itálico envolvendo link inteiro) vira <em><a>...</a></em> — mesma forma do bold já coberta em build-link-ctr.test.ts", () => {
    const out = mdInlineToHtml("Confira *[a novidade](https://exemplo.com/novidade)* hoje.");
    assert.match(
      out,
      /<em style="font-style:italic;"><a[^>]*href="https:\/\/exemplo\.com\/novidade"[^>]*>a novidade<\/a><\/em>/,
      `itálico não envolveu o link corretamente: ${out}`,
    );
    assert.doesNotMatch(out, /\*/, `asterisco literal sobrando: ${out}`);
  });

  it("#6087 CI: **[texto](url)** (bold envolvendo link) não deixa asterisco literal sobrando (regressão do bug que quebrou o CI desta PR)", () => {
    const out = mdInlineToHtml("Confira **[a novidade](https://exemplo.com/novidade)** hoje.");
    assert.match(
      out,
      /<b><a[^>]*href="https:\/\/exemplo\.com\/novidade"[^>]*>a novidade<\/a><\/b>/,
      `bold não envolveu o link corretamente: ${out}`,
    );
    assert.doesNotMatch(out, /\*/, `asterisco literal sobrando: ${out}`);
  });
});
