/**
 * test/midcallout-multi-cta.test.ts (edição 260622)
 *
 * Box do meio (📣) com MÚLTIPLOS CTAs — ex: "Explore Livros e Cursos" com dois
 * botões clicáveis (Livros + Cursos). Antes, o renderIntroCallout só extraía o
 * 1º link como botão e descartava o resto; e qualquer box linkando
 * livros.diaria.workers.dev virava o "box de livros" (screenshot + 1 CTA),
 * derrubando o link de Cursos. Pedido do editor 260622.
 *
 * #3232: chamadas passam `forceCtaPill=true` explicitamente — espelha a
 * chamada REAL de produção pra este conteúdo. `renderBoxDivulgacao`
 * (newsletter-render-html.ts) é quem de fato invoca `renderIntroCallout` pro
 * box do meio, e decide `forceCtaPill` via `shouldForceCtaPill` (sinal
 * ESTRUTURAL — 2+ links ou último parágrafo CTA-only — não pelo marcador
 * 📣). Antes deste PR, chamar `renderIntroCallout` sem `forceCtaPill`
 * "funcionava" só porque `isSponsoredCallout` (testado internamente via
 * `sponsored`) casava com o 📣 do fixture — um acoplamento acidental que
 * mascarava o call-path real. Com `isSponsoredCallout` agora marcador-
 * agnóstico (detecta por link de afiliado `?via=`/`tag=`, #3232), os fixtures
 * abaixo (sem link de afiliado) deixaram de ser "sponsored" — e é exatamente
 * por isso que a chamada precisa refletir o dispatcher real em vez de
 * depender do acoplamento antigo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderIntroCallout } from "../scripts/render-newsletter-html.ts";
import { isBoxDivulgacaoLivros } from "../scripts/lib/newsletter-parse.ts";

const TWO_CTA = `📣 Explore as seções de Livros e Cursos da Diar.ia

Além da edição diária, a gente mantém livros e cursos sobre IA.

→ [Livros sobre IA](https://livros.diaria.workers.dev) · [Cursos de IA](https://cursos.diaria.workers.dev)`;

const ONE_CTA = `📣 Promo

Corpo da promo.

→ [Acesse a oferta](https://example.com/oferta)`;

describe("renderIntroCallout — múltiplos CTAs (260622)", () => {
  it("renderiza um botão pill por link quando o último parágrafo é só CTAs", () => {
    const html = renderIntroCallout(TWO_CTA, "serif", true);
    // Ambos os links viram botões clicáveis.
    assert.ok(
      html.includes('href="https://livros.diaria.workers.dev"'),
      "link de Livros deve estar presente",
    );
    assert.ok(
      html.includes('href="https://cursos.diaria.workers.dev"'),
      "link de Cursos deve estar presente (não pode ser descartado)",
    );
    // Dois <a> de botão (border-radius:999px = pill style).
    const pills = (html.match(/border-radius:999px/g) ?? []).length;
    assert.equal(pills, 2, "deve haver exatamente 2 botões pill");
    // O separador "·" não deve sobrar como texto no corpo.
    assert.ok(!/>\s*·\s*</.test(html), "separador · não deve virar texto órfão");
    // Os labels dos botões.
    assert.ok(html.includes(">Livros sobre IA</a>"));
    assert.ok(html.includes(">Cursos de IA</a>"));
  });

  it("mantém o comportamento de 1 CTA único (regressão)", () => {
    const html = renderIntroCallout(ONE_CTA, "serif", true);
    const pills = (html.match(/border-radius:999px/g) ?? []).length;
    assert.equal(pills, 1, "1 link → 1 botão");
    assert.ok(html.includes('href="https://example.com/oferta"'));
    assert.ok(html.includes(">Acesse a oferta</a>"));
  });
});

describe("isBoxDivulgacaoLivros — box combinado não dispara screenshot (260622)", () => {
  it("retorna false quando o box também linka Cursos (box de seções)", () => {
    assert.equal(isBoxDivulgacaoLivros(TWO_CTA), false);
  });

  it("retorna true para box só de livros (promo da página de livros)", () => {
    const livrosOnly = `📚 Confira a seção de Livros

→ [Livros sobre IA](https://livros.diaria.workers.dev)`;
    assert.equal(isBoxDivulgacaoLivros(livrosOnly), true);
  });

  it("retorna false para box CLARICE (sem link de livros)", () => {
    const clarice = `📣 Escreva melhor com a Clarice

→ [Cupons](https://clarice.ai/precos-planos?via=diaria)`;
    assert.equal(isBoxDivulgacaoLivros(clarice), false);
  });
});
