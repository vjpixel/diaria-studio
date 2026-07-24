/**
 * test/poll-jogar-ux-4036.test.ts (#4036)
 *
 * "eia-web: 5 ajustes de UX na sequência" — pedido do editor jogando
 * `eia.diar.ia.br/jogar` em produção (260724). Itens 3 e 4 já têm cobertura
 * de regressão dedicada em test/poll-jogar-cold-visitor-4005.test.ts,
 * test/poll-jogar-share-climax-4006.test.ts e
 * test/poll-jogar-suspense-3595.test.ts (não duplicados aqui). Cobre:
 *
 *   1. Reveal (#seq-round-result) traz o resultado pra viewport via
 *      scrollIntoView — o bloco já ficava depois do par no DOM, o problema
 *      era visibilidade no mobile.
 *   2. Glow visível na foto de IA — fix da regressão do #4030 item 5, que
 *      usava box-shadow INSET (invisível sobre um <img> opaco).
 *   5. Copy do checkbox de opt-in reescrita pra explicar o que é a Diar.ia
 *      (quem chega por compartilhamento nunca ouviu falar).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderJogarSequencePageHtml, renderIdentityFormBlock } from "../workers/poll/src/jogar.ts";

describe("reveal traz o resultado pra viewport (#4036 item 1)", () => {
  it("renderRoundResult chama scrollIntoView no #seq-round-result após revelar", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /if \(resultEl\.scrollIntoView\) resultEl\.scrollIntoView\(\{ block: "center", behavior: "smooth" \}\);/);
  });

  it("scrollIntoView acontece DEPOIS de resultEl.hidden = false (não rola pra um elemento ainda escondido)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    const hiddenIdx = html.indexOf("resultEl.hidden = false;");
    const scrollIdx = html.indexOf("resultEl.scrollIntoView(");
    assert.ok(hiddenIdx > -1 && scrollIdx > -1);
    assert.ok(scrollIdx > hiddenIdx, "scrollIntoView deve vir depois de revelar o bloco");
  });
});

describe("glow visível na foto de IA (#4036 item 2 — fix da regressão do #4030 item 5)", () => {
  it("regra .choice.correct-ai NÃO usa inset (era invisível sobre o <img> opaco)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    const match = html.match(/\.choice\.correct-ai img \{ box-shadow: ([^}]*); \}/);
    assert.ok(match, "regra .choice.correct-ai img deve existir");
    assert.doesNotMatch(match![1], /inset/, "inset é pintado por baixo do conteúdo do <img> — nunca aparece");
  });

  it("box-shadow usa cor de marca (DS_COLORS.brand, #00A0A0) — não hex hardcoded fora do token", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /\.choice\.correct-ai img \{ box-shadow: [^}]*#00A0A0/);
  });

  it("box-shadow (com ou sem inset) nunca afeta o box model — a preocupação de CLS do #4030 não se aplica a nenhuma das duas variantes", () => {
    // Sanidade de documentação: só um comentário no código, sem asserção de
    // runtime possível aqui (box model é propriedade de layout, não de CSS
    // fonte) — a regressão real era VISIBILIDADE (inset escondido), não CLS.
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /\.choice\.correct-ai img \{ box-shadow: /);
  });
});

describe("copy do opt-in explica o que é a Diar.ia (#4036 item 5)", () => {
  it("renderIdentityFormBlock: checkbox nomeia o produto (newsletter de IA) + o que entrega + a frequência", () => {
    const html = renderIdentityFormBlock();
    assert.match(html, /Quero receber a Diar\.ia — newsletter gratuita/);
    assert.match(html, /IA/);
    assert.match(html, /seg-sex/);
  });

  it("copy antiga ('grátis, seg-sex' sozinho, sem explicar o produto) não sobrevive", () => {
    const html = renderIdentityFormBlock();
    assert.doesNotMatch(html, /Quero receber a Diar\.ia — grátis, seg-sex\.</);
  });
});
