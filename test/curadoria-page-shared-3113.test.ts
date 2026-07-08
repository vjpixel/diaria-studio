/**
 * test/curadoria-page-shared-3113.test.ts (#3113)
 *
 * Regressão para o lote de consistência Cursos/Livros/É IA? (item Bloco A):
 *
 *   1. `.title-row h2` (título do card): drift 22px/1.14 (cursos) vs
 *      23px/1.12 (livros) unificado — as 2 páginas agora usam o mesmo valor
 *      (22px/1.14), via CSS extraído para `scripts/lib/shared/curadoria-page.ts`.
 *   2. `.filters select` min-width: drift 130 (cursos) vs 140 (livros)
 *      unificado em 140px nas 2 páginas.
 *   3. `.summary` margin-top: drift 14px (cursos) vs 12px (livros) unificado
 *      em 14px nas 2 páginas.
 *   4. Footer de navegação cruzada (Diar.ia · Cursos · Livros · É IA?),
 *      incluindo link de volta pro diar.ia.br — ausente antes do #3113.
 *
 * Cobre tanto o módulo compartilhado isolado quanto os HTMLs gerados pelos 2
 * builders (garante que ambos de fato ADOTARAM o módulo, não só que o módulo
 * existe).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderCuradoriaGridCardStyles,
  renderCuradoriaFiltersBaseStyles,
  renderCuradoriaFooter,
  CURADORIA_NAV_LINKS,
} from "../scripts/lib/shared/curadoria-page.ts";
import { renderCursosPage } from "../scripts/build-cursos-page.ts";
import { renderLivrosPage } from "../scripts/build-livros-page.ts";

const course = (over: Partial<Parameters<typeof renderCursosPage>[0][number]> = {}) => ({
  id: "c1",
  title: "Curso teste",
  platform: "Coursera",
  url: "https://example.com/curso",
  language: "pt-br" as const,
  level: "iniciante" as const,
  format: "video" as const,
  duration_hours: 2,
  cost: "free" as const,
  certificate: false,
  themes: ["Deep Learning"],
  summary: "Resumo do curso.",
  ...over,
});

const book = (over: Partial<Parameters<typeof renderLivrosPage>[0][number]> = {}) => ({
  id: "b1",
  title: "Livro teste",
  link: "https://amzn.to/livro",
  language: "pt-br" as const,
  level: "iniciante" as const,
  themes: ["IA geral"],
  rating: 4.5,
  summary: "Resumo do livro.",
  ...over,
});

describe("curadoria-page.ts — módulo compartilhado (#3113)", () => {
  it("h2 do card é 22px/line-height 1.14 (valor canônico, era 22 em cursos / 23 em livros)", () => {
    const css = renderCuradoriaGridCardStyles();
    assert.match(css, /\.title-row h2 \{[^}]*font-size: 22px;[^}]*line-height: 1\.14;/);
  });

  it("select de filtro tem min-width 140px (valor canônico, era 130 em cursos / 140 em livros)", () => {
    const css = renderCuradoriaFiltersBaseStyles();
    assert.match(css, /\.filters select \{[^}]*min-width: 140px;/);
  });

  it(".summary tem margin-top 14px (valor canônico, era 14 em cursos / 12 em livros)", () => {
    const css = renderCuradoriaGridCardStyles();
    assert.match(css, /\.summary \{[^}]*margin: 14px 0 18px;/);
  });

  it("nav cruzada tem as 4 superfícies, Diar.ia primeiro e apontando pro diar.ia.br", () => {
    assert.equal(CURADORIA_NAV_LINKS.length, 4);
    assert.deepEqual(
      CURADORIA_NAV_LINKS.map((l) => l.label),
      ["Diar.ia", "Cursos", "Livros", "É IA?"],
    );
    assert.equal(CURADORIA_NAV_LINKS[0].url, "https://diar.ia.br");
  });

  it("renderCuradoriaFooter monta os 4 links + texto de crédito, escapando HTML", () => {
    const html = renderCuradoriaFooter('diar.ia.br — curadoria de <script>');
    assert.match(html, /<a href="https:\/\/diar\.ia\.br">Diar\.ia<\/a>/);
    assert.match(html, /<a href="https:\/\/cursos\.diaria\.workers\.dev\/">Cursos<\/a>/);
    assert.match(html, /<a href="https:\/\/livros\.diaria\.workers\.dev\/">Livros<\/a>/);
    assert.match(html, /<a href="https:\/\/poll\.diaria\.workers\.dev\/leaderboard">É IA\?<\/a>/);
    assert.doesNotMatch(html, /<script>/, "texto de crédito deve ser escapado");
    assert.match(html, /&lt;script&gt;/);
  });
});

describe("build-cursos-page.ts adota o módulo compartilhado (#3113)", () => {
  const html = renderCursosPage([course()]);

  it("h2 do card é 22px/1.14 no HTML gerado", () => {
    assert.match(html, /\.title-row h2 \{[^}]*font-size: 22px;[^}]*line-height: 1\.14;/);
  });

  it("select tem min-width 140px no HTML gerado", () => {
    assert.match(html, /\.filters select \{[^}]*min-width: 140px;/);
  });

  it("footer tem nav cruzada com as 4 superfícies + crédito de cursos", () => {
    assert.match(html, /<footer>.*foot-nav.*Diar\.ia.*Cursos.*Livros.*É IA\?.*<\/footer>/s);
    assert.match(html, /diar\.ia\.br — curadoria de cursos sobre IA/);
  });
});

describe("build-livros-page.ts adota o módulo compartilhado (#3113)", () => {
  const html = renderLivrosPage([book()]);

  it("h2 do card é 22px/1.14 no HTML gerado (era 23px/1.12)", () => {
    assert.match(html, /\.title-row h2 \{[^}]*font-size: 22px;[^}]*line-height: 1\.14;/);
    assert.doesNotMatch(html, /font-size: 23px/);
  });

  it("select tem min-width 140px no HTML gerado (já era 140, mantido)", () => {
    assert.match(html, /\.filters select \{[^}]*min-width: 140px;/);
  });

  it(".summary tem margin-top 14px no HTML gerado (era 12px)", () => {
    assert.match(html, /\.summary \{[^}]*margin: 14px 0 18px;/);
  });

  it("footer tem nav cruzada com as 4 superfícies + crédito de livros", () => {
    assert.match(html, /<footer>.*foot-nav.*Diar\.ia.*Cursos.*Livros.*É IA\?.*<\/footer>/s);
    assert.match(html, /diar\.ia\.br — curadoria de livros sobre IA/);
  });
});
