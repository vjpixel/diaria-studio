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
import { computeRewardGroup } from "../scripts/studio-ui/studio-apoios.ts";

/**
 * Pisos em R$ de cada nível, SONDADOS de `computeRewardGroup` — a mesma
 * função que decide o nível de cada apoiador a partir do valor pago.
 *
 * Sondar em vez de transcrever um mapa à mão é o que fecha o último literal
 * do teste (achado do review da #7690): um mapa transcrito continuaria
 * "passando" se as faixas de `REWARD_TIER_*_MIN` mudassem, validando a copy
 * contra números que já não valem. Aqui, mexer nas faixas move o piso
 * automaticamente — e a copy tem que acompanhar.
 *
 * A varredura vai a R$200 porque o maior piso hoje é R$50; um piso novo
 * acima disso apareceria como nível sem entrada no mapa, e o `PISO` abaixo
 * quebraria em vez de silenciar.
 */
const PISO_POR_NIVEL: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (let v = 1; v <= 200; v++) {
    const nivel = computeRewardGroup(v);
    if (nivel && !(nivel in out)) out[nivel] = v;
  }
  return out;
})();

const PISO = Math.min(
  ...RETROSPECTIVA_DO_MES_NIVEIS.map((n) => {
    const piso = PISO_POR_NIVEL[n];
    if (piso === undefined) throw new Error(`nível "${n}" sem piso sondado — a varredura precisa ir além de R$200.`);
    return piso;
  }),
);

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
