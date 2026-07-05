/**
 * test/force-cta-pill.test.ts (#2797, edição 260702)
 *
 * renderIntroCallout(forceCtaPill): o botão pill do último parágrafo CTA-only
 * (bg paper, borda bege, border-radius:999px, centralizado) só era gerado para
 * callouts patrocinados (📣, `sponsored`). O boxDivulgacao2 (🛒 — ex: box Alexa+)
 * reusa renderIntroCallout SEM o marcador 📣, então o CTA "Conhecer a Alexa+ e
 * ver as ofertas" renderizava como link inline, não botão. `forceCtaPill=true`
 * ativa o mesmo pill para callouts não-patrocinados, SEM adicionar o separador
 * "Divulgação".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderIntroCallout } from "../scripts/render-newsletter-html.ts";

// Callout multi-parágrafo cujo ÚLTIMO parágrafo é só um link CTA (sem marcador 📣).
const CALLOUT = `Equipe sua casa com a Alexa+

Estou testando a Alexa+ há alguns dias e a diferença é grande.

[Conhecer a Alexa+ e ver as ofertas](https://link.amazon/B0fmBTpob)`;

const PILL_RE = /border-radius:999px/;
const CENTERED_CTA_RE = /text-align:center;">[\s\S]*?border-radius:999px/;

describe("renderIntroCallout forceCtaPill (#2797)", () => {
  it("SEM forceCtaPill (não-patrocinado): CTA-only NÃO vira pill", () => {
    const html = renderIntroCallout(CALLOUT);
    assert.equal(
      PILL_RE.test(html),
      false,
      "sem forceCtaPill e sem 📣, o último link não deve virar botão pill",
    );
    // O link ainda aparece (inline), só não como pill centralizado.
    assert.match(html, /link\.amazon\/B0fmBTpob/);
  });

  it("COM forceCtaPill: último parágrafo CTA-only vira botão pill centralizado", () => {
    const html = renderIntroCallout(CALLOUT, "serif", true);
    assert.match(html, PILL_RE, "forceCtaPill deve gerar o botão pill (border-radius:999px)");
    assert.match(
      html,
      CENTERED_CTA_RE,
      "o pill deve estar num container centralizado (text-align:center)",
    );
    assert.match(html, /Conhecer a Alexa\+ e ver as ofertas<\/a>/);
    // O label do botão NÃO deve reaparecer como <p> de corpo (evita duplicação).
    assert.equal(
      (html.match(/Conhecer a Alexa\+ e ver as ofertas/g) || []).length,
      1,
      "o CTA deve aparecer uma única vez (como pill), não também no corpo",
    );
  });

  it("forceCtaPill preserva parágrafos de corpo anteriores ao CTA", () => {
    const html = renderIntroCallout(CALLOUT, "serif", true);
    assert.match(html, /Estou testando a Alexa\+ há alguns dias/);
    assert.match(html, /Equipe sua casa com a Alexa\+/);
  });

  // #2797 boundary: a prateleira de afiliados (boxDivulgacao2 260629-style) cujo
  // ÚLTIMO parágrafo é rotulado ("Fire TV: [link]") NÃO deve virar pill mesmo
  // com forceCtaPill=true — o rótulo torna o parágrafo não-CTA-only, então os
  // links seguem inline (comportamento documentado do boxDivulgacao2). Guarda contra
  // o forceCtaPill converter prateleiras rotuladas em botões.
  it("forceCtaPill NÃO vira pill quando o último parágrafo é rotulado (prateleira)", () => {
    const SHELF = `Equipe sua casa com a Alexa+. Veja os dispositivos:

Smart displays Echo: [Show 5](https://link.amazon/B0bSeNbs9) · [Show 8](https://link.amazon/B00RlxPou)

Fire TV: [Stick HD](https://link.amazon/B0hs12yXc)`;
    const html = renderIntroCallout(SHELF, "serif", true);
    assert.equal(PILL_RE.test(html), false, "prateleira rotulada não deve virar pill");
    // Todos os 3 links seguem presentes (inline), nenhum perdido.
    for (const key of ["B0bSeNbs9", "B00RlxPou", "B0hs12yXc"]) {
      assert.match(html, new RegExp(key), `link ${key} deve seguir inline`);
    }
  });
});
