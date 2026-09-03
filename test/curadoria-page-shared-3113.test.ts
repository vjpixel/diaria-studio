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
 *   4. Footer de navegação cruzada (diar.ia.br · Cursos · Livros · É IA?),
 *      incluindo link de volta pro diar.ia.br — ausente antes do #3113.
 *
 * Cobre tanto o módulo compartilhado isolado quanto os HTMLs gerados pelos 2
 * builders (garante que ambos de fato ADOTARAM o módulo, não só que o módulo
 * existe).
 *
 * #5121: acrescenta "Arquivo" (`arquivo.diar.ia.br`) à nav — o único
 * `referringUrl` conhecido pelo Google pra esse host era `diar.ia.br/upgrade`,
 * então cursos/livros/É IA? (hosts já indexados) agora linkam de volta pro
 * acervo.
 *
 * #5126: acrescenta "Especial" (`especial.diar.ia.br`) à nav — mesmo
 * racional do #5121: o artigo especial (`/2026/o-agente/`) estava fora de
 * qualquer grafo de link interno; cursos/livros/É IA?/Arquivo (hosts já
 * indexados) agora linkam pra ele também.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderCuradoriaGridCardStyles,
  renderCuradoriaFiltersBaseStyles,
  renderCuradoriaFooter,
  CURADORIA_NAV_LINKS,
} from "../scripts/lib/shared/curadoria-page.ts";
import { renderCursosPage, PAGE_URL as CURSOS_PAGE_URL } from "../scripts/build-cursos-page.ts";
import { renderLivrosPage, PAGE_URL as LIVROS_PAGE_URL } from "../scripts/build-livros-page.ts";
import { DIARIA_ARQUIVO_URL, DIARIA_ESPECIAL_URL } from "../scripts/lib/canonical-urls.ts";

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

  it("nav cruzada tem as 7 superfícies, diar.ia.br primeiro e apontando pro diar.ia.br", () => {
    assert.equal(CURADORIA_NAV_LINKS.length, 7);
    assert.deepEqual(
      CURADORIA_NAV_LINKS.map((l) => l.label),
      ["diar.ia.br", "Cursos", "Livros", "É IA?", "Arquivo", "Especial", "Privacidade"],
    );
    assert.equal(CURADORIA_NAV_LINKS[0].url, "https://diar.ia.br");
  });

  // #7361: nenhuma das superfícies que coletam e-mail linkava a política de
  // privacidade — a nav cruzada compartilhada é a fonte mais barata pra
  // fechar isso em livros/cursos/arquivo/hub/entity de uma vez.
  it("nav cruzada inclui Privacidade apontando pro DIARIA_ARQUIVO_URL/privacidade", () => {
    const privacidadeLink = CURADORIA_NAV_LINKS.find((l) => l.label === "Privacidade");
    assert.ok(privacidadeLink, "CURADORIA_NAV_LINKS deveria ter uma entrada 'Privacidade'");
    assert.equal(privacidadeLink!.url, `${DIARIA_ARQUIVO_URL}/privacidade`);
  });

  // #5121: arquivo.diar.ia.br pendia de um único referringUrl conhecido —
  // esta entrada existe pra hosts já indexados (cursos/livros/É IA?) linkarem
  // de volta pro acervo.
  it("nav cruzada inclui Arquivo apontando pro DIARIA_ARQUIVO_URL canônico", () => {
    const arquivoLink = CURADORIA_NAV_LINKS.find((l) => l.label === "Arquivo");
    assert.ok(arquivoLink, "CURADORIA_NAV_LINKS deveria ter uma entrada 'Arquivo'");
    assert.equal(arquivoLink!.url, `${DIARIA_ARQUIVO_URL}/`);
  });

  // #5126: mesmo racional do teste "Arquivo" acima — o artigo especial
  // (`/2026/o-agente/`) não tinha nenhuma superfície nossa já indexada
  // linkando pra ele.
  it("nav cruzada inclui Especial apontando pro DIARIA_ESPECIAL_URL canônico", () => {
    const especialLink = CURADORIA_NAV_LINKS.find((l) => l.label === "Especial");
    assert.ok(especialLink, "CURADORIA_NAV_LINKS deveria ter uma entrada 'Especial'");
    assert.equal(especialLink!.url, `${DIARIA_ESPECIAL_URL}/`);
  });

  it("renderCuradoriaFooter monta os 7 links + texto de crédito, escapando HTML", () => {
    const html = renderCuradoriaFooter('diar.ia.br — curadoria de <script>');
    assert.match(html, /<a href="https:\/\/diar\.ia\.br">diar\.ia\.br<\/a>/);
    // #3698: domínio de marca (era cursos/livros.diaria.workers.dev).
    assert.match(html, /<a href="https:\/\/cursos\.diar\.ia\.br\/">Cursos<\/a>/);
    assert.match(html, /<a href="https:\/\/livros\.diar\.ia\.br\/">Livros<\/a>/);
    // #3904: domínio de marca (era poll.diaria.workers.dev).
    assert.match(html, /<a href="https:\/\/eia\.diar\.ia\.br\/leaderboard">É IA\?<\/a>/);
    // #5121: acervo de edições + hubs temáticos.
    assert.match(html, /<a href="https:\/\/arquivo\.diar\.ia\.br\/">Arquivo<\/a>/);
    // #5126: artigos especiais avulsos.
    assert.match(html, /<a href="https:\/\/especial\.diar\.ia\.br\/">Especial<\/a>/);
    // #7361: política de privacidade.
    assert.match(html, /<a href="https:\/\/arquivo\.diar\.ia\.br\/privacidade">Privacidade<\/a>/);
    assert.doesNotMatch(html, /<script>/, "texto de crédito deve ser escapado");
    assert.match(html, /&lt;script&gt;/);
  });

  it("renderCuradoriaFooter escapa apóstrofo (usa escHtml canônico, não um esc() local mais fraco)", () => {
    const html = renderCuradoriaFooter("é d'ele");
    assert.doesNotMatch(html, /d'ele/);
    assert.match(html, /d&#39;ele/);
  });

  // #4051: 2º parâmetro OPCIONAL — query string apensada SÓ ao link "diar.ia.br".
  it("sem diariaUtm (2º parâmetro ausente) — link diar.ia.br continua bare, comportamento pré-#4051", () => {
    const html = renderCuradoriaFooter("crédito");
    assert.match(html, /<a href="https:\/\/diar\.ia\.br">diar\.ia\.br<\/a>/);
  });

  it("com diariaUtm — apensa SÓ no link diar.ia.br; Cursos/Livros/É IA?/Arquivo/Especial/Privacidade continuam sem UTM", () => {
    const html = renderCuradoriaFooter("crédito", "utm_source=livros&utm_medium=footer-nav");
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\?utm_source=livros&amp;utm_medium=footer-nav">diar\.ia\.br<\/a>/);
    assert.match(html, /<a href="https:\/\/cursos\.diar\.ia\.br\/">Cursos<\/a>/);
    assert.match(html, /<a href="https:\/\/livros\.diar\.ia\.br\/">Livros<\/a>/);
    assert.match(html, /<a href="https:\/\/eia\.diar\.ia\.br\/leaderboard">É IA\?<\/a>/);
    assert.match(html, /<a href="https:\/\/arquivo\.diar\.ia\.br\/">Arquivo<\/a>/);
    assert.match(html, /<a href="https:\/\/especial\.diar\.ia\.br\/">Especial<\/a>/);
    assert.match(html, /<a href="https:\/\/arquivo\.diar\.ia\.br\/privacidade">Privacidade<\/a>/);
  });

  it("URLs de Cursos/Livros na nav batem com o PAGE_URL exportado de cada builder — sem isso, mudar o domínio num builder e esquecer aqui reintroduz o drift silencioso que o #3113 elimina", () => {
    const byLabel = Object.fromEntries(CURADORIA_NAV_LINKS.map((l) => [l.label, l.url]));
    assert.equal(byLabel["Cursos"], CURSOS_PAGE_URL);
    assert.equal(byLabel["Livros"], LIVROS_PAGE_URL);
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
    assert.match(html, /<footer>.*foot-nav.*diar\.ia\.br.*Cursos.*Livros.*É IA\?.*<\/footer>/s);
    // #4797: crédito do rodapé ganhou o wordmark da marca (negrito + `.`/`.br`
    // teal) — "diar.ia.br" não sobrevive mais como texto plano no foot-credit.
    assert.match(html, /foot-credit"><strong>diar<span[^>]*>\.<\/span>ia<span[^>]*>\.br<\/span><\/strong> — curadoria de cursos sobre IA/);
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
    assert.match(html, /<footer>.*foot-nav.*diar\.ia\.br.*Cursos.*Livros.*É IA\?.*<\/footer>/s);
    // #4797: crédito do rodapé ganhou o wordmark da marca (negrito + `.`/`.br`
    // teal) — "diar.ia.br" não sobrevive mais como texto plano no foot-credit.
    assert.match(html, /foot-credit"><strong>diar<span[^>]*>\.<\/span>ia<span[^>]*>\.br<\/span><\/strong> — curadoria de livros sobre IA/);
  });
});
