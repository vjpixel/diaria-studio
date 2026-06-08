/**
 * test/email-type-scale-white-shell.test.ts
 *
 * Trava duas decisões de design do editor:
 *  - Type scale do e-mail alinhado ao DS (vjpixel/diaria-design#4): só
 *    {12, 16, 22, 26}px. As regras 11→12, 13→12, 15→16, 20→22 eliminaram
 *    os tamanhos antigos do render.
 *  - Preview do Worker em fundo 100% branco (#1952): o shell de preview
 *    (`upload-html-public.ts` / `wrap-draft-preview.ts`) não usa mais o
 *    cinza #f5f5f5 nem sombra de card — fundo branco liso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("type scale do e-mail alinhado ao DS (diaria-design#4)", () => {
  const render = readFileSync(join(ROOT, "scripts/render-newsletter-html.ts"), "utf8");
  const sizes = [...render.matchAll(/font-size:(\d+)px/g)].map((m) => Number(m[1]));

  it("não usa mais 11/13/15/20px (substituídos por 12/12/16/22)", () => {
    const forbidden = [...new Set(sizes.filter((s) => [11, 13, 15, 20].includes(s)))];
    assert.deepEqual(forbidden, [], `render usa tamanhos fora do type-scale aprovado: ${forbidden.join(", ")}`);
  });

  it("usa só a escala aprovada {12,16,22,26}", () => {
    const allowed = new Set([12, 16, 22, 26]);
    const stray = [...new Set(sizes.filter((s) => !allowed.has(s)))];
    assert.deepEqual(stray, [], `font-size fora de {12,16,22,26}: ${stray.join(", ")}`);
  });
});

describe("preview do Worker em fundo 100% branco (#1952)", () => {
  // Só o shell VIVO (wrapForPreview, servido em draft.diaria.workers.dev).
  // wrap-draft-preview.ts era dead code e foi removido neste PR.
  for (const f of ["scripts/upload-html-public.ts"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    it(`${f}: shell sem cinza #f5f5f5`, () => {
      assert.doesNotMatch(src, /#f5f5f5/i, `${f}: shell do preview ainda tem fundo cinza`);
    });
    it(`${f}: shell sem sombra de card (box-shadow)`, () => {
      assert.doesNotMatch(src, /box-shadow:\s*0[^;]*rgba/i, `${f}: card do preview ainda tem box-shadow`);
    });
  }
});
