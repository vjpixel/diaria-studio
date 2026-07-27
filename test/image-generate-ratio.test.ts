/**
 * test/image-generate-ratio.test.ts (#4093)
 *
 * `image-generate.ts` ganhou `--ratio 4x5` (card de feed nativo) e
 * `--ratio master` (envelope 6:5, testado e depois rejeitado como default —
 * ver issue #4093, comentário 260727 "gerar DUAS vezes, uma por formato") sem
 * teste de dimensões — só STYLE_SUFFIX tinha cobertura
 * (test/image-generate-safe-area.test.ts). `resolveRatio` foi extraído de
 * `main()` justamente pra poder testar a resolução de proporção/dimensões
 * sem invocar o gerador de imagem real (custaria dinheiro por teste, e o
 * guard desta rodada proíbe geração real).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRatio } from "../scripts/image-generate.ts";

describe("resolveRatio — dimensões por proporção (#4093)", () => {
  it("--ratio 2x1 → 1600×800 (hero wide)", () => {
    const r = resolveRatio("2x1", "d1");
    assert.equal(r.ratio, "2x1");
    assert.equal(r.width, 1600);
    assert.equal(r.height, 800);
    assert.equal(r.wide, true);
    assert.equal(r.portrait45, false);
    assert.equal(r.master, false);
  });

  it("--ratio 1x1 → 1024×1024 (square nativo, ex: uso mensal)", () => {
    const r = resolveRatio("1x1", "d2");
    assert.equal(r.ratio, "1x1");
    assert.equal(r.width, 1024);
    assert.equal(r.height, 1024);
    assert.equal(r.wide, false);
  });

  it("--ratio 4x5 → 1080×1350 (card de feed nativo, sem crop)", () => {
    const r = resolveRatio("4x5", "d3");
    assert.equal(r.ratio, "4x5");
    assert.equal(r.width, 1080);
    assert.equal(r.height, 1350);
    assert.equal(r.portrait45, true);
    assert.equal(r.wide, false);
    assert.equal(r.master, false);
  });

  it("--ratio master → 1600×1350 (envelope 6:5)", () => {
    const r = resolveRatio("master", "d1");
    assert.equal(r.ratio, "master");
    assert.equal(r.width, 1600);
    assert.equal(r.height, 1350);
    assert.equal(r.master, true);
    assert.equal(r.wide, false);
    assert.equal(r.portrait45, false);
  });

  it("sem --ratio, destaque d1/d2/d3 → default wide (2x1), #2133/#2141", () => {
    for (const d of ["d1", "d2", "d3"]) {
      const r = resolveRatio(undefined, d);
      assert.equal(r.ratio, "2x1", `${d} deveria defaultar pra 2x1`);
      assert.equal(r.width, 1600);
      assert.equal(r.height, 800);
    }
  });

  it("sem --ratio, destaque fora de d1-d3 (ex: mensal usa outro destaque) → default square 1x1", () => {
    const r = resolveRatio(undefined, "d4");
    assert.equal(r.ratio, "1x1");
    assert.equal(r.width, 1024);
    assert.equal(r.height, 1024);
  });

  it("--ratio inválido lança erro claro (fail-loud, não gera imagem)", () => {
    assert.throws(
      () => resolveRatio("16x9", "d1"),
      /--ratio deve ser 2x1, 1x1, 4x5 ou master. Recebido: 16x9/,
    );
  });
});
