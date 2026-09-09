/**
 * test/artigo-mensal-copy-limiar-7690.test.ts (#7690)
 *
 * Trava as TRÊS superfícies de copy do gate da Retrospectiva do Mês contra o
 * limiar que de fato monta a allowlist (`RETROSPECTIVA_DO_MES_NIVEIS`).
 *
 * Por que existe: a #7658 corrigiu o limiar de R$10+ para R$25+ e atualizou o
 * form e o paywall seco — mas passou batido o bloco de conversão do TRECHO
 * (`renderTeaserWithPaywall`), que é justamente a página que o leitor deslogado
 * vê. Resultado, ao vivo em 08/09/2026 depois do push da allowlist: quem apoia
 * com R$10 lia "Apoiadores de R$10/mês ou mais leem o artigo completo" na
 * mesma página que acabava de negar o acesso a ele.
 *
 * O modo de falha é sempre esse — mudar o limiar em um lugar e a copy em
 * outro. Um teste que casa NÚMERO na copy contra o limiar real é o que fecha:
 * mexer na constante sem mexer no texto quebra aqui.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderEmailForm,
  renderPaywall,
  renderTeaserWithPaywall,
} from "../workers/artigo-mensal/src/render.ts";
import { RETROSPECTIVA_DO_MES_NIVEIS } from "../scripts/build-apoiador-allowlist.ts";

/**
 * Valor em R$ do menor nível que hoje tem direito — derivado das faixas
 * canônicas (`computeRewardGroup`, documentadas em
 * `scripts/lib/apoio-segments-canonical-kit.ts`), não digitado à mão: é o que
 * amarra a copy à constante em vez de a outro literal.
 */
const PISO_POR_NIVEL: Record<string, number> = { amigo: 5, apoiador: 10, mantenedor: 25, patrono: 50 };
const PISO = Math.min(...RETROSPECTIVA_DO_MES_NIVEIS.map((n) => PISO_POR_NIVEL[n]));

const TEASER = `<html><body><h1>Retrospectiva</h1><p>trecho</p></body></html>`;

/** Normaliza entidades e nbsp pra casar número independente de como foi escrito. */
function texto(html: string): string {
  return html
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&ecirc;/g, "ê")
    .replace(/&ccedil;/g, "ç")
    .replace(/&otilde;/g, "õ")
    .replace(/\s+/g, " ");
}

const SUPERFICIES: Array<[string, () => string]> = [
  ["form de e-mail", () => renderEmailForm("2608-09")],
  ["paywall seco", () => renderPaywall()],
  ["bloco de conversão do trecho", () => renderTeaserWithPaywall(TEASER)],
];

describe("#7690 — a copy do gate cita o limiar REAL, nas 3 superfícies", () => {
  it("o piso derivado da constante é R$25 hoje (Mantenedor)", () => {
    assert.equal(PISO, 25);
  });

  for (const [nome, render] of SUPERFICIES) {
    it(`${nome}: cita R$${PISO} e NUNCA um valor menor`, () => {
      const t = texto(render());
      assert.match(t, new RegExp(String.raw`R\$\s?${PISO}`), `não cita R$${PISO}`);

      // O ponto do teste: nenhum valor ABAIXO do piso pode aparecer como
      // promessa de acesso. Citar R$10 numa página que nega a R$10 é pior que
      // não citar valor nenhum.
      for (const menor of Object.values(PISO_POR_NIVEL).filter((v) => v < PISO)) {
        assert.doesNotMatch(t, new RegExp(String.raw`R\$\s?${menor}\b`), `cita R$${menor}, abaixo do limiar real`);
      }
    });
  }
});
