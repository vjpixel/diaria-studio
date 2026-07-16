/**
 * test/poll-jogar-quiz-cta-3579.test.ts (#3579)
 *
 * CTA de assinatura no quiz relâmpago (`/jogar/quiz`, #3520) — enhancement de
 * divulgação pedido pelo editor (review 260716). Diferente do CTA genérico
 * pós-voto de par único (`renderSubscribeCtaBlock`/`buildSubscribeUrl`,
 * #3518), o CTA do quiz:
 *   - enquadra as imagens jogadas como o arquivo de edições passadas da
 *     Diar.ia (o quiz sorteia pares de várias edições fechadas, #3520);
 *   - usa copy própria (texto do editor: "notícias de IA + tutoriais...
 *     assine a Diar.ia (grátis)");
 *   - usa UTM PRÓPRIO (`utm_medium=quiz`, `utm_campaign=eia-quiz-posvoto`) —
 *     distinto do funil de par único (`utm_medium=jogar`), pra medir os dois
 *     funis separadamente (mesma disciplina do #3524/#3521/#3518).
 *
 * Também cobre regressão: o CTA genérico do `/jogar` (par único) não muda —
 * `renderJogarPageHtml` continua usando `renderSubscribeCtaBlock`/
 * `buildSubscribeUrl` (#3518), intocados por esta issue.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQuizSubscribeUrl,
  buildSubscribeUrl,
  QUIZ_SUBSCRIBE_UTM_CAMPAIGN,
  QUIZ_SUBSCRIBE_UTM_MEDIUM,
  QUIZ_SUBSCRIBE_UTM_SOURCE,
  renderJogarPageHtml,
  renderJogarQuizPageHtml,
  renderQuizSubscribeCtaBlock,
  SUBSCRIBE_UTM_MEDIUM,
} from "../workers/poll/src/jogar.ts";

describe("buildQuizSubscribeUrl (#3579) — URL de assinatura com UTM próprio do quiz", () => {
  it("usa diaria.beehiiv.com DIRETO — mesmo destino do CTA de par único (#2613/#3518)", () => {
    const url = buildQuizSubscribeUrl();
    assert.match(url, /^https:\/\/diaria\.beehiiv\.com\/\?/);
    assert.doesNotMatch(url, /diar\.ia\.br/);
  });

  it("carrega utm_source/utm_medium/utm_campaign do funil do quiz", () => {
    const url = buildQuizSubscribeUrl();
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("utm_source"), QUIZ_SUBSCRIBE_UTM_SOURCE);
    assert.equal(parsed.searchParams.get("utm_medium"), QUIZ_SUBSCRIBE_UTM_MEDIUM);
    assert.equal(parsed.searchParams.get("utm_campaign"), QUIZ_SUBSCRIBE_UTM_CAMPAIGN);
  });

  it("utm_medium='quiz' — DISTINTO do CTA de par único ('jogar'), funil mensurado separadamente", () => {
    assert.equal(QUIZ_SUBSCRIBE_UTM_MEDIUM, "quiz");
    assert.notEqual(QUIZ_SUBSCRIBE_UTM_MEDIUM, SUBSCRIBE_UTM_MEDIUM);
  });

  it("utm_source continua 'eia-standalone' — mesma convenção de count-subscriptions-by-utm.ts", () => {
    assert.equal(QUIZ_SUBSCRIBE_UTM_SOURCE, "eia-standalone");
  });

  it("determinística — mesma URL em chamadas repetidas", () => {
    assert.equal(buildQuizSubscribeUrl(), buildQuizSubscribeUrl());
  });

  it("URL do quiz é diferente da URL do CTA de par único (UTMs distintos)", () => {
    assert.notEqual(buildQuizSubscribeUrl(), buildSubscribeUrl());
  });
});

describe("renderQuizSubscribeCtaBlock (#3579) — bloco HTML do CTA do quiz", () => {
  it("contém id=jogar-subscribe-cta, hidden por padrão (mesma mecânica anti-spoiler do #3518)", () => {
    const html = renderQuizSubscribeCtaBlock();
    assert.match(html, /<div id="jogar-subscribe-cta" class="subscribe-cta" hidden>/);
  });

  it("link aponta pra buildQuizSubscribeUrl() com os UTMs do quiz (& escapado como &amp; em atributo HTML)", () => {
    const html = renderQuizSubscribeCtaBlock();
    const url = buildQuizSubscribeUrl();
    const escapedHref = url.replace(/&/g, "&amp;");
    assert.match(html, new RegExp(`href="${escapedHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  });

  it("abre em nova aba (target=_blank) — mesma disciplina do CTA de par único", () => {
    const html = renderQuizSubscribeCtaBlock();
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener"/);
  });

  it("copy enquadra as imagens como o arquivo de edições passadas da Diar.ia", () => {
    const html = renderQuizSubscribeCtaBlock();
    assert.match(html, /arquivo de edições passadas/i);
  });

  it("copy convida à assinatura mencionando notícias de IA + tutoriais + par diário + grátis", () => {
    const html = renderQuizSubscribeCtaBlock();
    assert.match(html, /notícias de IA/i);
    assert.match(html, /tutoriais/i);
    assert.match(html, /todo dia/i);
    assert.match(html, /grátis/i);
  });

  it("botão convida a assinar a Diar.ia", () => {
    const html = renderQuizSubscribeCtaBlock();
    assert.match(html, /Assinar a Diar\.ia/);
  });
});

describe("renderJogarQuizPageHtml embute o CTA específico do quiz, não o genérico (#3579)", () => {
  it("página do quiz usa renderQuizSubscribeCtaBlock (copy do arquivo), não a copy genérica do #3518", () => {
    const html = renderJogarQuizPageHtml(["260101", "260201"]);
    assert.match(html, /arquivo de edições passadas/i);
    assert.doesNotMatch(html, /Um par novo desses todo dia/, "não deve usar a copy genérica do CTA de par único");
  });

  it("UTM embutido é o do quiz (utm_medium=quiz), não o de par único (utm_medium=jogar)", () => {
    const html = renderJogarQuizPageHtml(["260101"]);
    assert.match(html, /utm_medium=quiz/);
    assert.doesNotMatch(html, /utm_medium=jogar/);
  });

  it("CTA continua hidden por padrão — nunca aparece antes do fim do quiz (anti-spoiler preservado, #3520)", () => {
    const html = renderJogarQuizPageHtml(["260101"]);
    assert.match(html, /<div id="jogar-subscribe-cta" class="subscribe-cta" hidden>/);
  });

  it("script revela o CTA em showFinal() — mesma mecânica já existente, sem mudança necessária no JS", () => {
    const html = renderJogarQuizPageHtml(["260101", "260201"]);
    const showFinalBlock = /function showFinal\(\)[\s\S]*?if \(subscribeCta\) subscribeCta\.hidden = false;/;
    assert.match(html, showFinalBlock);
  });

  it("lista vazia (sem edições fechadas suficientes): não renderiza CTA (nem o genérico nem o do quiz) — estado vazio amigável", () => {
    const html = renderJogarQuizPageHtml([]);
    assert.doesNotMatch(html, /id="jogar-subscribe-cta"/);
  });
});

describe("regressão: CTA de par único (/jogar) continua com a copy e UTM genéricos do #3518 (#3579 não altera)", () => {
  it("renderJogarPageHtml continua usando utm_medium=jogar, não utm_medium=quiz", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.match(html, /utm_medium=jogar/);
    assert.doesNotMatch(html, /utm_medium=quiz/);
  });

  it("renderJogarPageHtml não enquadra como 'arquivo' — copy genérica intacta", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.doesNotMatch(html, /arquivo de edições passadas/i);
    assert.match(html, /Um par novo desses todo dia/);
  });
});
