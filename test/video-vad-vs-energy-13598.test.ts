/**
 * #13598 — medição do Silero VAD contra o detector de energia: ilhas do
 * Silero a partir das probabilidades, referência do editor a partir do
 * registro do `video-xml-vs-final` e as métricas de acerto/pausa. Só medição.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { editorReference, intersect, scoreDetector, subtract, vadIslands } from "../scripts/lib/diaria/video-vad-vs-energy.ts";
import type { ClipComparison } from "../scripts/lib/diaria/video-xml-vs-final.ts";

const clip = (o: Partial<ClipComparison>): ClipComparison => ({
  index: 0, srcIn: 0, srcOut: 10, status: "kept", headMs: 0, tailMs: 0, internalPauses: [], finalStart: 0, touched: false, ...o,
});

describe("vadIslands", () => {
  it("une ilhas a menos de 0,32 s, descarta ilha menor que 0,06 s", () => {
    // janelas de 0,1 s: fala em 0-0,3, vão de 0,2 s, fala em 0,5-0,7, vão de 1 s, estalo de 0,03 s em 1,7
    const probs = [1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    const v = { hopS: 0.1, probs };
    const out = vadIslands(v, { minIslandS: 0.15 });
    assert.equal(out.length, 1); // o vão de 0,2 s une as duas; o estalo de 0,1 s < 0,15 s sai
    assert.deepEqual([out[0].start, +out[0].end.toFixed(1)], [0, 0.7]);
    assert.equal(vadIslands({ hopS: 0.032, probs: [0, 1, 0, 0] }).length, 0);
  });
});

describe("intervalos", () => {
  it("intersect e subtract", () => {
    assert.deepEqual(intersect([{ start: 0, end: 5 }], [{ start: 3, end: 8 }]), [{ start: 3, end: 5 }]);
    assert.deepEqual(subtract([{ start: 0, end: 10 }], [{ start: 4, end: 6 }]), [{ start: 0, end: 4 }, { start: 6, end: 10 }]);
  });
});

describe("editorReference + scoreDetector", () => {
  it("fala = clipe mantido menos pausa interna, encolhida; clipe removido fica de fora", () => {
    const ref = editorReference([
      clip({ srcIn: 0, srcOut: 10, internalPauses: [{ start: 4, end: 6, ms: 2000 }] }),
      clip({ index: 1, srcIn: 20, srcOut: 30, status: "removed", headMs: null, tailMs: null }),
    ], 0.1);
    assert.deepEqual(ref.speech.map((s) => [+s.start.toFixed(2), +s.end.toFixed(2)]), [[0.1, 3.9], [6.1, 9.9]]);
    assert.deepEqual(ref.pauses.map((s) => [+s.start.toFixed(2), +s.end.toFixed(2)]), [[4.1, 5.9]]);
  });
  it("detector que cobre a fala e invade a pausa: recall 1, falso positivo na pausa", () => {
    const ref = editorReference([clip({ internalPauses: [{ start: 4, end: 6, ms: 2000 }] })], 0.1);
    const s = scoreDetector([{ start: 0, end: 4.5 }, { start: 6, end: 10 }], ref);
    assert.equal(s.speechRecall, 1);
    assert.equal(s.pausesWithIsland, 1);
    assert.ok(s.pauseFalsePositive > 0.2 && s.pauseFalsePositive < 0.3);
  });
  it("detector que corta fala: recall < 1; sem pausas, falso positivo 0", () => {
    const ref = editorReference([clip({})], 0.1);
    const s = scoreDetector([{ start: 0, end: 5 }], ref);
    assert.ok(s.speechRecall < 0.6);
    assert.equal(s.pauseFalsePositive, 0);
  });
});
