/**
 * test/retrospectiva-mobile-9492.test.ts (#9492)
 *
 * A Retrospectiva é o render do E-MAIL mensal servido como página: cartão em
 * `<table width="600">` + 10px de margem. Num celular de 375px isso abria um
 * viewport de layout de 620px (medido em 02/10/2026, ciclo 2609-10) e o texto
 * cortava na borda. A correção é CSS só da versão web, dentro de
 * `max-width:640px` — desktop e o canal de e-mail ficam intactos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  injectWebMobileStyle,
  WEB_MOBILE_STYLE,
  WEB_MOBILE_STYLE_ID,
} from "../scripts/lib/mensal/build-article-page.ts";
import { draftToEmail } from "../scripts/lib/mensal/monthly-render.ts";
import {
  GATE_MOBILE_CSS,
  renderEmailForm,
  renderPaywall,
  renderCycleNotFound,
  renderTeaserWithPaywall,
} from "../workers/retrospectiva/src/render-mensal.ts";
import { renderEmailForm as renderAnualEmailForm } from "../workers/retrospectiva/src/render-anual.ts";

const DRAFT = `**ASSUNTO**

Setembro em IA

**PREVIEW**

O mês

**DESTAQUE 1 | INDÚSTRIA**

**Agentes saem do teste**

Texto do destaque com um link [fonte](https://example.com/a).
`;

/** Extrai o conteúdo do 1º bloco `@media (max-width: Npx) { ... }` do CSS. */
function mediaMaxWidth(css: string): number | null {
  const m = css.match(/@media[^{]*max-width:\s*(\d+)px/);
  return m ? Number(m[1]) : null;
}

describe("#9492 — artigo web: CSS responsivo injetado só na versão web", () => {
  it("regressão: o HTML do artigo tem viewport meta e o bloco mobile que solta o cartão de 600px", () => {
    const { html } = draftToEmail(DRAFT, null, "2609");
    const web = injectWebMobileStyle(html);
    assert.match(web, /<meta name="viewport" content="width=device-width/);
    assert.ok(web.includes(`id="${WEB_MOBILE_STYLE_ID}"`));
    // O cartão fixo existe no render (é o que causava o corte) e o CSS o solta.
    assert.match(web, /<table[^>]*width="600"/);
    assert.match(WEB_MOBILE_STYLE, /table\[width="600"\]\s*\{\s*width:100% !important/);
    assert.match(WEB_MOBILE_STYLE, /img\s*\{\s*max-width:100% !important/);
    // O style entra no <head>, antes do </head>.
    assert.ok(web.indexOf(WEB_MOBILE_STYLE_ID) < web.indexOf("</head>"));
  });

  it("tudo condicionado a max-width ≤ 640px — desktop (cartão 600 + margem) intacto", () => {
    const w = mediaMaxWidth(WEB_MOBILE_STYLE);
    assert.ok(w !== null && w <= 640, `max-width=${w}`);
    // Nenhuma regra fora do @media: o que vem antes dele é só a abertura do <style>/comentário.
    const antes = WEB_MOBILE_STYLE.slice(0, WEB_MOBILE_STYLE.indexOf("@media"));
    assert.doesNotMatch(antes, /\{/);
  });

  it("o render do E-MAIL não ganha o CSS web (canal de e-mail intacto)", () => {
    const { html } = draftToEmail(DRAFT, null, "2609");
    assert.ok(!html.includes(WEB_MOBILE_STYLE_ID));
  });

  it("sem </head> lança — nunca publica sem o CSS em silêncio", () => {
    assert.throws(() => injectWebMobileStyle("<html><body>x</body></html>"), /sem <\/head>/);
  });

  it("injeta antes do ÚLTIMO </head>", () => {
    const out = injectWebMobileStyle("<head><title>a</head> texto</title></head><body></body>");
    assert.ok(out.lastIndexOf(WEB_MOBILE_STYLE_ID) > out.indexOf("</head>"));
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
});
