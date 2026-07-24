/**
 * test/poll-jogar-ux-4030.test.ts (#4030)
 *
 * "eia-web: ajustes de UX pós-deploy 260724 (logo, CTA newsletter, remover
 * onboarding/arquivo, borda verde na revelação)" — pedido do editor após
 * jogar a versão deployada. Cobre os 5 itens (itens 1 e 4 já têm cobertura
 * de regressão dedicada em test/poll-jogar-sequence-3589.test.ts,
 * test/poll-leaderboard-polish-4008.test.ts e
 * test/poll-jogar-cold-visitor-4005.test.ts — não duplicados aqui):
 *
 *   2. Logo visual da diar.ia.br no topo de `renderJogarPageHtml` (par
 *      único) e `renderJogarSequencePageHtml` (sequência).
 *   3. Convite explícito de assinatura na copy do form de identidade —
 *      sem reabrir a decisão #3589 item 4 (`renderSubscribeCtaBlock`
 *      continua sendo a caixa de "conheça o projeto", travada por
 *      test/poll-jogar-cta-3518.test.ts).
 *   5. Revelação sem duplicar imagens — cobertura extra de sanidade (a
 *      cobertura principal está em poll-jogar-suspense-3595.test.ts e
 *      poll-jogar-sequence-3589.test.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderJogarBrandLogoBlock,
  renderJogarPageHtml,
  renderJogarSequencePageHtml,
  renderIdentityFormBlock,
  renderSubscribeCtaBlock,
} from "../workers/poll/src/jogar.ts";

describe("renderJogarBrandLogoBlock (#4030 item 2, pure)", () => {
  it("SVG inline (sem <img src>/fetch externo) com o wordmark diar.ia.br", () => {
    const html = renderJogarBrandLogoBlock();
    assert.match(html, /<svg class="brand-logo"/);
    assert.doesNotMatch(html, /<img[^>]+src=/, "não deve ser um <img> com fetch externo — CSP do worker é restritiva");
  });

  it("linka pro site (buildBrandSiteUrl, com UTM próprio medium=jogar-logo)", () => {
    const html = renderJogarBrandLogoBlock();
    assert.match(html, /<a class="brand-logo-link" href="[^"]*utm_medium=jogar-logo/);
  });

  it("cores vêm de DS_COLORS (ink/brand) — nunca hex hardcoded fora do módulo de tokens (test/poll-ds-tokens.test.ts trava isso globalmente)", () => {
    const html = renderJogarBrandLogoBlock();
    assert.match(html, /fill="#171411"/, "ink");
    assert.match(html, /fill="#00A0A0"/, "brand/teal");
  });
});

describe("logo aparece nas duas páginas nomeadas pela issue (#4030 item 2)", () => {
  it("renderJogarPageHtml (par único): logo antes do kicker", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    const logoIdx = html.indexOf("brand-logo-link");
    const kickerIdx = html.indexOf('<p class="kicker">');
    assert.ok(logoIdx > -1 && kickerIdx > -1);
    assert.ok(logoIdx < kickerIdx, "logo deve vir ANTES do kicker no DOM");
  });

  it("renderJogarSequencePageHtml: logo antes do kicker", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    const logoIdx = html.indexOf("brand-logo-link");
    const kickerIdx = html.indexOf('<p class="kicker">');
    assert.ok(logoIdx > -1 && kickerIdx > -1);
    assert.ok(logoIdx < kickerIdx, "logo deve vir ANTES do kicker no DOM");
  });
});

describe("convite explícito de assinatura (#4030 item 3)", () => {
  it("renderIdentityFormBlock: copy nomeia o valor da newsletter explicitamente", () => {
    const html = renderIdentityFormBlock();
    assert.match(html, /Quer um par desses todo dia no seu e-mail/);
    assert.match(html, /assine a Diar\.ia/i);
  });

  it("renderSubscribeCtaBlock (#3589 item 4) NÃO foi tocado — continua a caixa de descoberta, sem empurrar assinatura (ver test/poll-jogar-cta-3518.test.ts)", () => {
    const html = renderSubscribeCtaBlock();
    assert.match(html, /Conhe(ç|c)a a Diar\.ia|Conhecer a Diar\.ia/i);
    assert.doesNotMatch(html, /Assinar a Diar\.ia/i);
  });
});

describe("revelação sem duplicar imagens (#4030 item 5) — sanidade adicional", () => {
  it(".choice ganha data-side (A/B) — pré-requisito do reveal in-place", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /class="choice" data-side="A"/);
    assert.match(html, /class="choice" data-side="B"/);
  });

  it("CSS .choice.correct-ai usa box-shadow SEM inset (não border) — não altera o box model no momento do reveal", () => {
    // #4036 (item 2): a versão original (#4030) usava `inset`, que fica por
    // baixo do <img> opaco e nunca aparece — ver test/poll-jogar-ux-4036.test.ts
    // pra cobertura completa do fix (glow visível, sem inset). Aqui só trava
    // que a regra continua usando box-shadow (não border, que mudaria o box
    // model).
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /\.choice\.correct-ai img \{ box-shadow: /);
    assert.doesNotMatch(html, /\.choice\.correct-ai img \{[^}]*inset/, "inset é invisível sobre um <img> opaco — exatamente o bug do #4036 item 2");
  });

  it("renderJogarPageHtml (par único) NÃO foi tocado pelo item 5 — continua substituindo o form pelo resultado (form.hidden=true), nunca duplicava imagem", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.match(html, /form\.hidden = true;/);
    assert.match(html, /if \(imagesEl\) out \+= imagesEl\.outerHTML;/, "par único continua injetando .result-images normalmente — não é o caso que o item 5 corrige");
  });
});
