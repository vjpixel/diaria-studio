/**
 * test/email-components.test.ts (#3269)
 *
 * `tealDot()` foi extraído de scripts/lib/newsletter-render-html.ts pra
 * scripts/lib/shared/email-components.ts — o 1º componente HTML genuinamente
 * compartilhado entre os renderers diário e mensal (era um import cruzado
 * ad-hoc, ver docs/render-unification-analysis-3269.md). Este teste trava:
 *   1. o output do helper compartilhado em si;
 *   2. que os 2 renderers (import direto vs. re-export de back-compat)
 *      resolvem pro MESMO módulo — nenhum dos dois voltou a duplicar a string.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tealDot as sharedTealDot } from "../scripts/lib/shared/email-components.ts";
import { tealDot as diariaTealDot } from "../scripts/lib/newsletter-render-html.ts";
import { renderKicker as monthlyRenderKicker } from "../scripts/lib/mensal/monthly-render.ts";

describe("tealDot (#3269 — shared/email-components.ts)", () => {
  it("emite o ponto ● em teal (#00A0A0), sem outro conteúdo", () => {
    assert.equal(sharedTealDot(), '<span style="color:#00A0A0;">&#9679;</span>');
  });

  it("newsletter-render-html.ts re-exporta o MESMO helper (back-compat, não uma cópia)", () => {
    assert.equal(diariaTealDot, sharedTealDot);
  });

  it("monthly-render.ts consome o helper compartilhado — o kicker mensal contém o mesmo span", () => {
    const html = monthlyRenderKicker("RADAR");
    assert.match(html, /<span style="color:#00A0A0;">&#9679;<\/span>&nbsp;RADAR/);
  });
});
