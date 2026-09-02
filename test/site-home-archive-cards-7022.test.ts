/**
 * test/site-home-archive-cards-7022.test.ts (#7022)
 *
 * Cobre os itens 1-3 da 2ª rodada de comparação Home × Beehiiv:
 *   1. Texto extraído (tags removidas) de headings com quebra de linha
 *      nunca gruda palavras — "Perguntas frequentes." mantém o espaço; já
 *      "Livros sobre IA."/"Cursos gratuitos." perderam a quebra de linha
 *      por decisão do editor (item 5 do triage: 1 linha só, sem
 *      itálico/teal) — deixaram de ter esse risco por não terem mais
 *      `<br>` nenhum.
 *   2. Cards do arquivo ganham tempo de leitura estimado (derivado do
 *      texto real, nunca "5 min" fixo) e autoria (`GEO_AUTHOR`).
 *   3. O arquivo da home renderiza no máximo `ARCHIVE_CARD_LIMIT` (6)
 *      cards, mesmo recebendo mais entradas — o resto vai pro
 *      `arquivo.diar.ia.br` via "Ver arquivo completo →" (item 4, já
 *      correto desde #6375 — sem mudança de código, só confirmado ao vivo
 *      nesta issue).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildHomeFeed,
  buildIndexHtml,
  estimateReadingMinutes,
  WORDS_PER_MINUTE,
  type HomeFeedEntry,
} from "../scripts/lib/site-home-page.ts";
import { buildSitemapXml } from "../scripts/lib/site-archive-pages.ts";
import { stripHtmlBasic } from "../scripts/lib/strip-html.ts";
import { GEO_AUTHOR } from "../scripts/lib/shared/geo-faq.ts";

function fakePageHtml(title: string, description: string, bodyWords = 0): string {
  const filler = Array.from({ length: bodyWords }, (_, i) => `palavra${i}`).join(" ");
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${description}"></head><body><p>${filler}</p></body></html>`;
}

describe("estimateReadingMinutes (#7022 item 2)", () => {
  it("devolve null para HTML sem nenhuma palavra", () => {
    assert.equal(estimateReadingMinutes("<html><body></body></html>"), null);
  });

  it("ignora conteúdo de <script>/<style>/<svg> na contagem", () => {
    const html = `<html><body>
      <script>var x = "não conta como palavra de leitura";</script>
      <style>.foo { color: red; }</style>
      <svg><text>ícone decorativo não conta</text></svg>
      <p>uma palavra real</p>
    </body></html>`;
    // "uma palavra real" = 3 palavras -> arredonda pra 1 min (mínimo).
    assert.equal(estimateReadingMinutes(html), 1);
  });

  it("deriva do word count real — não fixa 5 min pra qualquer input", () => {
    const words2x = WORDS_PER_MINUTE * 2;
    const html = fakePageHtml("T", "D", words2x);
    assert.equal(estimateReadingMinutes(html), 2);
  });

  it("nunca devolve menos que 1 minuto pra conteúdo não-vazio", () => {
    const html = fakePageHtml("T", "D", 3);
    assert.equal(estimateReadingMinutes(html), 1);
  });
});

describe("buildHomeFeed popula readingMinutes (#7022 item 2)", () => {
  it("computa readingMinutes a partir do HTML da página", () => {
    const sitemapXml = buildSitemapXml([{ loc: "https://diar.ia.br/p/edicao-x", lastmod: "2026-08-26" }]);
    const html = fakePageHtml("Edição X", "Resumo", WORDS_PER_MINUTE * 4);
    const feed = buildHomeFeed(sitemapXml, () => html);
    assert.equal(feed[0].readingMinutes, 4);
  });
});

describe("buildIndexHtml — meta do card do arquivo (#7022 item 2)", () => {
  const feature: HomeFeedEntry = {
    slug: "destaque-do-dia",
    title: "Destaque do dia",
    description: "Resumo do destaque",
    url: "https://diar.ia.br/p/destaque-do-dia",
    date: "2026-08-27",
    image: null,
  };

  it("mostra data, tempo de leitura e autoria (link pro GEO_AUTHOR)", () => {
    const html = buildIndexHtml({
      feature,
      archive: [
        {
          slug: "edicao-anterior",
          title: "Edição anterior",
          description: "Resumo anterior",
          url: "https://diar.ia.br/p/edicao-anterior",
          date: "2026-08-26",
          image: null,
          readingMinutes: 7,
        },
      ],
    });
    assert.match(html, /26 ago 2026/);
    assert.match(html, /7 min de leitura/);
    assert.match(
      html,
      new RegExp(`Por <a href="${GEO_AUTHOR.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" rel="author">Pixel</a>`),
    );
  });

  it("omite '\\d min de leitura' quando readingMinutes é null/ausente, mas mantém a autoria", () => {
    const html = buildIndexHtml({
      feature,
      archive: [
        {
          slug: "edicao-sem-tempo",
          title: "Edição sem tempo",
          description: "ok",
          url: "https://diar.ia.br/p/edicao-sem-tempo",
          date: "2026-08-25",
          image: null,
          readingMinutes: null,
        },
      ],
    });
    assert.ok(!/min de leitura/.test(html), "não deveria haver 'min de leitura' sem readingMinutes");
    assert.match(html, new RegExp(`Por <a href="[^"]+" rel="author">${GEO_AUTHOR.name}</a>`));
  });
});

describe("buildIndexHtml — limite de cards do arquivo (#7022 item 3)", () => {
  const feature: HomeFeedEntry = {
    slug: "destaque-do-dia",
    title: "Destaque do dia",
    description: "Resumo do destaque",
    url: "https://diar.ia.br/p/destaque-do-dia",
    date: "2026-08-27",
    image: null,
  };

  function makeArchive(n: number): HomeFeedEntry[] {
    return Array.from({ length: n }, (_, i) => ({
      slug: `edicao-${i}`,
      title: `Edição ${i}`,
      description: "ok",
      url: `https://diar.ia.br/p/edicao-${i}`,
      date: "2026-08-20",
      image: null,
    }));
  }

  it("renderiza no máximo 6 cards mesmo recebendo mais entradas", () => {
    const html = buildIndexHtml({ feature, archive: makeArchive(9) });
    const count = (html.match(/class="archive-card"/g) ?? []).length;
    assert.equal(count, 6, "deveria cortar em 6 cards, não renderizar os 9 recebidos");
  });

  it("com 6 ou menos entradas, renderiza todas (não corta abaixo do que existe)", () => {
    const html = buildIndexHtml({ feature, archive: makeArchive(4) });
    const count = (html.match(/class="archive-card"/g) ?? []).length;
    assert.equal(count, 4);
  });
});

describe("headings com quebra de linha — texto extraído nunca gruda palavras (#7022 item 1)", () => {
  const feature: HomeFeedEntry = {
    slug: "destaque-do-dia",
    title: "Destaque do dia",
    description: "Resumo do destaque",
    url: "https://diar.ia.br/p/destaque-do-dia",
    date: "2026-08-27",
    image: null,
  };
  const html = buildIndexHtml({ feature, archive: [] });

  it("'Perguntas frequentes.' mantém quebra de linha, mas o texto extraído tem espaço (não fica 'Perguntasfrequentes.')", () => {
    const match = html.match(/<h2>(Perguntas[\s\S]*?frequentes\.)<\/h2>/);
    assert.ok(match, "heading 'Perguntas ... frequentes.' não encontrado");
    const extracted = stripHtmlBasic(match![1]);
    assert.equal(extracted, "Perguntas frequentes.");
    assert.ok(!/Perguntasfrequentes/.test(extracted), "palavras grudadas — regressão do #7022 item 1");
  });

  it("'Livros sobre IA.' e 'Cursos gratuitos.' saem numa linha só, sem <br> (decisão do editor, item 5)", () => {
    assert.match(html, /<h3>Livros sobre IA\.<\/h3>/);
    assert.match(html, /<h3>Cursos <span class="accent">gratuitos\.<\/span><\/h3>/);
    assert.ok(!/Livros<br>/.test(html), "Livros não deveria mais ter <br>");
    assert.ok(!/Cursos <br>/.test(html) && !/Cursos<br>/.test(html), "Cursos não deveria mais ter <br>");
  });
});
