/**
 * tagline-oficial.test.ts (#3577, atualizado #3695)
 *
 * Regressão pro #633: PR #3583 substituiu as 3 variantes antigas de tagline
 * pela oficial em `context/editorial-rules.md` (maior alavanca — entra no
 * system prompt de todos os writer agents), `scripts/build-cursos-page.ts` e
 * `scripts/build-livros-page.ts`, mas mergeou sem teste guardando a troca.
 * Este arquivo fecha essa lacuna: garante que a tagline oficial aparece nessas
 * superfícies e que nenhuma das variantes antigas volta por engano.
 *
 * #3695 (2026-07-19): forma singular "usar melhor a IA" trocada pela plural
 * "usar melhor as IAs" — decisão do editor, "as IAs" é a nova forma canônica.
 * A forma singular vira variante proibida.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderCursosPage, type Course } from "../scripts/build-cursos-page.ts";
import { renderLivrosPage, type Book } from "../scripts/build-livros-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TAGLINE_OFICIAL = "5 minutos diários pra se manter atualizado e usar melhor as IAs";

const VARIANTES_ANTIGAS = [
  "Seu filtro no caos de notícias sobre IA",
  "As notícias essenciais sobre IA em 5 minutos, diariamente.",
  "notícias essenciais sobre IA em 5 minutos",
  "usar melhor a IA",
];

function course(over: Partial<Course> = {}): Course {
  return {
    id: "c1",
    title: "Curso Teste",
    platform: "Coursera",
    url: "https://www.coursera.org/learn/x",
    language: "pt-br",
    level: "iniciante",
    format: "video",
    duration_hours: 3,
    cost: "free",
    certificate: true,
    themes: ["Fundamentos"],
    summary: "Resumo.",
    ...over,
  };
}

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

describe("tagline oficial (#3577) — páginas de curadoria", () => {
  it("página de Cursos renderiza a tagline oficial", () => {
    const html = renderCursosPage([course()]);
    assert.ok(html.includes(TAGLINE_OFICIAL), "HTML de cursos deve conter a tagline oficial");
    for (const antiga of VARIANTES_ANTIGAS) {
      assert.ok(!html.includes(antiga), `HTML de cursos não pode conter a variante antiga: "${antiga}"`);
    }
  });

  it("página de Livros renderiza a tagline oficial", () => {
    const html = renderLivrosPage([book()]);
    assert.ok(html.includes(TAGLINE_OFICIAL), "HTML de livros deve conter a tagline oficial");
    for (const antiga of VARIANTES_ANTIGAS) {
      assert.ok(!html.includes(antiga), `HTML de livros não pode conter a variante antiga: "${antiga}"`);
    }
  });
});

describe("tagline oficial (#3577) — context editorial", () => {
  it("editorial-rules.md (maior alavanca — system prompt dos writer agents) traz a tagline oficial", () => {
    const content = readFileSync(resolve(ROOT, "context/editorial-rules.md"), "utf8");
    assert.ok(content.includes(TAGLINE_OFICIAL), "editorial-rules.md deve conter a tagline oficial");
    for (const antiga of VARIANTES_ANTIGAS) {
      assert.ok(!content.includes(antiga), `editorial-rules.md não pode conter a variante antiga: "${antiga}"`);
    }
  });
});
