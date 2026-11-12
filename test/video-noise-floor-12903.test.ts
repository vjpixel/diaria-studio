import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { energyEnvelope, noiseFloorThreshold, noPausesWarning, maxDbIn } from "../scripts/lib/diaria/video-cut-refine.ts";
import { edgeFindings } from "../scripts/lib/diaria/video-xml-verify.ts";
import { collapsedTakeSuspects, parseSilenceDetect, silenceNoiseDb } from "../scripts/lib/diaria/video-montage.ts";

// Ruído contínuo a -39 dB RMS; fala a -20 dB entre 3 e 5 s.
const rate = 16000;
const samples = Int16Array.from({ length: rate * 10 }, (_, i) => {
  const db = i >= rate * 3 && i < rate * 5 ? -20 : -39;
  return Math.round(32768 * Math.sqrt(2) * 10 ** (db / 20) * Math.sin(2 * Math.PI * 200 * i / rate));
});
const env = energyEnvelope(samples, rate);
const clip = (a: number, b: number) => ({ start: 0, end: b - a, in: a, out: b, gIn: a, gOut: b, fileId: "file-1" });

describe("#12903 piso de ruído contínuo", () => {
  it("eleva o limiar acima do carro, preservando as bordas com fala cortada", () => {
    const baseline = silenceNoiseDb(null).noiseDb;
    const measured = noiseFloorThreshold(env, baseline);
    assert.equal(measured.how, "floor");
    assert.ok(Math.abs(measured.floorDb! + 39) < 0.1);
    assert.ok(Math.abs(measured.thresholdDb + 33) < 0.1);
    const level = (a: number, b: number) => maxDbIn(env, a, b);
    const safe = clip(80, 160);
    assert.equal(edgeFindings([safe], 30, level, baseline)[0].cutIn, true, "reproduz o falso positivo antigo");
    assert.deepEqual(edgeFindings([safe], 30, level, measured.thresholdDb).map(e => [e.cutIn, e.cutOut]), [[false, false]]);
    assert.equal(edgeFindings([clip(105, 160)], 30, level, measured.thresholdDb)[0].cutIn, true);
    assert.equal(edgeFindings([clip(80, 135)], 30, level, measured.thresholdDb)[0].cutOut, true);
    assert.ok(maxDbIn(env, 1, 2) < measured.thresholdDb, "pausa com ruído fica abaixo do novo limiar");
  });
  it("silencedetect real encontra pausas no ruído e limpa avisos de tomada colapsada", () => {
    // ffmpeg escreve os intervalos em stderr, mesmo quando termina com sucesso.
    const stderrDetect = (db: number) => {
      const result = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", "pipe:0", "-af", `silencedetect=noise=${db}dB:d=0.35`, "-f", "null", "-"], { input: Buffer.from(samples.buffer) });
      assert.equal(result.status, 0, result.stderr.toString());
      return parseSilenceDetect(result.stderr.toString(), 10);
    };
    const old = stderrDetect(-45);
    const pauses = stderrDetect(noiseFloorThreshold(env, -45).thresholdDb);
    assert.equal(old.length, 0);
    assert.equal(pauses.length, 2);
    const words = [{ text: "antes", start: 0, end: 0.2 }, { text: "fala", start: 3, end: 4 }, { text: "fim", start: 4, end: 5 }];
    assert.ok(collapsedTakeSuspects(words, old).length > 0);
    assert.deepEqual(collapsedTakeSuspects(words, pauses), []);
  });
  it("preserva override, áudio limpo, vazio e sinal sem contraste de fala", () => {
    assert.equal(noiseFloorThreshold(env, -45, true).thresholdDb, -45);
    for (const values of [[], [-120, -120], [-80, -80, -20], [-30, -30, -30], [NaN, Infinity]]) {
      assert.equal(noiseFloorThreshold({ hopS: 0.01, db: Float64Array.from(values) }, -45).thresholdDb, -45);
    }
  });
  it("avisa zero pausas em bruto longo, inclusive resultados em cache", () => {
    assert.match(noPausesWarning(180, 0)!, /0 pausas.*piso de ruído/);
    assert.equal(noPausesWarning(119, 0), null);
    assert.equal(noPausesWarning(180, 1), null);
  });
});
