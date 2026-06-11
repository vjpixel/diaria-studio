/**
 * test/monthly-eia-image-key.test.ts (#1908)
 *
 * Regressão do bug: a result page do voto É IA? monta a URL da imagem como
 * `/img/img-{edition}-01-eia-{A|B}.jpg`, mas o digest mensal subia as imagens
 * com a key `img-monthly-*` → a result page nunca encontrava (imagens quebradas
 * pós-voto no mensal). O fix unifica a convenção em `img-{edition}-{basename}`.
 *
 * O teste amarra o invariante CROSS-FILE: a key do upload (publish-monthly) ==
 * a URL que o worker (renderResultImagesHtml) busca.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { monthlyEiaImageKey } from "../scripts/publish-monthly.ts";
import { renderResultImagesHtml } from "../workers/poll/src/index.ts";

describe("monthlyEiaImageKey (#1908)", () => {
  it("usa a convenção img-{edition}-{basename} (igual ao diário)", () => {
    assert.equal(monthlyEiaImageKey("260531", "/x/y/01-eia-A.jpg"), "img-260531-01-eia-A.jpg");
    assert.equal(monthlyEiaImageKey("260531", "01-eia-B.jpg"), "img-260531-01-eia-B.jpg");
    // path estilo Windows
    assert.equal(monthlyEiaImageKey("260531", "C:\\monthly\\01-eia-A.jpg"), "img-260531-01-eia-A.jpg");
  });

  it("a key do upload bate com a URL que a result page do voto monta (cross-file) — legado 260531", () => {
    const edition = "260531";
    const html = renderResultImagesHtml({ edition, aiSide: "A", clickedSide: "A" });
    // ambas as imagens (A e B) sempre renderizam na result page
    assert.ok(
      html.includes(`/img/${monthlyEiaImageKey(edition, "01-eia-A.jpg")}`),
      "result page deve buscar a key A que o mensal sobe",
    );
    assert.ok(
      html.includes(`/img/${monthlyEiaImageKey(edition, "01-eia-B.jpg")}`),
      "result page deve buscar a key B que o mensal sobe",
    );
    // e NÃO a key legada img-monthly-*
    assert.equal(html.includes("img-monthly-"), false);
  });

  // #2115: ciclo 2605-06 — a key do upload também bate com a URL da result page
  it("a key do upload bate com a URL da result page — ciclo 2605-06", () => {
    const edition = "2605-06";
    const html = renderResultImagesHtml({ edition, aiSide: "B", clickedSide: "A" });
    assert.ok(
      html.includes(`/img/${monthlyEiaImageKey(edition, "01-eia-A.jpg")}`),
      "result page usa img-2605-06-01-eia-A.jpg",
    );
    assert.ok(
      html.includes(`/img/${monthlyEiaImageKey(edition, "01-eia-B.jpg")}`),
      "result page usa img-2605-06-01-eia-B.jpg",
    );
  });
});
