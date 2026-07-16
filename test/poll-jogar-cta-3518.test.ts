/**
 * test/poll-jogar-cta-3518.test.ts (#3518, rework #3589)
 *
 * CTA pós-voto + funil UTM do "É IA?" standalone (conversão do EPIC #3514).
 * Construído sobre a fundação do #3516 (`/jogar`, brand `web`) e o share
 * card do #3517 (`#jogar-result-slot`). Cobre:
 *   - `buildSubscribeUrl` (pure) — usa `diaria.beehiiv.com` DIRETO (não
 *     `diar.ia.br`, #2613) com os 3 parâmetros UTM do funil. Continua
 *     existindo pós-#3589 — usado por `subscribe.ts` (utm_source do form
 *     inline #3580) e por `renderArchiveSubscribeReinforcement` (arquivo,
 *     #3524) — só NÃO é mais usado dentro de `renderSubscribeCtaBlock`.
 *   - `renderSubscribeCtaBlock` (pure, REWORK #3589) — deixou de ser o CTA
 *     de assinatura ("empurra Beehiiv") e virou a caixa de DESCOBERTA
 *     (convida a conhecer o projeto, link pro site diar.ia.br) — decisão do
 *     editor (review 260716, #3589 item 4): assinatura real já é o form
 *     inline (#3580).
 *   - `renderJogarPageHtml` — o bloco aparece na página (hidden), o script
 *     revela o CTA tanto no caminho de voto novo quanto no de "já votou",
 *     nunca antes do voto
 *   - regressão: não quebra o fluxo de voto/share existente (#3516/#3517)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BRAND_INFO,
} from "../workers/poll/src/lib.ts";
import {
  buildSubscribeUrl,
  renderJogarPageHtml,
  renderSubscribeCtaBlock,
  SUBSCRIBE_UTM_CAMPAIGN,
  SUBSCRIBE_UTM_MEDIUM,
  SUBSCRIBE_UTM_SOURCE,
} from "../workers/poll/src/jogar.ts";

describe("buildSubscribeUrl (#3518) — URL de assinatura com UTM do funil (segue viva pós-#3589, ver header)", () => {
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

  it("utm_source é 'eia-standalone' — mesma convenção de medição de count-subscriptions-by-utm.ts (utm_source=clarice pra Clarice); subscribe.ts (#3580) reusa esta constante pro form inline", () => {
    assert.equal(SUBSCRIBE_UTM_SOURCE, "eia-standalone");
  });

  it("determinística — mesma URL em chamadas repetidas (sem variante A/B, decisão conservadora)", () => {
    assert.equal(buildSubscribeUrl(), buildSubscribeUrl());
  });
});

describe("renderSubscribeCtaBlock (rework #3589 do #3518) — caixa de DESCOBERTA, não mais de assinatura", () => {
  it("contém id=jogar-subscribe-cta, hidden por padrão (nunca antes do voto) — mesmo id/mecânica de sempre", () => {
    const html = renderSubscribeCtaBlock();
    assert.match(html, /<div id="jogar-subscribe-cta" class="subscribe-cta" hidden>/);
  });

  it("link aponta pro SITE (BRAND_INFO.web.siteUrl), NÃO pro subscribe do Beehiiv (#3589 item 4)", () => {
    const html = renderSubscribeCtaBlock();
    assert.match(html, new RegExp(`href="${BRAND_INFO.web.siteUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.doesNotMatch(html, /diaria\.beehiiv\.com/, "não deve mais linkar direto pro Beehiiv — essa é a caixa de descoberta");
    assert.doesNotMatch(html, /utm_source=eia-standalone/, "sem UTM do funil de assinatura — não é mais um CTA de conversão Beehiiv");
  });

  it("abre em nova aba (target=_blank) — não perde o estado do jogo ao navegar pro site", () => {
    const html = renderSubscribeCtaBlock();
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener"/);
  });

  it("copy convida a CONHECER o projeto — não empurra mais assinatura/Grátis (#3589 item 4)", () => {
    const html = renderSubscribeCtaBlock();
    assert.match(html, /Conhe(ç|c)a a Diar\.ia|Conhecer a Diar\.ia/i);
    assert.doesNotMatch(html, /Assinar a Diar\.ia/i, "assinatura é responsabilidade do form inline #3580, não desta caixa");
  });
});

describe("GET /jogar (par único via ?edition=) embute a caixa de descoberta hidden (#3518/#3589)", () => {
  it("renderJogarPageHtml inclui o bloco (hidden) em toda renderização, com o novo link de descoberta", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.match(html, /id="jogar-subscribe-cta"/);
    assert.match(html, new RegExp(BRAND_INFO.web.siteUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
