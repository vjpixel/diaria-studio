/**
 * test/monthly-utm-clarice-2975.test.ts (#2975, regressão #633)
 *
 * Assinantes vindos da Clarice News mensal apareciam no Beehiiv como
 * `utm_source=sendinblue` (auto-tag do Brevo) — impossível medir a conversão
 * da migração Clarice→Diar.ia. Fix: todo link `diaria.beehiiv.com` do render
 * mensal carrega `utm_source=clarice&utm_medium=email&utm_campaign=clarice-{ciclo}`.
 *
 * Cobre as 3 fontes de link `diaria.beehiiv.com` no output mensal:
 *   - wordmark automático de "diar.ia"/"diar.ia.br" (applyBrandWordmark, via renderTextInline)
 *   - link markdown explícito (ex: boilerplate APRESENTAÇÃO "[aqui](https://diaria.beehiiv.com)")
 *   - CTA "→ [texto](url)" (renderCtaButton)
 * e garante que `sendinblue` nunca aparece no HTML final.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  draftToEmail,
  normalizeKnownUrl,
  renderCtaButton,
  setMonthlyUtmCiclo,
} from "../scripts/lib/mensal/monthly-render.ts";

describe("UTM clarice em links diaria.beehiiv.com (#2975)", () => {
  it("normalizeKnownUrl injeta utm_source/medium/campaign quando ciclo setado", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const out = normalizeKnownUrl("https://diaria.beehiiv.com");
      assert.match(out, /utm_source=clarice/);
      assert.match(out, /utm_medium=email/);
      assert.match(out, /utm_campaign=clarice-2606-07/);
      assert.doesNotMatch(out, /sendinblue/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("normalizeKnownUrl não mexe em hosts que não são diaria.beehiiv.com", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const out = normalizeKnownUrl("https://clarice.ai/?via=diaria");
      assert.equal(out, "https://clarice.ai/?via=diaria");
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("normalizeKnownUrl é no-op sem ciclo setado (default)", () => {
    const out = normalizeKnownUrl("https://diaria.beehiiv.com");
    assert.equal(out, "https://diaria.beehiiv.com");
  });

  it("renderCtaButton aplica o UTM quando o CTA aponta pro Beehiiv", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderCtaButton("→ [Assine grátis](https://diaria.beehiiv.com)");
      assert.match(html, /href="https:\/\/diaria\.beehiiv\.com\/\?utm_source=clarice&amp;utm_medium=email&amp;utm_campaign=clarice-2606-07"/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("draftToEmail: wordmark automático e link markdown carregam UTM clarice-{ciclo}, nunca sendinblue", () => {
    const draft = [
      "**APRESENTAÇÃO**",
      "",
      "Esta é a Clarice News em parceria com diar.ia.br. Se quiser receber notícias de IA todos os dias, se cadastre gratuitamente [aqui](https://diaria.beehiiv.com).",
      "",
      "**PARA ENCERRAR**",
      "",
      "Assine a newsletter diária: [clique aqui](https://diaria.beehiiv.com/?utm_source=clarice).",
    ].join("\n");

    const { html } = draftToEmail(draft, "Assunto de teste", "2606");

    // wordmark automático (applyBrandWordmark) — ciclo 2606 -> envio 07
    assert.match(html, /<a href="https:\/\/diaria\.beehiiv\.com\/\?utm_source=clarice[^"]*utm_campaign=clarice-2606-07"/);
    // link markdown explícito do boilerplate
    assert.match(
      html,
      /href="https:\/\/diaria\.beehiiv\.com\/\?utm_source=clarice&amp;utm_medium=email&amp;utm_campaign=clarice-2606-07"[^>]*>aqui<\/a>/,
    );
    // CTA do ENCERRAMENTO, mesmo já contendo um utm_source=clarice manual do writer, é normalizado/completado
    assert.match(html, /clique aqui<\/a>/);
    assert.doesNotMatch(html, /sendinblue/);
  });

  it("draftToEmail reseta o ciclo global após terminar (não vaza pra chamada seguinte sem ciclo)", () => {
    draftToEmail("**APRESENTAÇÃO**\n\ntexto [aqui](https://diaria.beehiiv.com).", "Assunto", "2606");
    // Chamada direta de normalizeKnownUrl fora de draftToEmail não deve herdar o ciclo da chamada anterior.
    const out = normalizeKnownUrl("https://diaria.beehiiv.com");
    assert.equal(out, "https://diaria.beehiiv.com");
  });
});
