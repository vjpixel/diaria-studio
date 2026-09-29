/**
 * test/site-assinar-page-drift-9018.test.ts (#9018)
 *
 * Garante que o HTML committed `workers/site/public/assinar/index.html`
 * bate byte a byte com `buildAssinarHtml()` — mesmo padrão de
 * `hub-page-drift`/`cursos-full-drift`.
 *
 * Motivação (#9018): o fix do #8983 (fleet review, achado P1 nº 1) mandou
 * `external_id`/`fbc`/`fbp` no corpo do POST cross-origin do form, mas só no
 * gerador (`scripts/lib/site-assinar-page.ts`). O arquivo committed tinha
 * sido regenerado ANTES da correção e seguiu em produção sem os três campos
 * (e com o bootstrap de `_fbc` sem a validação `FBCLIDRE`) — o
 * `CompleteRegistration` via CAPI saía sem `external_id` na landing principal
 * dos anúncios. Nenhum teste comparava gerado × committed.
 *
 * A página é inteiramente estática (sem data/edição/request), então a
 * igualdade exata é estável. A home (`public/index.html`) NÃO entra aqui: o
 * feed dela depende de "hoje" em BRT (#7686) e do sitemap, e já tem seu
 * próprio par em `scripts/check-seed-html-sync.ts` + o workflow
 * `regen-home.yml`.
 *
 * Fix do drift: `npx tsx scripts/gen-assinar-page.ts`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAssinarHtml } from "../scripts/lib/site-assinar-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMITTED = resolve(ROOT, "workers/site/public/assinar/index.html");
const FIX = "rode: npx tsx scripts/gen-assinar-page.ts";

describe("/assinar — drift gerado × committed (#9018)", () => {
  it("workers/site/public/assinar/index.html existe", () => {
    assert.ok(existsSync(COMMITTED), `arquivo ausente — ${FIX}`);
  });

  it("o HTML committed bate com um render fresco de buildAssinarHtml()", () => {
    const committed = readFileSync(COMMITTED, "utf8");
    assert.equal(committed, buildAssinarHtml(), `/assinar divergiu do gerador — ${FIX}`);
  });

  it("o HTML committed manda external_id, fbc e fbp no corpo do POST (cenário do #9018)", () => {
    const committed = readFileSync(COMMITTED, "utf8");
    assert.match(committed, /external_id:\s*window\.__DIA_VID__/, `external_id ausente do payload — ${FIX}`);
    assert.match(committed, /\bfbc:\s*\(function/, `fbc ausente do payload — ${FIX}`);
    assert.match(committed, /\bfbp:\s*\(function/, `fbp ausente do payload — ${FIX}`);
    assert.match(committed, /FBCLIDRE/, `bootstrap de _fbc sem a validação FBCLIDRE — ${FIX}`);
  });
});
