/**
 * test/sending-platform-credit-6195.test.ts (#6195)
 *
 * O que estes testes impedem: uma edição **enviada pelo Kit** afirmar que foi
 * enviada pela Beehiiv — e, pior, carregar o **link de afiliado da
 * concorrente** dentro da edição que a nova plataforma entregou.
 *
 * A degradação segura aqui é o texto NEUTRO ("enviei por e-mail"), nunca o
 * crédito errado: se o link de afiliado do Kit não estiver configurado, a
 * edição sai sem link nenhum — jamais com o link da Beehiiv.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aplicarCreditoKit,
  buildCreditoKit,
  CREDITO_BEEHIIV_MARKDOWN,
  CREDITO_NEUTRO,
} from "../scripts/lib/shared/sending-platform-credit.ts";

const ENCERRAR = `Nesta edição da **diar.ia.br**, usei Claude Code (...), dei o toque final e ${CREDITO_BEEHIIV_MARKDOWN}.`;

describe("#6195 buildCreditoKit — sem link configurado degrada pra neutro", () => {
  it("url vazia ⇒ texto neutro, SEM link", () => {
    for (const url of [undefined, "", "   "]) {
      const c = buildCreditoKit({ kitAffiliateUrl: url });
      assert.equal(c, CREDITO_NEUTRO);
      assert.doesNotMatch(c, /\]\(http/, "neutro não pode carregar link nenhum");
    }
  });

  it("url configurada ⇒ crédito do Kit com o link", () => {
    const c = buildCreditoKit({ kitAffiliateUrl: "https://partnerstack.example/kit", kitOfferText: "ganhe 50%" });
    assert.equal(c, "enviei via Kit ([ganhe 50%](https://partnerstack.example/kit))");
  });

  it("url sem copy de oferta usa um default, não string vazia", () => {
    const c = buildCreditoKit({ kitAffiliateUrl: "https://x.example" });
    assert.match(c, /\[.+\]\(https:\/\/x\.example\)/, "o rótulo do link não pode ficar vazio");
  });

  it("NUNCA menciona Beehiiv, em nenhuma configuração", () => {
    for (const opts of [{}, { kitAffiliateUrl: "https://x.example" }, { kitAffiliateUrl: "  " }]) {
      assert.doesNotMatch(buildCreditoKit(opts), /beehiiv/i);
    }
  });
});

describe("#6195 aplicarCreditoKit — a troca no markdown do 'Para encerrar'", () => {
  it("sem link: o crédito da Beehiiv SOME e vira neutro", () => {
    const r = aplicarCreditoKit(ENCERRAR);
    assert.equal(r.substituido, true);
    assert.doesNotMatch(r.markdown, /beehiiv/i, "nenhum vestígio da Beehiiv, nem o link de afiliado");
    assert.match(r.markdown, /enviei por e-mail/);
  });

  it("com link: vira crédito do Kit, e o link da Beehiiv some junto", () => {
    const r = aplicarCreditoKit(ENCERRAR, { kitAffiliateUrl: "https://k.example", kitOfferText: "oferta" });
    assert.equal(r.substituido, true);
    assert.doesNotMatch(r.markdown, /beehiiv\.com/);
    assert.match(r.markdown, /enviei via Kit \(\[oferta\]\(https:\/\/k\.example\)\)/);
  });

  it("preserva o resto do parágrafo — não é reescrita de copy", () => {
    const r = aplicarCreditoKit(ENCERRAR);
    assert.match(r.markdown, /Nesta edição da \*\*diar\.ia\.br\*\*/);
    assert.match(r.markdown, /dei o toque final e/);
    assert.match(r.markdown, /\.$/, "a pontuação final continua no lugar");
  });

  it("copy sem o trecho da Beehiiv ⇒ substituido:false, markdown INTOCADO", () => {
    // O caller loga isso. Não lançamos: crédito impreciso não justifica
    // derrubar a edição inteira.
    const outro = "Texto totalmente diferente, sem crédito de plataforma.";
    const r = aplicarCreditoKit(outro);
    assert.equal(r.substituido, false);
    assert.equal(r.markdown, outro);
  });

  it("IDEMPOTENTE: aplicar 2× não duplica nem corrompe", () => {
    const um = aplicarCreditoKit(ENCERRAR);
    const dois = aplicarCreditoKit(um.markdown);
    assert.equal(dois.substituido, false);
    assert.equal(dois.markdown, um.markdown);
    assert.equal((um.markdown.match(/enviei por e-mail/g) ?? []).length, 1);
  });

  it("REGRESSÃO: o trecho procurado inclui o LINK, não só a palavra 'Beehiiv'", () => {
    // Se a constante casasse só "enviei via Beehiiv", o link de afiliado
    // ficaria órfão no texto — o pior resultado possível: crédito trocado,
    // link da concorrente mantido.
    assert.match(CREDITO_BEEHIIV_MARKDOWN, /beehiiv\.com/);
    const r = aplicarCreditoKit(ENCERRAR);
    assert.doesNotMatch(r.markdown, /via=Diaria/, "o parâmetro de afiliado não pode sobreviver");
  });
});
