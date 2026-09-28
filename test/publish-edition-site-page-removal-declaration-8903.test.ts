/**
 * test/publish-edition-site-page-removal-declaration-8903.test.ts (#8903)
 *
 * O PR automático de `publish-edition-site-page.ts` (regen de home/archive/
 * sitemap junto com a página nova) passa fácil de 500 linhas adicionadas —
 * o PR #8893 (edição 260928) teve 520. O gate `evaluateRemovalDeclaration`
 * (#7115) então exige o marcador `removal-declaration:` no corpo, travando
 * o auto-merge (#8158) até alguém adicionar o marcador manualmente.
 *
 * Fix: `buildSitePagePrBody` sempre inclui o marcador — o diff é 100%
 * artefato gerado por template, então a declaração é sempre a mesma.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSitePagePrBody } from "../scripts/publish-edition-site-page.ts";
import { evaluateRemovalDeclaration } from "../scripts/lib/pr-removal-declaration.ts";

describe("buildSitePagePrBody (#8903)", () => {
  it("inclui o marcador removal-declaration", () => {
    const body = buildSitePagePrBody("algum-slug");
    assert.match(body, /removal-declaration:\s*\S/i);
  });

  it("satisfaz evaluateRemovalDeclaration mesmo com diff acima do limiar (520 linhas, caso real #8893)", () => {
    const body = buildSitePagePrBody("google-vai-colocar-data-centers-no-espaco");
    const evaluation = evaluateRemovalDeclaration({ files: 6, added: 520, removed: 3 }, body);
    assert.equal(evaluation.status, "ok");
  });
});
