/**
 * test/monthly-render-extracted.test.ts (#1844)
 *
 * Guarda a extração da camada de render de publish-monthly.ts pro módulo
 * scripts/lib/monthly-render.ts: (a) módulo auto-contido importável direto,
 * (b) o re-export de back-compat de publish-monthly.ts aponta pra MESMA função.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  escHtml as escDirect,
  draftToEmail as d2eDirect,
  splitByLabels as sblDirect,
  renderDestaque,
} from "../scripts/lib/monthly-render.ts";
import {
  escHtml as escReexport,
  draftToEmail as d2eReexport,
  splitByLabels as sblReexport,
} from "../scripts/publish-monthly.ts";

describe("monthly-render extraído (#1844)", () => {
  it("re-export de publish-monthly é a MESMA função do módulo", () => {
    assert.strictEqual(escReexport, escDirect);
    assert.strictEqual(d2eReexport, d2eDirect);
    assert.strictEqual(sblReexport, sblDirect);
  });

  it("módulo auto-contido funciona standalone", () => {
    assert.equal(escDirect("a & b < c"), "a &amp; b &lt; c");
    // draftToEmail é puro: draft → { subject, previewText, html }
    const out = d2eDirect("REMETENTE\nDiar.ia\n", "Assunto X", "2606");
    assert.equal(out.subject, "Assunto X");
    assert.ok(typeof out.html === "string" && out.html.length > 0);
  });

  // #2018: caption parametrizada por gerador — antes hardcoded "Criada com Gemini"
  it("#2018: renderDestaque usa caption default 'Criada com IA' quando imageCaption omitido", () => {
    const chunk = "DESTAQUE 1 TECH\nTítulo do destaque\nCorpo do destaque.";
    const html = renderDestaque(chunk, undefined, "https://example.com/img.jpg");
    assert.ok(html.includes("Criada com IA"), `default caption deve ser 'Criada com IA', obtido: ${html.slice(0, 200)}`);
  });

  it("#2018: renderDestaque usa imageCaption passado explicitamente", () => {
    const chunk = "DESTAQUE 1 TECH\nTítulo do destaque\nCorpo do destaque.";
    const html = renderDestaque(chunk, undefined, "https://example.com/img.jpg", "Criada com Gemini");
    assert.ok(html.includes("Criada com Gemini"), `caption explícito deve aparecer, obtido: ${html.slice(0, 200)}`);
    assert.ok(!html.includes("Criada com IA"), "default não deve aparecer quando caption explícito");
  });

  it("#2018: draftToEmail propaga destaqueImageCaption para renderDestaque", () => {
    // isSectionLabel exige **LABEL** (bold markdown) — formato do export do Drive.
    const draft = [
      "**REMETENTE**",
      "Clarice News",
      "",
      "**DESTAQUE 1 | TECH**",
      "Título tech",
      "Parágrafo de análise.",
      "",
      "O fio condutor: Conclusão final.",
    ].join("\n");
    const imageUrls = { 1: "https://example.com/d1.jpg" };
    const out = d2eDirect(draft, "Assunto", "2606", undefined, undefined, undefined, imageUrls, "Criada com ComfyUI");
    assert.ok(out.html.includes("Criada com ComfyUI"), `caption customizado deve aparecer no HTML: ${out.html.slice(0, 400)}`);
  });
});
