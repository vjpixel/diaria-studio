/**
 * test/monthly-body-font.test.ts (#2599)
 *
 * Garante que os <p> de CORPO do render mensal declaram font-family
 * explicitamente (sans Geist — alinhado ao diário e ao design system canônico:
 * corpo = sans, títulos = serif). É robustez para clientes de e-mail (Outlook /
 * Word engine) que NÃO herdam font-family de bloco-pai (<td>) para <p>.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderParagraphs,
  renderIntro,
  renderDestaque,
} from "../scripts/lib/monthly-render.ts";

/** Falha se algum <p style="margin:..."> (corpo) não declarar font-family. */
function assertBodyParasHaveFont(html: string, ctx: string): void {
  const bodyParas = html.match(/<p style="margin:[^"]*">/g) ?? [];
  assert.ok(bodyParas.length > 0, `${ctx}: esperava ao menos 1 <p> de corpo`);
  for (const p of bodyParas) {
    assert.ok(p.includes("font-family:"), `${ctx}: <p> de corpo sem font-family -> ${p}`);
  }
}

describe("#2599: <p> de corpo do mensal declaram font-family (robustez Outlook)", () => {
  it("renderParagraphs", () => {
    const html = renderParagraphs("Primeiro parágrafo de corpo.\n\nSegundo parágrafo de corpo.");
    assertBodyParasHaveFont(html, "renderParagraphs");
  });

  it("renderIntro", () => {
    const html = renderIntro("Texto de introdução do digest mensal.");
    assertBodyParasHaveFont(html, "renderIntro");
  });

  it("renderDestaque (corpo + fio condutor)", () => {
    const chunk =
      "Título do destaque\n\nParágrafo de corpo um.\n\nParágrafo de corpo dois.\n\nFio condutor final.";
    const html = renderDestaque(chunk);
    assertBodyParasHaveFont(html, "renderDestaque");
  });
});
