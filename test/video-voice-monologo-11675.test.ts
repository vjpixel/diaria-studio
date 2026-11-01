/**
 * test/video-voice-monologo-11675.test.ts (#11675) — 261030, monólogo: segmentos
 * longos do Whisper (silêncio/respiro + 3 s de fala) puxavam a F0 do segmento e
 * o detector marcava "entrevistadora". A F0 passa a ser medida só nas palavras
 * e o peso da voz é o tempo de fala, não a duração do segmento.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyVoices, segmentF0s, speechSeconds } from "../scripts/lib/diaria/video-voice.ts";

const SR = 16000;

function tone(f0: number, seconds: number): Int16Array {
  const out = new Int16Array(Math.round(seconds * SR));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const f = f0 * (1 + 0.01 * Math.sin((2 * Math.PI * 5 * i) / SR));
    phase += (2 * Math.PI * f) / SR;
    let s = 0;
    for (let h = 1; h <= 5; h++) s += Math.sin(h * phase) / h;
    out[i] = Math.round(4000 * s);
  }
  return out;
}

function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("F0 só nas palavras (#11675)", () => {
  // 20 s de "respiro" a 110 Hz e 4 s de fala a 150 Hz no fim do mesmo segmento.
  const audio = concat([tone(110, 20), tone(150, 4)]);
  const words = [{ start: 20.2, end: 23.8 }];

  it("sem palavras, o trecho sem fala puxa a mediana (comportamento antigo)", () => {
    const [f] = segmentF0s(audio, SR, [{ start: 0, end: 24 }]);
    assert.ok(f !== null && f < 120, `medido ${f}`);
  });

  it("com palavras, mede a fala (~150 Hz)", () => {
    const [f] = segmentF0s(audio, SR, [{ start: 0, end: 24, words }]);
    assert.ok(f !== null && Math.abs(f - 150) / 150 < 0.04, `medido ${f}`);
  });

  it("speechSeconds soma as palavras e cai na duração sem elas", () => {
    assert.ok(Math.abs(speechSeconds({ start: 0, end: 24, words }) - 3.6) < 1e-9);
    assert.equal(speechSeconds({ start: 0, end: 24 }), 24);
  });
});

describe("monólogo não vira entrevista (#11675)", () => {
  // 25 segmentos de 4 s do Pixel (150 Hz) e 1 segmento longo de Whisper (25 s) com 2 s de fala,
  // cuja F0 de segmento saiu ~110 Hz.
  const f0s = [...Array(25).fill(150), 110];

  it("pesado pela duração do segmento, o longo viraria 'outra voz' (comportamento antigo)", () => {
    assert.equal(classifyVoices(f0s, [...Array(25).fill(4), 25]).twoVoices, true);
  });

  it("pesado pelo tempo de fala, 2 s em ~102 s não é outra voz", () => {
    assert.equal(classifyVoices(f0s, [...Array(25).fill(4), 2]).twoVoices, false);
  });
});
