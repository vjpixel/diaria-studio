/**
 * test/video-montagem-13194-13188-cortes.test.ts — #13194 (P1) e #13188: os
 * cortes do `build` comiam começo e fim de palavra. Decisão do editor
 * (15/11/2026, montagem da 261116): na dúvida, é melhor deixar trecho sem
 * áudio do que palavra cortada.
 *
 * Casos sintéticos com o perfil do bruto da 261116 (-31 LUFS, piso de ruído
 * -79 dB): o limiar fixo (-33/-46 dB) deixava fora a cauda das palavras, que
 * fica 35 a 45 dB acima do piso; o filtro pela F0 tirava a palavra curta pouco
 * vozeada no começo da frase ("No" de "No índice"); e as pontas dos itens
 * saíam dos tempos do Whisper, que começam depois do ataque.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SPEECH_DETECT,
  speechIslands,
  speechPauseSilences,
  speechThresholds,
  type FrameEnergy,
} from "../scripts/lib/diaria/video-cut-refine.ts";
import { TAKE_DEFAULTS, takeInterval, type Word } from "../scripts/lib/diaria/video-montage.ts";

const HOP = SPEECH_DETECT.hopS;

/** Envelope de 5 ms: `floor`/`floorDiff` no resto; `segs` = [início, fim, dB cheio, dB 1ª diferença, voz?]. */
function envelope(durationS: number, segs: Array<[number, number, number, number, boolean]>, floor: number, floorDiff: number): FrameEnergy {
  const n = Math.round(durationS / HOP);
  const fullDb = new Float64Array(n).fill(floor);
  const diffDb = new Float64Array(n).fill(floorDiff);
  const voiced = new Uint8Array(n);
  for (const [a, b, full, diff, v] of segs) {
    for (let i = Math.round(a / HOP); i < Math.round(b / HOP); i++) {
      fullDb[i] = full;
      diffDb[i] = diff;
      voiced[i] = v ? 1 : 0;
    }
  }
  return { hopS: HOP, fullDb, diffDb, voiced };
}

/** Frase do bruto baixo: vogais a -22 dB com voz e, colada no fim, a cauda da palavra (100 ms a -42 dB, sem voz). */
const phrase = (a: number, b: number): Array<[number, number, number, number, boolean]> => [
  [a, b, -22, -34, true],
  [b, b + 0.1, -42, -55, false],
];

describe("#13188: bruto baixo (-31 LUFS, piso -79 dB) — o limiar relativo também baixa o fixo", () => {
  const segs = [...phrase(1, 3), ...phrase(4, 6), ...phrase(7, 9)];
  const e = envelope(10, segs, -79, -85);

  it("os limiares descem para o topo − 24 dB e o piso + 10 dB, com a origem 'relativo'", () => {
    const th = speechThresholds(e);
    assert.equal(th.status, "relativo");
    assert.deepEqual(th.source, { fullDb: "relativo", diffDb: "relativo" });
    assert.equal(th.fullDb, -22 - SPEECH_DETECT.fullBelowTopDb);
    assert.equal(th.diffDb, -85 + SPEECH_DETECT.diffAboveFloorDb);
    assert.ok(th.fullDb < SPEECH_DETECT.fullDb && th.diffDb < SPEECH_DETECT.diffDb, "abaixo dos fixos");
    assert.deepEqual(th.warnings, []);
  });

  it("a cauda da palavra (35 dB acima do piso) fica na ilha; a pausa no piso continua saindo", () => {
    const islands = speechIslands(e);
    assert.equal(islands.length, 3, JSON.stringify(islands));
    for (const [k, end] of [[0, 3.1], [1, 6.1], [2, 9.1]] as const) {
      assert.ok(islands[k].end >= end - 1e-9, `ilha ${k} termina em ${islands[k].end}, antes da cauda (${end})`);
    }
    const pauses = speechPauseSilences(islands, 10);
    assert.ok(pauses.some((p) => p.start >= 3.1 && p.end <= 4 && p.end - p.start > 0.5), `pausa entre as frases: ${JSON.stringify(pauses)}`);
  });

  it("com os limiares fixos à mão, a cauda abaixo deles ainda fica pelo decaimento medido contra o piso", () => {
    const islands = speechIslands(e, { fullDb: SPEECH_DETECT.fullDb, diffDb: SPEECH_DETECT.diffDb });
    assert.ok(islands[0].end >= 3.1 - 1e-9, `fim ${islands[0].end}`);
    assert.ok(islands[0].end <= 3 + SPEECH_DETECT.decayMaxS + 1e-9, "o decaimento tem teto");
  });

  it("o limiar que desce nunca fica a menos de 10 dB do piso (topo baixo, perto do piso)", () => {
    // Fala a -50 dB com piso -79: topo − 24 = -74, a 5 dB do piso; vale piso + 10.
    const low = envelope(10, [[1, 3, -50, -60, true], [4, 6, -50, -60, true], [7, 9, -50, -60, true]], -79, -85);
    const th = speechThresholds(low);
    assert.equal(th.fullDb, -79 + SPEECH_DETECT.relativeLowerAboveFloorDb);
  });

  it("o bruto quente (piso -41/-50, fala -8) continua subindo o limiar como no #12089", () => {
    const hot = envelope(10, [[1, 3, -8, -20, true], [4, 6, -8, -20, true], [7, 9, -8, -20, true]], -41, -50);
    const th = speechThresholds(hot);
    assert.deepEqual([th.fullDb, th.diffDb, th.status], [-8 - SPEECH_DETECT.fullBelowTopDb, -50 + SPEECH_DETECT.diffAboveFloorDb, "relativo"]);
  });
});

describe("#13194: o filtro pela F0 não tira a palavra curta pouco vozeada do começo da frase", () => {
  it('"No índice" (261116, 617,1 s): 250 ms sem voz colados na voz e bem acima do piso ficam na ilha', () => {
    // "No" de 2,75 a 3,0 s sem F0 medida, a -40 dB (39 dB acima do piso), colado em "índice" (voz a partir de 3,0 s).
    const e = envelope(10, [[1, 2, -22, -34, true], [2.75, 3.0, -40, -50, false], [3.0, 5, -22, -34, true], [7, 9, -22, -34, true]], -79, -85);
    const islands = speechIslands(e);
    const at = islands.find((s) => s.end > 4 && s.start < 4)!;
    assert.ok(at.start <= 2.75 + 1e-9, `a ilha começa no "No": ${JSON.stringify(at)} (antes: ${3 - SPEECH_DETECT.voicedLeadS} s)`);
  });

  it("o mesmo trecho separado da voz por um vale continua saindo (respiração antes da frase)", () => {
    const e = envelope(10, [[1, 2, -22, -34, true], [2.5, 2.75, -40, -50, false], [3.0, 5, -22, -34, true], [7, 9, -22, -34, true]], -79, -85);
    const islands = speechIslands(e);
    assert.ok(!islands.some((s) => s.start < 2.8 && s.end > 2.5), JSON.stringify(islands));
  });

  it("respiração colada no ataque no bruto quente (-27 dB, piso -41: 14 dB acima) segue fora além de voicedLeadS", () => {
    const e = envelope(10, [[1.5, 1.98, -27, -39, false], [1.98, 4, -8, -20, true], [5, 6, -8, -20, true], [7, 9, -8, -20, true]], -41, -50);
    const [first] = speechIslands(e);
    assert.ok(first.start >= 1.98 - SPEECH_DETECT.voicedLeadS - 1e-9, `ilha começa em ${first.start}`);
  });

  it("trecho sem voz mais longe da voz que voicedLeadMaxS sai mesmo contínuo", () => {
    const e = envelope(10, [[1, 2, -22, -34, true], [2.4, 3.0, -40, -50, false], [3.0, 5, -22, -34, true], [7, 9, -22, -34, true]], -79, -85);
    const at = speechIslands(e).find((s) => s.end > 4 && s.start < 4)!;
    assert.ok(at.start >= 3.0 - SPEECH_DETECT.voicedLeadMaxS - 1e-9, `ilha começa em ${at.start}`);
  });
});

describe("#13194: as pontas dos itens abrem 0,3 s, sem encostar na palavra vizinha", () => {
  const w = (start: number, end: number, text: string): Word => ({ start, end, text });

  it("defaults de 0,3 s para cada lado", () => {
    assert.equal(TAKE_DEFAULTS.preRollS, 0.3);
    assert.equal(TAKE_DEFAULTS.postRollS, 0.3);
  });

  it("com folga no bruto, a tomada abre 0,3 s; com a vizinha perto, para a guardS dela", () => {
    const words = [w(5, 6, "antes"), w(10, 11, "fala"), w(11, 12, "aqui"), w(15, 16, "depois")];
    assert.deepEqual(takeInterval(words, { firstWord: 1, lastWord: 2 }), { start: 9.7, end: 12.3 });
    const tight = [w(9, 9.8, "antes"), w(10, 11, "fala"), w(11, 12, "aqui"), w(12.1, 13, "depois")];
    assert.deepEqual(takeInterval(tight, { firstWord: 1, lastWord: 2 }), { start: 9.85, end: 12.05 });
  });
});
