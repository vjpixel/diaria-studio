/**
 * test/poll-jogar-cta-3518.test.ts (#3518)
 *
 * CTA de assinatura pós-voto + funil UTM do "É IA?" standalone (conversão do
 * EPIC #3514). Construído sobre a fundação do #3516 (`/jogar`, brand `web`)
 * e o share card do #3517 (`#jogar-result-slot`). Cobre:
 *   - `buildSubscribeUrl` (pure) — usa `diaria.beehiiv.com` DIRETO (não
 *     `diar.ia.br`, #2613) com os 3 parâmetros UTM do funil
 *   - `renderSubscribeCtaBlock` (pure) — HTML do CTA, escondido por padrão,
 *     copy + link corretos, sem XSS
 *   - `renderJogarPageHtml` — o bloco aparece na página (hidden), o script
 *     revela o CTA tanto no caminho de voto novo quanto no de "já votou",
 *     nunca antes do voto
 *   - regressão: não quebra o fluxo de voto/share existente (#3516/#3517)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSubscribeUrl,
  renderJogarPageHtml,
  renderSubscribeCtaBlock,
  SUBSCRIBE_UTM_CAMPAIGN,
  SUBSCRIBE_UTM_MEDIUM,
  SUBSCRIBE_UTM_SOURCE,
} from "../workers/poll/src/jogar.ts";

describe("buildSubscribeUrl (#3518) — URL de assinatura com UTM do funil", () => {
  it("usa diaria.beehiiv.com DIRETO — não diar.ia.br (redirect do Registro.br dropa query string, #2613)", () => {
    const url = buildSubscribeUrl();
    assert.match(url, /^https:\/\/diaria\.beehiiv\.com\/\?/);
    assert.doesNotMatch(url, /diar\.ia\.br/);
  });

  it("carrega utm_source/utm_medium/utm_campaign do funil", () => {
    const url = buildSubscribeUrl();
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("utm_source"), SUBSCRIBE_UTM_SOURCE);
    assert.equal(parsed.searchParams.get("utm_medium"), SUBSCRIBE_UTM_MEDIUM);
    assert.equal(parsed.searchParams.get("utm_campaign"), SUBSCRIBE_UTM_CAMPAIGN);
  });

  it("utm_source é 'eia-standalone' — mesma convenção de medição de count-subscriptions-by-utm.ts (utm_source=clarice pra Clarice)", () => {
    assert.equal(SUBSCRIBE_UTM_SOURCE, "eia-standalone");
  });

  it("determinística — mesma URL em chamadas repetidas (sem variante A/B, decisão conservadora)", () => {
    assert.equal(buildSubscribeUrl(), buildSubscribeUrl());
  });
});

describe("renderSubscribeCtaBlock (#3518) — bloco HTML do CTA", () => {
  it("contém id=jogar-subscribe-cta, hidden por padrão (nunca antes do voto)", () => {
    const html = renderSubscribeCtaBlock();
    assert.match(html, /<div id="jogar-subscribe-cta" class="subscribe-cta" hidden>/);
  });

  it("link aponta pra buildSubscribeUrl() com os UTMs (& escapado como &amp; em atributo HTML)", () => {
    const html = renderSubscribeCtaBlock();
    const url = buildSubscribeUrl();
    const escapedHref = url.replace(/&/g, "&amp;");
    assert.match(html, new RegExp(`href="${escapedHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  });

  it("abre em nova aba (target=_blank) — não perde o estado do jogo ao converter", () => {
    const html = renderSubscribeCtaBlock();
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener"/);
  });

  it("copy menciona o valor da assinatura (par diário + 3 notícias + grátis)", () => {
    const html = renderSubscribeCtaBlock();
    assert.match(html, /todo dia/i);
    assert.match(html, /Grátis/);
  });
});

describe("GET /jogar embute o CTA de assinatura hidden (#3518)", () => {
  it("renderJogarPageHtml inclui o bloco do CTA (hidden) em toda renderização", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.match(html, /id="jogar-subscribe-cta"/);
    assert.match(html, /diaria\.beehiiv\.com/);
    assert.match(html, /utm_source=eia-standalone/);
  });

  it("CTA não aparece renderizado/visível antes do voto — só o placeholder hidden (mesma disciplina anti-spoiler do result-slot)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: true });
    // O elemento existe mas com o atributo hidden — nunca sem ele.
    assert.match(html, /<div id="jogar-subscribe-cta" class="subscribe-cta" hidden>/);
  });

  it("script revela o CTA no caminho de voto NOVO (mesmo timing do share-card, #3517)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    // A revelação do CTA deve acontecer no mesmo bloco .then() que revela o resultSlot.
    const successBlock = /resultSlot\.innerHTML = out;[\s\S]*?subscribeCta\.hidden = false;/;
    assert.match(html, successBlock);
  });

  it("script revela o CTA no caminho de 'já votou' (repeat visitor também converte)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    const alreadyBlock = /alreadyBox\.textContent = [^;]+;\s*\n\s*if \(subscribeCta\) subscribeCta\.hidden = false;/;
    assert.match(html, alreadyBlock);
  });

  it("subscribeCta é lido via getElementById uma única vez, reusado nos dois caminhos (não duplica a query)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    const occurrences = html.match(/getElementById\("jogar-subscribe-cta"\)/g) ?? [];
    assert.equal(occurrences.length, 1, "getElementById(jogar-subscribe-cta) deve aparecer uma única vez no script");
  });
});

describe("regressão: CTA não quebra o fluxo de voto/share existente (#3516/#3517)", () => {
  it("form de voto continua apontando pro /vote com brand=web", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.match(html, /action="\/vote"/);
    assert.match(html, /name="brand"\s+value="web"/);
  });

  it("result-slot e share-card seguem intactos (extração via DOMParser não mudou)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.match(html, /<div id="jogar-result-slot" hidden><\/div>/);
    assert.match(html, /querySelector\("#jogar-share-card"\)/);
  });

  it("CTA vem DEPOIS do result-slot/already na ordem do DOM (share primeiro, conversão depois)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    const resultSlotIdx = html.indexOf('id="jogar-result-slot"');
    const ctaIdx = html.indexOf('id="jogar-subscribe-cta"');
    assert.ok(resultSlotIdx > -1 && ctaIdx > -1);
    assert.ok(ctaIdx > resultSlotIdx, "CTA deve vir depois do result-slot no HTML");
  });
});
