/**
 * test/permutation-test.test.ts (#7980)
 *
 * Cobre scripts/lib/permutation-test.ts — extraído de
 * calibration-power-report.ts (Track B) pra ser reusado também por
 * calibration-power-report-track-a.ts (#7980), sem duplicar a lógica de
 * determinismo nos dois arquivos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mulberry32, shuffleInPlace } from "../scripts/lib/permutation-test.ts";

describe("mulberry32 (#7980)", () => {
  it("mesma seed produz a mesma sequência", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    assert.deepEqual(seqA, seqB);
  });

  it("seeds diferentes produzem sequências diferentes", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    assert.notEqual(a(), b());
  });

  it("valores sempre em [0, 1)", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = rand();
      assert.ok(v >= 0 && v < 1, `valor fora de faixa: ${v}`);
    }
  });
});

describe("shuffleInPlace (#7980)", () => {
  it("preserva os mesmos elementos (permutação, não substituição)", () => {
    const arr = [1, 2, 3, 4, 5];
    shuffleInPlace(arr, mulberry32(1));
    assert.deepEqual([...arr].sort(), [1, 2, 3, 4, 5]);
  });

  it("determinístico — mesma seed embaralha pro mesmo resultado", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [1, 2, 3, 4, 5];
    shuffleInPlace(a, mulberry32(99));
    shuffleInPlace(b, mulberry32(99));
    assert.deepEqual(a, b);
  });
});
