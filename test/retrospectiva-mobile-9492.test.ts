/**
 * test/retrospectiva-mobile-9492.test.ts (#9492)
 *
 * A Retrospectiva era o render do E-MAIL mensal servido como página: cartão em
 * `<table width="600">` + 10px de margem. Num celular de 375px isso abria um
 * viewport de layout de 620px (medido em 02/10/2026, ciclo 2609-10) e o texto
 * cortava na borda. A 1ª correção foi CSS só da versão web; desde o #9872 a
 * página é HTML semântico sem tabela, e o teste trava a ausência de largura
 * fixa. O canal de e-mail fica intacto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildArticleHtml, buildArticleTeaserHtml } from "../scripts/lib/mensal/build-article-page.ts";
import { MONTHLY_WEB_STYLE, WEB_MOBILE_MAX_WIDTH } from "../scripts/lib/mensal/monthly-web-render.ts";
import { draftToEmail } from "../scripts/lib/mensal/monthly-render.ts";
import {
  GATE_MOBILE_CSS,
  renderEmailForm,
  renderPaywall,
  renderCycleNotFound,
  renderTeaserWithPaywall,
} from "../workers/retrospectiva/src/render-mensal.ts";
import {
  renderEmailForm as renderAnualEmailForm,
  renderTeaserWithSignup,
} from "../workers/retrospectiva/src/render-anual.ts";

const FIXTURE = resolve(import.meta.dirname, "fixtures/publish-monthly/2604/draft.md");

const DRAFT = `**ASSUNTO**

Setembro em IA

**PREVIEW**

O mês

**DESTAQUE 1 | INDÚSTRIA**

**Agentes saem do teste**

Texto do destaque com um link [fonte](https://example.com/a).
`;

/** Draft com corpo suficiente pro corte do trecho (`cutDraftAfterFirstDestaque`). */
const DRAFT_LONGO = `**ASSUNTO**

Setembro em IA

**DESTAQUE 1 | INDÚSTRIA**

${"Mais contexto sobre o destaque, com detalhes do que aconteceu no mês. ".repeat(12)}

**DESTAQUE 2 | BRASIL**

Texto do segundo destaque.
`;

/** Extrai o conteúdo do 1º bloco `@media (max-width: Npx) { ... }` do CSS. */
function mediaMaxWidth(css: string): number | null {
  const m = css.match(/@media[^{]*max-width:\s*(\d+)px/);
  return m ? Number(m[1]) : null;
}

describe("#9492 / #9872 — artigo web legível no celular", () => {
  // #9872: a página deixou de ser o render do e-mail (tabela de 600px que um CSS
  // extra "soltava" no celular) e virou HTML semântico com CSS próprio. O
  // invariante do #9492 continua o mesmo: nada de largura fixa que abra um
  // viewport de layout maior que a tela.
  const paginas = () => {
    const md = readFileSync(FIXTURE, "utf8");
    return [buildArticleHtml(md, "2604-05").html, buildArticleTeaserHtml(DRAFT_LONGO, "2604-05").html];
  };

  it("regressão: viewport meta e nenhum layout de largura fixa (sem <table>, sem width=600)", () => {
    for (const html of paginas()) {
      assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
      assert.doesNotMatch(html, /<table\b/i, "tabela de layout é o que abria o viewport de 620px");
      assert.doesNotMatch(html, /width="\d+"/, "atributo de largura fixa");
    }
  });

  it("CSS da página: nenhuma largura fixa em px acima da tela; imagens limitadas à coluna", () => {
    // `max-width` em px/rem é limite (encolhe), não largura — o que quebra é `width: Npx`.
    const fixas = [...MONTHLY_WEB_STYLE.matchAll(/(?<![-\w])width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    assert.ok(fixas.every((w) => w <= 320), `larguras fixas: ${fixas.join(", ")}`);
    assert.match(MONTHLY_WEB_STYLE, /img \{ max-width: 100%; height: auto; \}/);
    assert.match(MONTHLY_WEB_STYLE, /overflow-wrap: break-word/, "URL longa quebra em vez de vazar");
  });

  it("ajuste de celular condicionado a max-width ≤ 640px", () => {
    const w = mediaMaxWidth(MONTHLY_WEB_STYLE);
    assert.ok(w !== null && w <= 640 && w === WEB_MOBILE_MAX_WIDTH, `max-width=${w}`);
  });

  it("o CSS da página fica no <head>", () => {
    for (const html of paginas()) {
      assert.ok(html.indexOf(MONTHLY_WEB_STYLE) > 0 && html.indexOf(MONTHLY_WEB_STYLE) < html.indexOf("</head>"));
    }
  });

  it("o render do E-MAIL não ganha o CSS web (canal de e-mail intacto)", () => {
    const { html } = draftToEmail(DRAFT, null, "2609");
    assert.ok(!html.includes(MONTHLY_WEB_STYLE));
    assert.match(html, /<table[^>]*width="600"/, "o e-mail continua em tabelas, como clientes de e-mail exigem");
  });
});

describe("#9492 — telas de acesso (gate) no celular", () => {
  it("as 3 telas mensais e a anual têm viewport meta e o CSS mobile do gate", () => {
    for (const page of [renderEmailForm("2609"), renderPaywall("2609"), renderCycleNotFound("2609"), renderAnualEmailForm("2026", "https://retrospectiva.diar.ia.br/2026")]) {
      assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
      assert.ok(page.includes(GATE_MOBILE_CSS));
    }
  });

  it("CSS do gate: só abaixo de 640px, botão largura total e alvo de toque ≥ 44px", () => {
    const w = mediaMaxWidth(GATE_MOBILE_CSS);
    assert.ok(w !== null && w <= 640);
    assert.match(GATE_MOBILE_CSS, /a\.button, button\.button \{[^}]*width:100% !important/);
    const minH = Number(GATE_MOBILE_CSS.match(/min-height:(\d+)px/)?.[1]);
    assert.ok(minH >= 44, `min-height=${minH}`);
  });

  it("bloco de paywall do trecho: CTA marcado e media query escopada no id", () => {
    const out = renderTeaserWithPaywall("<html><head></head><body><p>trecho</p></body></html>", "2609");
    assert.match(out, /@media only screen and \(max-width: 640px\)[\s\S]*#retrospectiva-paywall/);
    assert.match(out, /<a class="retrospectiva-cta" href="https:\/\/apoia\.se\/diaria/);
  });

  it("bloco de cadastro do trecho ANUAL: mesma media query, escopada no próprio id", () => {
    const out = renderTeaserWithSignup("<html><head></head><body><p>t</p></body></html>", "https://x/2026", "2026");
    assert.match(out, /@media only screen and \(max-width: 640px\)[\s\S]*#retrospectiva-signup/);
    assert.match(out, /<div id="retrospectiva-signup"/);
  });
});
