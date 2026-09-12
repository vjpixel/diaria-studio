/**
 * test/annual-web-render-8039.test.ts
 *
 * A página pública da anual (`retrospectiva.diar.ia.br/aniversarioAAAA`) saía
 * com o HTML do E-MAIL: tabelas de layout, fundo branco, sem `<title>`, sem o
 * cabeçalho/rodapé das páginas do site (#8039). Estes testes travam:
 *   1. a página web é markup semântico no DS do site, não layout de e-mail;
 *   2. o contrato com o Worker `retrospectiva` (injeção antes do último
 *      `</body>`/`</head>`) continua valendo pro trecho;
 *   3. o e-mail do Kit (`renderAnnualEmail`) não mudou de natureza.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAnnualHtml, buildAnnualTeaserHtml } from "../scripts/lib/anual/build-annual-page.ts";
import { parseAnnualDraft } from "../scripts/lib/anual/annual-parse.ts";
import { renderAnnualEmail } from "../scripts/lib/anual/annual-render.ts";
import { renderTeaserWithSignup } from "../workers/retrospectiva/src/render-anual.ts";
import { extractTitleText } from "../scripts/lib/shared/retrospectiva-seo.ts";

const THEME = (n: number) =>
  [
    `**TEMA ${n} | NOME ${n}**`,
    "",
    `Título do tema ${n}`,
    "",
    `Parágrafo do tema ${n} sobre a diar.ia.br, com [um link](https://diar.ia.br/p/edicao-${n}). `.repeat(8),
    "",
    "O fio condutor:",
    `Fio do tema ${n}.`,
    "",
  ].join("\n");

const MD = [
  "**ASSUNTO**",
  "1. 1 ano de diar.ia.br: retrospectiva",
  "",
  "**INTRO**",
  "",
  "Faz um ano que a diar.ia.br chega no seu e-mail.",
  "",
  "**ANIVERSÁRIO**",
  "",
  "Foram 261 edições.",
  "",
  THEME(1),
  THEME(2),
  THEME(3),
  "**PREVISÕES**",
  "",
  "Previsão exclusiva do completo.",
  "",
  "**PARA ENCERRAR**",
  "",
  "Obrigado por ler!",
].join("\n");

const OPTS = {
  windowLabel: "2026-aniversario",
  tipo: "aniversario" as const,
  images: { 1: "https://x.invalid/1.jpg", 2: "https://x.invalid/2.jpg", 3: "https://x.invalid/3.jpg" },
};

describe("página web da anual no DS do site (#8039)", () => {
  const { html, imageCount, missingImages } = buildAnnualHtml(MD, OPTS);

  it("não usa tabela de layout de e-mail", () => {
    assert.ok(!/<table/i.test(html), "a página web não pode ter <table>");
  });

  it("tem <title> com o assunto, em texto puro", () => {
    assert.equal(extractTitleText(html), "1 ano de diar.ia.br: retrospectiva");
  });

  it("markup semântico: article, h1, uma section por tema, figure", () => {
    assert.match(html, /<article>/);
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.equal((html.match(/<section class="theme"/g) ?? []).length, 3);
    assert.equal(imageCount, 3);
    assert.deepEqual(missingImages, []);
  });

  it("fundo papel do DS (não o branco do e-mail) e rodapé com a navegação do site", () => {
    assert.match(html, /--paper: #FBFAF6/);
    assert.match(html, /<footer>/);
    assert.match(html, /arquivo\.diar\.ia\.br/);
  });

  it("wordmark da marca aplicado no texto, sem tocar as URLs", () => {
    assert.match(html, /diar<span style="color:#00A0A0">\.<\/span>ia/);
    assert.match(html, /href="https:\/\/diar\.ia\.br\/p\/edicao-1"/);
  });
});

describe("trecho: contrato com o Worker `retrospectiva` preservado (#8039)", () => {
  const teaser = buildAnnualTeaserHtml(MD, "2026-aniversario", OPTS).html;

  it("sai sem rodapé — o convite de cadastro é que fecha a página", () => {
    assert.ok(!/<footer>/.test(teaser));
    const out = renderTeaserWithSignup(teaser, "https://retrospectiva.diar.ia.br/aniversario2026", "aniversario2026");
    assert.ok(out.indexOf("</article>") < out.indexOf('class="signup"'), "o form vem depois do artigo");
    assert.equal((out.match(/<\/body>/g) ?? []).length, 1);
  });

  it("nunca leva conteúdo exclusivo do completo", () => {
    assert.ok(!teaser.includes("Título do tema 2"));
    assert.ok(!teaser.includes("Previsão exclusiva do completo"));
    assert.ok(teaser.includes("Título do tema 1"));
  });
});

describe("o e-mail do Kit não mudou (#8039 é só a superfície web)", () => {
  it("renderAnnualEmail segue em tabela de e-mail, fundo branco", () => {
    const { html } = renderAnnualEmail(parseAnnualDraft(MD), OPTS);
    assert.match(html, /<table role="presentation" class="container"/);
    assert.ok(!/<footer>/.test(html));
  });
});
