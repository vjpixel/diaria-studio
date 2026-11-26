/**
 * test/clarice-review-credit-ponto-13718.test.ts (#13718)
 *
 * Regressão: `CLARICE_REVIEW_CREDIT_RE` não atravessava ponto dentro da frase.
 * "Na diar.ia.br, a revisão foi feita pela Clarice (...)" não casava: com o
 * marcador `02-clarice-pending.json` ativo a frase falsa seguia no render e
 * `hasClariceReviewCredit` não avisava no gate 4. Cobre também a variante
 * "revisado/revisada pela Clarice".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { hasClariceReviewCredit, omitClariceReviewCredit } from "../scripts/lib/diaria/clarice-review-credit.ts";

const LINK = "([ganhe descontos com os cupons NEWS25 e NEWS50](https://clarice.ai/precos-planos?via=diaria))";

describe("#13718 frase com outro ponto antes de 'revisão'", () => {
  it("marca pontuada (diar.ia.br) na mesma frase: detecta e omite a frase inteira", () => {
    const md = `Usei Claude Code. Na diar.ia.br, a revisão foi feita pela Clarice ${LINK}.\n\nOutro parágrafo.`;
    assert.equal(hasClariceReviewCredit(md), true);
    const r = omitClariceReviewCredit(md);
    assert.equal(r.omitido, true);
    assert.equal(r.markdown, "Usei Claude Code.\n\nOutro parágrafo.");
  });

  it("marca em negrito no início do parágrafo, frase continua depois da oração", () => {
    const md = `Na **diar.ia.br**, a revisão foi feita pelo MCP da Clarice ${LINK}, dei o toque final e enviei via Kit.`;
    const r = omitClariceReviewCredit(md);
    assert.equal(r.omitido, true);
    assert.equal(r.markdown, "Dei o toque final e enviei via Kit.");
  });

  it("ponto entre 'revisão' e 'Clarice' (domínio citado) também casa", () => {
    const md = `A revisão do texto da diar.ia.br foi feita pela Clarice ${LINK}.`;
    assert.equal(hasClariceReviewCredit(md), true);
    assert.equal(omitClariceReviewCredit(md).markdown, "");
  });

  it("variante 'revisado/revisada pela Clarice'", () => {
    const a = `Usei Claude Code. Tudo foi revisado pela Clarice ${LINK}. Enviei por e-mail.`;
    assert.equal(omitClariceReviewCredit(a).markdown, "Usei Claude Code. Enviei por e-mail.");
    const b = `Usei Claude Code. A edição foi revisada pela Clarice ${LINK}.`;
    assert.equal(omitClariceReviewCredit(b).markdown, "Usei Claude Code.");
  });

  it("fim de frase real (ponto + espaço) continua sendo fronteira: frase anterior intacta", () => {
    const md = `Visite diar.ia.br. A revisão foi feita pela Clarice ${LINK}.`;
    assert.equal(omitClariceReviewCredit(md).markdown, "Visite diar.ia.br.");
  });

  it("'revisão' numa frase e a Clarice com link na frase seguinte: não casa", () => {
    const md = `A revisão ficou para amanhã. Corrija seus textos com a Clarice ${LINK}.`;
    assert.equal(hasClariceReviewCredit(md), false);
    assert.equal(omitClariceReviewCredit(md).omitido, false);
  });
});
