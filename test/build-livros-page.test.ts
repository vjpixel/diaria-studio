/**
 * build-livros-page.test.ts (#1744)
 *
 * Helpers puros da página de livros: validação de schema, escaping, formatação
 * de nota, temas distintos e render (filtros, cards, badges, nota, highlight,
 * CTA de afiliado, empty-state via style.display).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateBooks,
  renderLivrosPage,
  esc,
  isSafeUrl,
  fmtRating,
  distinctThemes,
  loadBooks,
  type Book,
} from "../scripts/build-livros-page.ts";

const SEED = resolve(dirname(fileURLToPath(import.meta.url)), "..", "seed/books/livros-ia.json");

function book(over: Partial<Book> = {}): Book {
  return {
    id: "b1",
    title: "Livro Teste",
    link: "https://amzn.to/abc123",
    language: "pt-br",
    level: "iniciante",
    themes: ["História"],
    rating: 4.5,
    highlight: "Bestseller.",
    summary: "Para quem quer testar.",
    ...over,
  };
}

describe("validateBooks (#1744)", () => {
  it("aceita um livro completo", () => {
    const v = validateBooks([book()]);
    assert.equal(v.ok, true);
    assert.equal(v.errors.length, 0);
  });

  it("erro em campos obrigatórios ausentes (title/link/summary)", () => {
    const v = validateBooks([book({ title: "", link: "", summary: "" })]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("title")));
    assert.ok(v.errors.some((e) => e.includes("link")));
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

  it("themes vazio é permitido (alguns livros não têm tema)", () => {
    const v = validateBooks([book({ themes: [] })]);
    assert.equal(v.ok, true);
  });

  it("link não-http e rating fora de 0-5 são warning, não erro", () => {
    const v = validateBooks([book({ link: "javascript:alert(1)", rating: 9 })]);
    assert.equal(v.ok, true);
    assert.ok(v.warnings.some((w) => w.includes("esquema inválido")));
    assert.ok(v.warnings.some((w) => w.includes("rating")));
  });
});

describe("esc / isSafeUrl / fmtRating (#1744)", () => {
  it("esc escapa metacaracteres HTML", () => {
    assert.equal(esc(`<b>"x" & 'y'`), "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;");
  });
  it("isSafeUrl: http(s) sim, resto não", () => {
    assert.equal(isSafeUrl("https://amzn.to/x"), true);
    assert.equal(isSafeUrl("javascript:alert(1)"), false);
    assert.equal(isSafeUrl(""), false);
    assert.equal(isSafeUrl(undefined), false);
  });
  it("fmtRating: número → vírgula PT; ausente → null", () => {
    assert.equal(fmtRating(4.5), "4,5");
    assert.equal(fmtRating(5), "5,0");
    assert.equal(fmtRating(undefined), null);
  });
});

describe("distinctThemes (#1744)", () => {
  it("coleta temas distintos ordenados", () => {
    const ts = distinctThemes([book({ themes: ["História", "Design"] }), book({ id: "b2", themes: ["Design", "Ciência"] })]);
    assert.deepEqual(ts, ["Ciência", "Design", "História"]);
  });
});

describe("renderLivrosPage (#1744)", () => {
  const html = renderLivrosPage([
    book({ id: "a", title: "Alpha", language: "pt-br", level: "iniciante", themes: ["História"], rating: 4.7, link: "https://amzn.to/aaa" }),
    book({ id: "b", title: "Beta", language: "en", level: "avancado", themes: ["Engenharia"], rating: 4.2, highlight: "", link: "https://amzn.to/bbb" }),
  ]);

  it("cards com data-* pros filtros + títulos linkados ao amzn.to", () => {
    assert.match(html, /data-lang="pt-br"/);
    assert.match(html, /data-lang="en"/);
    assert.match(html, /data-themes="Engenharia"/);
    assert.match(html, /href="https:\/\/amzn\.to\/aaa"/);
  });
  it("inclui os 3 filtros + tema derivado dos dados", () => {
    assert.match(html, /id="f-lang"/);
    assert.match(html, /id="f-level"/);
    assert.match(html, /id="f-theme"/);
    assert.match(html, /<option value="Engenharia">Engenharia<\/option>/);
  });
  it("mostra a nota da Amazon (★)", () => {
    assert.match(html, /★ 4,7/);
    assert.match(html, /★ 4,2/);
  });
  it("badges de idioma/nível/tema", () => {
    assert.match(html, /badge--lang">Português/);
    assert.match(html, /class="badge">Iniciante/);
  });
  it("highlight aparece quando presente, some quando vazio", () => {
    assert.match(html, /class="highlight">Bestseller\./); // Alpha tem
    // Beta com highlight "" não deve gerar <p class="highlight">
    const betaBlock = html.slice(html.indexOf("Beta"));
    assert.doesNotMatch(betaBlock.slice(0, 400), /class="highlight"/);
  });
  it("links de afiliado marcados rel=sponsored", () => {
    assert.match(html, /rel="noopener noreferrer sponsored"/);
  });
  it("filtro via style.display; empty-state inline display:none", () => {
    assert.match(html, /\.style\.display\s*=/);
    assert.doesNotMatch(html, /c\.hidden\s*=/);
    assert.match(html, /id="empty"[^>]*style="display:none"/);
  });
  it("self-contained (sem fetch de dados)", () => {
    assert.doesNotMatch(html, /fetch\(/);
  });
  it("escapa conteúdo (sem injeção)", () => {
    const evil = renderLivrosPage([book({ title: "<script>alert(1)</script>", summary: "x & y" })]);
    assert.doesNotMatch(evil, /<script>alert\(1\)<\/script>/);
    assert.match(evil, /&lt;script&gt;/);
  });
});

describe("seed real seed/books/livros-ia.json (#1744)", () => {
  const books = loadBooks(SEED);

  it("tem 23 livros e passa a validação", () => {
    assert.equal(books.length, 23);
    assert.equal(validateBooks(books).ok, true);
  });
  it("todo link é amzn.to https (afiliado)", () => {
    for (const b of books) {
      assert.ok(isSafeUrl(b.link), `${b.id}: link inseguro ${b.link}`);
      assert.match(b.link, /^https:\/\/amzn\.to\//, `${b.id}: link não-amzn.to ${b.link}`);
    }
  });
  it("todo livro tem rating numérico 0-5", () => {
    for (const b of books) {
      assert.ok(typeof b.rating === "number" && b.rating >= 0 && b.rating <= 5, `${b.id}: rating ${b.rating}`);
    }
  });
  it("ids únicos", () => {
    assert.equal(new Set(books.map((b) => b.id)).size, books.length);
  });
});
