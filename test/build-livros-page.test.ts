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
  type Book,
} from "../scripts/build-livros-page.ts";

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

  it("livro sem cover usa placeholder, com cover usa <img>", () => {
    assert.match(html, /<img class="cover"/); // Alpha
    assert.match(html, /cover--ph/); // Beta
  });

  it("é self-contained (sem fetch externo; dados e JS inline)", () => {
    assert.doesNotMatch(html, /fetch\(/);
    assert.match(html, /<script>/);
  });

  it("escapa conteúdo dos livros (sem injeção)", () => {
    const evil = renderLivrosPage([book({ title: '<script>alert(1)</script>', summary: "x & y" })]);
    assert.doesNotMatch(evil, /<script>alert\(1\)<\/script>/);
    assert.match(evil, /&lt;script&gt;/);
  });
});
