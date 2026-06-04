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
});
