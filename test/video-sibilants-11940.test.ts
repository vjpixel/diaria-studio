import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { combinedCutEnvelope, energyEnvelope, parseWavPcm16, preserveSibilants, highBandCutWarnings, intersectSilences, highBandSilences, edgeExtras, type Envelope } from "../scripts/lib/diaria/video-cut-refine.ts";

const env = (sounds: Array<[number, number]>, duration = 3): Envelope => ({ hopS: 0.01, db: Float64Array.from({ length: duration * 100 }, (_, i) => sounds.some(([a,b]) => i / 100 >= a && i / 100 < b) ? -48 : -63) });

it("#11940: cauda fraca de 340 ms ganha ar; início em plena fala abre antes do agudo", () => {
  const high = env([[0.9, 2.34]]);
  const raw = [{ block: "comentario" as const, srcIn: 1, srcOut: 2 }];
  const r = preserveSibilants(raw, high, [], 3);
  assert.equal(r.clips[0].srcIn, 0.87);
  assert.equal(r.clips[0].srcOut, 2.37);
  assert.equal(r.adjustments.length, 2);
  assert.equal(highBandCutWarnings(raw, high).length, 2);
  assert.deepEqual(highBandCutWarnings(r.clips, high), []);
  assert.deepEqual(preserveSibilants(r.clips, high, [], 3).adjustments, []);
});

it("#11940: silêncio curto não autoriza corte; sem vale ou perto da palavra vizinha avisa", () => {
  const high = env([[0,1], [1.04,3]]);
  assert.deepEqual(highBandSilences(high), []);
  const raw = [{ block: "comentario" as const, srcIn: 0.5, srcOut: 2 }];
  assert.deepEqual(preserveSibilants(raw, high, [], 3).clips, raw);
  assert.equal(highBandCutWarnings(raw, high).length, 2);
  const tail = env([[1,2.1]]);
  const bounded = preserveSibilants(raw, tail, [{ start: 2.11, end: 2.5, text: "vizinha" }], 3);
  assert.equal(bounded.clips[0].srcOut, 2);
});

it("#11940: pausa exige silêncio tanto no grave quanto na banda alta", () => {
  assert.deepEqual(intersectSilences([{start: 1,end: 3}], [{start: 1.34,end: 2}, {start:2.2,end:4}]), [{start:1.34,end:2}, {start:2.2,end:3}]);
});

it("#11940: há/a e é/e do roteiro não são hesitação descartável", () => {
  for (const [written, heard] of [["há", "a"], ["é", "e"]]) {
    const d = edgeExtras({ edge: "in", clip: { srcIn: 0, srcOut: 3, script: `${written} modelo novo` }, heard: [{start:0.1,end:0.3,text:heard},{start:0.6,end:0.9,text:"modelo"},{start:1,end:1.4,text:"novo"}], reference: [{start:0.6,end:0.9,text:"modelo"},{start:1,end:1.4,text:"novo"}], env: env([[0,3]]), thresholdDb: -60 });
    assert.equal(d.to, undefined);
    assert.match(d.note ?? "", /roteiro/);
  }
});

it("#11940: trecho real 261103, 'atrás', sibilante atravessa 544,43 e fica inteiro após refino", () => {
  const wav = readFileSync(new URL("./fixtures/video-sibilants-11940/atras-high-48k.wav", import.meta.url));
  assert.equal(parseWavPcm16(wav).sampleRate, 48000);
  const { samples, sampleRate } = parseWavPcm16(wav);
  const high = energyEnvelope(samples, sampleRate);
  const raw = [{block: "comentario" as const, srcIn: 0, srcOut: 544.43 - 543.9}];
  assert.ok(highBandCutWarnings(raw, high).some((w) => w.includes("saída")));
  const r = preserveSibilants(raw, high, [], 0.9);
  assert.ok(r.clips[0].srcOut > raw[0].srcOut + 0.05);
  assert.ok(r.clips[0].srcOut < raw[0].srcOut + 0.25);
  assert.ok(!highBandCutWarnings(r.clips, high).some((w) => w.includes("saída")));
});


it("#11940: refino só enxerga silêncio quando as duas bandas caem abaixo de seus limiares", () => {
  const low: Envelope = { hopS: 0.01, db: new Float64Array(300).fill(-45) };
  const combined = combinedCutEnvelope(low, env([[1, 2]]), -34);
  assert.ok(combined.db[150] > -34, "sibilante fraca precisa impedir o vale no grave");
  assert.ok(combined.db[50] < -34);
});

it("#11940: arredondar para quadros do Premiere preserva os 30 ms de ar", () => {
  const high = env([[0.9, 2.34]]);
  const r = preserveSibilants([{ block: "comentario", srcIn: 1, srcOut: 2.371 }], high, [], 3, 30);
  const rendered = r.clips.map((c) => ({ ...c, srcIn: Math.round(c.srcIn * 30) / 30, srcOut: Math.round(c.srcOut * 30) / 30 }));
  assert.deepEqual(highBandCutWarnings(rendered, high), []);
  assert.ok(rendered[0].srcOut >= 2.37);
  assert.ok(rendered[0].srcIn <= 0.87);
});
