/**
 * test/brand-wordmark-site-4797.test.ts (#4797)
 *
 * O tratamento tipográfico da marca ("diar.ia.br" em negrito, com o "."/".br"
 * em teal) já existia só no e-mail (`applyBrandWordmark`,
 * `scripts/lib/newsletter-render-html.ts`). A issue #4797 extraiu o helper
 * pra `scripts/lib/shared/brand-wordmark.ts` e aplicou o mesmo tratamento nas
 * páginas do site — hubs temáticos, arquivo, livros, cursos e `workers/poll`.
 *
 * Este teste cobre o mecanismo de garantia pedido pela issue: renderizar
 * cada tipo de página pública com uma string de entrada contendo
 * "diar.ia.br" em corpo de texto e afirmar que a saída tem o `<strong>` com
 * o `.br` na cor teal — mais os 2 pontos de aplicação no nível do módulo
 * compartilhado (`renderInlineLinks`/`renderCuradoriaFooter`) que fazem essa
 * cobertura funcionar em livros/cursos/arquivo sem tocar aqueles builders
 * diretamente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyBrandWordmark } from "../scripts/lib/shared/brand-wordmark.ts";
import { renderInlineLinks } from "../scripts/lib/shared/markdown-links.ts";
import { renderCuradoriaFooter } from "../scripts/lib/shared/curadoria-page.ts";
import { renderHubPage, type HubContent } from "../scripts/lib/shared/hub-page.ts";
import { renderLivrosPage } from "../scripts/build-livros-page.ts";
import { renderCursosPage } from "../scripts/build-cursos-page.ts";
import { buildArchiveHtml } from "../workers/arquivo/src/render-archive.ts";
import type { SitemapEntry } from "../scripts/lib/fetch-sitemap.ts";
import { renderJogarGatePage } from "../workers/poll/src/web-gate.ts";
import { renderIdentityFormBlock, renderInlineSignupFormBlock } from "../workers/poll/src/jogar.ts";

// Marcação canônica do wordmark — mesma constante (por valor) de
// `scripts/lib/shared/brand-wordmark.ts::BRAND_WORDMARK_HTML`. Repetida aqui
// deliberadamente (não importada — o módulo não exporta a constante crua),
// pra que o teste também sirva de guard contra um drift silencioso de estilo.
const WM = '<strong>diar<span style="color:#00A0A0">.</span>ia<span style="color:#00A0A0">.br</span></strong>';

describe("applyBrandWordmark (#4797 — extraído pra scripts/lib/shared/brand-wordmark.ts)", () => {
  it("estiliza diar.ia.br em negrito com . e .br em teal", () => {
    assert.equal(applyBrandWordmark("veja a diar.ia.br hoje"), `veja a ${WM} hoje`);
  });

  it("nunca toca URLs (lookbehind/lookahead preservados na extração)", () => {
    const url = "https://diar.ia.br/p/algo";
    assert.equal(applyBrandWordmark(url), url);
  });
});

describe("renderInlineLinks aplica o wordmark ao texto puro (#4797)", () => {
  it("texto sem link ganha o wordmark", () => {
    assert.equal(renderInlineLinks("A diar.ia.br publica todo dia."), `A ${WM} publica todo dia.`);
  });

  it("texto com link markdown: wordmark só na parte de FORA do link, nunca dentro do href/label", () => {
    const out = renderInlineLinks("Leia [esta edição](https://diar.ia.br/p/x) da diar.ia.br.");
    assert.match(out, /<a href="https:\/\/diar\.ia\.br\/p\/x">esta edição<\/a>/, "href/label do link seguem intocados");
    assert.equal(
      out,
      `Leia <a href="https://diar.ia.br/p/x">esta edição</a> da ${WM}.`,
      "só o texto fora do link ganha o wordmark",
    );
  });
});

describe("renderCuradoriaFooter aplica o wordmark no crédito (#4797)", () => {
  it("crédito começando com 'diar.ia.br —' ganha o wordmark; a nav (link curto) não", () => {
    const html = renderCuradoriaFooter("diar.ia.br — curadoria de teste");
    assert.match(html, new RegExp(`foot-credit">${WM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — curadoria de teste`));
    // A entrada de nav "diar.ia.br" continua um link curto, sem o wordmark.
    assert.match(html, /<a href="https:\/\/diar\.ia\.br">diar\.ia\.br<\/a>/);
  });
});

function minimalHub(introParagraph: string): HubContent {
  return {
    slug: "teste",
    title: "Teste",
    metaDescription: "Descrição de teste.",
    introHeading: "Pergunta de teste?",
    introParagraph,
    sections: [{ heading: "Seção", paragraphs: ["Parágrafo de teste."] }],
    faq: Array.from({ length: 6 }, (_, i) => ({
      question: `Pergunta ${i + 1}?`,
      answer: `Resposta ${i + 1}.`,
    })),
    sourceEditions: [{ date: "2026-08-01", title: "Edição de teste", url: "https://diar.ia.br/p/edicao-teste" }],
    publishedDate: "2026-08-01",
    updatedDate: "2026-08-01",
    footerNavUtm: { source: "test", medium: "footer-nav" },
    methodologyNote: "O levantamento vem de 1 edição publicada em agosto de 2026; os números saem do arquivo da diar.ia.br, não de verificação independente junto às empresas.",
  };
}

describe("renderHubPage — introParagraph ganha o wordmark (#4797)", () => {
  it("introParagraph com 'diar.ia.br' em prosa vira <strong>/<span> teal", () => {
    // O fixture cita a marca SEM as construções que o contrato de prosa
    // proíbe (#4899): a publicação como sujeito de verbo de cobertura e a
    // dêixis "esta página". `renderHubPage` valida antes de renderizar, então
    // o texto antigo ("Esta página resume o que a diar.ia.br cobriu…") passou
    // a lançar. O que este teste garante é o wordmark, não a frase.
    const html = renderHubPage(minimalHub("Em 76 edições da diar.ia.br, o tema apareceu 84 vezes."));
    assert.match(html, new RegExp(`geo-intro">Em 76 edições da ${WM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, o tema`));
  });
});

describe("renderHubPage — metaDescription NUNCA ganha o wordmark (#4797, achado do fleet review pré-merge da PR #4822)", () => {
  it("metaDescription com 'diar.ia.br' vira texto plano no atributo content= — sem <strong>/<span> quebrando a tag", () => {
    const hub = minimalHub("Intro sem menção à marca.");
    // Cita a marca SEM a construção que o contrato de prosa proíbe (#4899):
    // a publicação como sujeito de verbo de cobertura. O que este teste
    // garante é que a marca NÃO ganha wordmark no atributo, não a frase.
    hub.metaDescription = "Inteligência artificial todos os dias, na diar.ia.br.";
    const html = renderHubPage(hub);
    const metaDescriptionTag = html.match(/<meta name="description" content="[^"]*">/)?.[0];
    const ogDescriptionTag = html.match(/<meta property="og:description" content="[^"]*">/)?.[0];
    assert.ok(metaDescriptionTag, "tag <meta name=\"description\"> deve existir");
    assert.ok(ogDescriptionTag, "tag <meta property=\"og:description\"> deve existir");
    assert.equal(
      metaDescriptionTag,
      '<meta name="description" content="Inteligência artificial todos os dias, na diar.ia.br.">',
    );
    for (const tag of [metaDescriptionTag!, ogDescriptionTag!]) {
      assert.ok(!tag.includes("<strong>"), `${tag} não deve conter <strong> — quebraria o atributo content=`);
      assert.ok(!tag.includes('<span style'), `${tag} não deve conter <span style — quebraria o atributo content=`);
    }
  });
});

describe("mecanismo de garantia por superfície (#4797) — hub, arquivo, livros, cursos", () => {
  it("hub temático: FAQ (geo-faq.ts) e rodapé (curadoria-page.ts) carregam o wordmark", () => {
    const html = renderHubPage(minimalHub("Intro sem menção à marca."));
    const count = html.split(WM).length - 1;
    assert.ok(count >= 1, "pelo menos 1 ocorrência do wordmark no hub (footer credit)");
  });

  it("home do arquivo: FAQ (buildArquivoFaq, texto próprio com 'diar.ia.br') carrega o wordmark", () => {
    const entries: SitemapEntry[] = [{ loc: "https://diar.ia.br/p/edicao-1", lastmod: "2026-07-27" }];
    const html = buildArchiveHtml(entries);
    assert.ok(html.includes(WM), "arquivo: nenhuma ocorrência do wordmark encontrada no HTML gerado");
  });

  it("livros: FAQ + rodapé (compartilhados via geo-faq.ts/curadoria-page.ts) carregam o wordmark", () => {
    const html = renderLivrosPage([
      {
        id: "b1",
        title: "Livro teste",
        link: "https://amzn.to/livro",
        language: "pt-br",
        level: "iniciante",
        themes: ["IA geral"],
        rating: 4.5,
        summary: "Resumo do livro.",
      },
    ]);
    assert.ok(html.includes(WM), "livros: nenhuma ocorrência do wordmark encontrada no HTML gerado");
  });

  it("cursos: FAQ + rodapé (compartilhados via geo-faq.ts/curadoria-page.ts) carregam o wordmark", () => {
    const html = renderCursosPage([
      {
        id: "c1",
        title: "Curso teste",
        platform: "Coursera",
        url: "https://example.com/curso",
        language: "pt-br",
        level: "iniciante",
        format: "video",
        duration_hours: 2,
        cost: "free",
        certificate: false,
        themes: ["Deep Learning"],
        summary: "Resumo do curso.",
      },
    ]);
    assert.ok(html.includes(WM), "cursos: nenhuma ocorrência do wordmark encontrada no HTML gerado");
  });
});

describe("workers/poll — sub-superfície separada, varredura própria de texto corrido (#4797)", () => {
  it("web-gate.ts (renderJogarGatePage): prosa com 'diar.ia.br' carrega o wordmark", () => {
    const html = renderJogarGatePage(null);
    assert.ok(html.includes(WM), "gate: nenhuma ocorrência do wordmark encontrada no HTML gerado");
  });

  it("jogar.ts (renderIdentityFormBlock): prosa/label com 'diar.ia.br' carrega o wordmark", () => {
    const html = renderIdentityFormBlock();
    assert.ok(html.includes(WM), "identity form: nenhuma ocorrência do wordmark encontrada no HTML gerado");
  });

  it("botões/CTAs curtos (\"Assinar a diar.ia.br (grátis)\") ficam de fora — mesma exclusão de nav/link do site", () => {
    const html = renderInlineSignupFormBlock();
    assert.match(html, /<button type="submit" class="signup-btn">Assinar a diar\.ia\.br \(grátis\)<\/button>/);
  });
});
