/**
 * build-livros-page.test.ts (#1744)
 *
 * Cobre os helpers puros da página piloto de livros: validação de schema
 * (erros vs warnings de curadoria), escaping e render (filtros presentes,
 * todos os cards, placeholders pra link/cover ausentes).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateBooks,
  renderLivrosPage,
  esc,
  isSafeUrl,
  loadBooks,
  type Book,
} from "../scripts/build-livros-page.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SEED = resolve(dirname(fileURLToPath(import.meta.url)), "..", "seed/books/livros-ia.json");

function book(over: Partial<Book> = {}): Book {
  return {
    id: "b1",
    title: "Livro Teste",
    author: "Autora X",
    year: 2024,
    language: "pt-br",
    level: "iniciante",
    themes: ["llms"],
    summary: "Resumo.",
    link: "https://ed.com/b1",
    cover_url: "https://ed.com/b1.jpg",
    ...over,
  };
}

describe("validateBooks (#1744)", () => {
  it("aceita um livro completo", () => {
    const v = validateBooks([book()]);
    assert.equal(v.ok, true);
    assert.equal(v.errors.length, 0);
    assert.equal(v.warnings.length, 0);
  });

  it("erro em campos obrigatórios ausentes", () => {
    const v = validateBooks([book({ title: "", author: "", summary: "" })]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("title")));
    assert.ok(v.errors.some((e) => e.includes("author")));
    assert.ok(v.errors.some((e) => e.includes("summary")));
  });

  it("erro em id duplicado", () => {
    const v = validateBooks([book({ id: "dup" }), book({ id: "dup", title: "Outro" })]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("duplicado")));
  });

  it("erro em language/level fora do enum", () => {
    const v = validateBooks([book({ language: "fr" as never, level: "deus" as never })]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("language")));
    assert.ok(v.errors.some((e) => e.includes("level")));
  });

  it("link/cover vazios são WARNING (curadoria), não erro", () => {
    const v = validateBooks([book({ link: "", cover_url: "" })]);
    assert.equal(v.ok, true, "piloto não bloqueia por curadoria pendente");
    assert.ok(v.warnings.some((w) => w.includes("link pendente")));
    assert.ok(v.warnings.some((w) => w.includes("cover_url pendente")));
  });

  it("tema desconhecido é warning, não erro", () => {
    const v = validateBooks([book({ themes: ["llms", "inexistente"] })]);
    assert.equal(v.ok, true);
    assert.ok(v.warnings.some((w) => w.includes("tema desconhecido")));
  });

  it("link/cover com esquema não-http é warning (defense-in-depth)", () => {
    const v = validateBooks([book({ link: "javascript:alert(1)", cover_url: "data:text/html,x" })]);
    assert.equal(v.ok, true);
    assert.ok(v.warnings.some((w) => w.includes("link com esquema inválido")));
    assert.ok(v.warnings.some((w) => w.includes("cover_url com esquema inválido")));
  });
});

describe("seed real seed/books/livros-ia.json (#1744)", () => {
  const books = loadBooks(SEED); // lança se schema inválido

  it("tem 10 livros e passa a validação (sem erros)", () => {
    assert.equal(books.length, 10);
    assert.equal(validateBooks(books).ok, true);
  });

  it("todo link preenchido é https seguro (sem esquema perigoso)", () => {
    for (const b of books) {
      if (b.link) assert.ok(isSafeUrl(b.link), `${b.id}: link inseguro ${b.link}`);
      if (b.cover_url) assert.ok(isSafeUrl(b.cover_url), `${b.id}: cover inseguro ${b.cover_url}`);
    }
  });

  it("todos os 10 têm link de fato preenchido (curadoria de links completa)", () => {
    const semLink = books.filter((b) => !b.link).map((b) => b.id);
    assert.deepEqual(semLink, [], `livros sem link: ${semLink.join(", ")}`);
  });

  it("ids são únicos", () => {
    assert.equal(new Set(books.map((b) => b.id)).size, books.length);
  });
});

describe("isSafeUrl (#1744)", () => {
  it("aceita http/https, rejeita o resto", () => {
    assert.equal(isSafeUrl("https://ed.com/x"), true);
    assert.equal(isSafeUrl("http://ed.com/x"), true);
    assert.equal(isSafeUrl("HTTPS://ED.COM"), true);
    assert.equal(isSafeUrl("javascript:alert(1)"), false);
    assert.equal(isSafeUrl("data:text/html,x"), false);
    assert.equal(isSafeUrl("/relativo"), false);
    assert.equal(isSafeUrl(""), false);
    assert.equal(isSafeUrl(undefined), false);
  });
});

describe("esc (#1744)", () => {
  it("escapa metacaracteres HTML", () => {
    assert.equal(esc(`<b>"x" & 'y'`), "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;");
  });
});

describe("renderLivrosPage (#1744)", () => {
  const html = renderLivrosPage([
    book({ id: "a", title: "Alpha", language: "pt-br", level: "iniciante", themes: ["llms"] }),
    book({ id: "b", title: "Beta", language: "en", level: "avancado", themes: ["fundamentos"], link: "", cover_url: "" }),
  ]);

  it("renderiza todos os cards com data-* pros filtros", () => {
    assert.match(html, /data-lang="pt-br"/);
    assert.match(html, /data-lang="en"/);
    assert.match(html, /data-level="avancado"/);
    assert.match(html, /data-themes="fundamentos"/);
    assert.ok(html.includes("Alpha") && html.includes("Beta"));
  });

  it("inclui os 3 filtros (idioma, nível, tema)", () => {
    assert.match(html, /id="f-lang"/);
    assert.match(html, /id="f-level"/);
    assert.match(html, /id="f-theme"/);
  });

  it("livro com link renderiza CTA; sem link, placeholder desabilitado", () => {
    assert.match(html, /href="https:\/\/ed\.com\/b1"/); // Alpha tem link
    assert.match(html, /Link em breve/); // Beta não tem
  });

  it("link com esquema perigoso NÃO é emitido (cai no placeholder)", () => {
    const evil = renderLivrosPage([book({ id: "x", link: "javascript:alert(1)", cover_url: "javascript:1" })]);
    assert.doesNotMatch(evil, /javascript:/);
    assert.match(evil, /Link em breve/);
    assert.match(evil, /cover--ph/);
  });

  it("livro sem cover usa placeholder, com cover usa <img>", () => {
    assert.match(html, /<img class="cover"/); // Alpha
    assert.match(html, /cover--ph/); // Beta
  });

  it("é self-contained (sem fetch externo; dados e JS inline)", () => {
    assert.doesNotMatch(html, /fetch\(/);
    assert.match(html, /<script>/);
  });

  it("#1744: filtro esconde via style.display, não pelo atributo [hidden] (que .card{display:flex} sobrepõe)", () => {
    // Regressão: c.hidden=true não escondia porque `.card{display:flex}` (classe)
    // vence `[hidden]` (UA). O filtro precisa usar inline style.display.
    assert.match(html, /\.style\.display\s*=/);
    assert.doesNotMatch(html, /c\.hidden\s*=/);
    assert.doesNotMatch(html, /emptyEl\.hidden\s*=/);
  });

  it("escapa conteúdo dos livros (sem injeção)", () => {
    const evil = renderLivrosPage([book({ title: '<script>alert(1)</script>', summary: "x & y" })]);
    assert.doesNotMatch(evil, /<script>alert\(1\)<\/script>/);
    assert.match(evil, /&lt;script&gt;/);
  });
});
