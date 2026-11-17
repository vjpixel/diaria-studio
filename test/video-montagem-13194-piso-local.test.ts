/**
 * #13194 (resíduo da medição do export V10 da 261117): a borda só fecha onde a
 * energia caiu ao piso de ruído LOCAL (+3 dB), não num dBFS fixo.
 *
 * Caso real: 261117 horizontal, clipe 39 "Veja como não cair." sai em 859,733 s
 * do bruto. O piso da sala ali é -55 dBFS (o global do bruto é -85), e a cauda
 * de "cair" segue a -48..-52 dBFS por ~100 ms depois do corte: abaixo dos -45
 * fixos, nem o build abria nem o `verify-xml` acusava, e o Whisper do final
 * ouviu "caiu". Os sinais abaixo são sintéticos nesse perfil (16 kHz, o
 * `audio.wav` do `transcribe`): ruído de sala a ~-55 dBFS, fala a ~-24 dBFS e
 * a cauda a ~-47 dBFS.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { energyEnvelope, maxDbIn } from "../scripts/lib/diaria/video-cut-refine.ts";
import { assembleClips, type PlannedClip, type SourceInfo, type Word } from "../scripts/lib/diaria/video-montage.ts";
import {
  CUT_EDGE_OPEN,
  edgeFindings,
  edgeLine,
  LOCAL_FLOOR_EDGE,
  localEdgeThreshold,
  localFloorDb,
  NEIGHBOR_WORD_GRACE_S,
  openCutSoundEdges,
  type OpenableClip,
} from "../scripts/lib/diaria/video-xml-verify.ts";
import { openCutEdgesOfPlan } from "../scripts/video-montagem.ts";

const SR = 16000;
const FPS = 30;
/** O limiar fixo do bruto da 261117 (`noiseDb` do silences.meta.json). */
const FIXED = -45;

/** Amplitude de pico de um seno com este RMS em dBFS. */
const sineAmp = (db: number) => 32768 * 10 ** (db / 20) * Math.SQRT2;
/** Amplitude de um ruído uniforme com este RMS em dBFS. */
const noiseAmp = (db: number) => 32768 * 10 ** (db / 20) * Math.sqrt(3);

/** PRNG determinístico (o teste não pode variar de uma rodada para outra). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Segment = [start: number, end: number, db: number];

/** Ruído de sala em `noiseDb` em todo o bruto, mais tons nos trechos dados. `noise` pode variar por instante (sala ruidosa). */
function synth(durationS: number, segments: Segment[], noise: number | ((t: number) => number) = -55) {
  const n = Math.round(durationS * SR);
  const samples = new Int16Array(n);
  const rand = rng(13194);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const nd = typeof noise === "number" ? noise : noise(t);
    let v = (rand() * 2 - 1) * noiseAmp(nd);
    for (const [a, b, db] of segments) if (t >= a && t < b) v += sineAmp(db) * Math.sin(2 * Math.PI * 220 * t);
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  const env = energyEnvelope(samples, SR);
  return { env, level: (a: number, b: number) => maxDbIn(env, a, b) };
}

const clip = (srcIn: number, srcOut: number, block = "comentario"): OpenableClip => ({
  block,
  srcIn,
  srcOut,
  frameIn: Math.round(srcIn * FPS),
  frameOut: Math.round(srcOut * FPS),
});
const tl = (cs: readonly OpenableClip[]) => cs.map((c) => ({ start: 0, end: 0, in: c.frameIn, out: c.frameOut, fileId: "file-1", gIn: c.frameIn, gOut: c.frameOut }));
const w = (text: string, start: number, end: number): Word => ({ text, start, end });

/**
 * "Veja como não cair.": fala até 5,0 s, cauda de "cair" a -47 dBFS até 5,15 s, sala a -55 dBFS. O item sai em
 * 5,033 s (quadro 151), já na cauda: como na 261117, onde a energia caía de -33 para -46 dBFS no corte.
 */
const CAIR: Segment[] = [[2.0, 5.0, -24], [5.0, 5.15, -47]];
const OUT = 151 / FPS;

describe("#13194 piso de ruído local: o limiar da borda", () => {
  it("mede o piso em volta da borda, não o do bruto inteiro", () => {
    // sala a -55 até 10 s, estúdio quieto (-85) depois: o piso de cada trecho é o dele
    const { env } = synth(20, [[2.0, 5.0, -24], [12.0, 15.0, -24]], (t) => (t < 10 ? -55 : -85));
    const room = localFloorDb(env, 5.0)!;
    const quiet = localFloorDb(env, 15.0)!;
    assert.ok(room > -58 && room < -53, `piso da sala ~-55 (${room.toFixed(1)})`);
    assert.ok(quiet < -80, `piso do estúdio quieto (${quiet.toFixed(1)})`);
  });

  it("limiar = min(fixo, max(-60, piso local + 3 dB)): desce na sala, para em -60 no quieto, nunca sobe acima do fixo", () => {
    const { env } = synth(30, [[2.0, 5.0, -24], [12.0, 15.0, -24], [20.0, 29.0, -24]], (t) => (t < 10 ? -55 : t < 18 ? -85 : -30));
    const thr = localEdgeThreshold(env, FIXED);
    const room = thr(5.0);
    assert.ok(Math.abs(room - (localFloorDb(env, 5.0)! + LOCAL_FLOOR_EDGE.marginDb)) < 1e-9, "sala: piso + 3 dB");
    assert.ok(room < FIXED - 5, `sala: bem abaixo dos -45 fixos (${room.toFixed(1)})`);
    assert.equal(thr(15.0), LOCAL_FLOOR_EDGE.minThresholdDb, "estúdio quieto: o limiar não desce de -60");
    assert.equal(thr(25.0), FIXED, "sala ruidosa (piso perto da fala): fica no fixo, nunca acima");
  });

  it("sem áudio medido em volta (fora do envelope), o fixo", () => {
    const { env } = synth(5, [[1.0, 2.0, -24]]);
    assert.equal(localFloorDb(env, 100), null);
    assert.equal(localEdgeThreshold(env, FIXED)(100), FIXED);
  });
});

describe("#13194 cauda acima do piso local não pode ser cortada", () => {
  it("verify-xml: a cauda a -47 dBFS sobre piso de -55 é SOM CORTADO no limiar relativo (o fixo de -45 não via)", () => {
    const { env, level } = synth(10, CAIR);
    const cs = [clip(1.9, OUT)];
    assert.equal(edgeFindings(tl(cs), FPS, level, FIXED)[0].cutOut, false, "reproduz o bug: o -45 fixo não acusa a cauda de \"cair\"");
    const e = edgeFindings(tl(cs), FPS, level, localEdgeThreshold(env, FIXED))[0];
    assert.equal(e.cutOut, true, "relativo ao piso local: acusa");
    assert.ok(e.thrOutDb < -50, `limiar da borda no relatório (${e.thrOutDb.toFixed(1)})`);
    assert.match(edgeLine(e, (s) => s.toFixed(2)), /depois da saída -4\d dB ← SOM CORTADO \(limiar -5\d dB\)/);
  });

  it("build: a saída abre até depois da cauda, no piso, e o verify relativo zera a borda", () => {
    const { env, level } = synth(10, CAIR);
    const thr = localEdgeThreshold(env, FIXED);
    const r = openCutSoundEdges([clip(1.9, OUT)], FPS, level, thr, { durationS: 10 });
    assert.equal(r.opened.length, 1);
    assert.equal(r.opened[0].edge, "out");
    assert.ok(r.clips[0].srcOut >= 5.15, `saída depois da cauda (${r.clips[0].srcOut})`);
    assert.ok(r.clips[0].srcOut < 5.3, `e não muito além dela (${r.clips[0].srcOut})`);
    assert.ok(r.opened[0].thresholdDb < -50);
    assert.deepEqual(r.unresolved, []);
    assert.equal(edgeFindings(tl(r.clips), FPS, level, thr).filter((x) => x.cutIn || x.cutOut).length, 0);
  });

  it("entrada, por simetria: o ataque a -47 dBFS antes do item abre para trás", () => {
    const { env, level } = synth(10, [[3.88, 4.0, -47], [4.0, 6.0, -24]]);
    const r = openCutSoundEdges([clip(4.0, 6.2)], FPS, level, localEdgeThreshold(env, FIXED), { durationS: 10 });
    assert.equal(r.opened.length, 1);
    assert.equal(r.opened[0].edge, "in");
    assert.ok(r.clips[0].srcIn <= 3.88 && r.clips[0].srcIn > 3.75, `entrada antes do ataque (${r.clips[0].srcIn})`);
  });

  it("openCutEdgesOfPlan (o refino do build) usa o piso local sozinho a partir do limiar fixo", () => {
    const source: SourceInfo = { path: "G:/x/bruto.mp4", fps: FPS, durationS: 10, width: 1920, height: 1080, mirrored: false };
    const { env } = synth(10, [...CAIR, [7.0, 8.0, -24]]);
    const planned: PlannedClip[] = assembleClips(
      { scales: [100, 115] as [number, number] },
      [
        { block: "comentario" as const, srcIn: 1.9, srcOut: OUT, script: "veja como não cair" },
        { block: "comentario" as const, srcIn: 6.9, srcOut: 8.1, script: "outra frase" },
      ],
      FPS,
    ).clips;
    const words = [w("Veja", 2.0, 2.5), w("cair.", 4.5, 5.0), w("outra", 7.0, 7.4), w("frase", 7.5, 8.0)];
    const r = openCutEdgesOfPlan(planned, env, FIXED, source, words, null);
    assert.equal(r.adjustments.length, 1);
    assert.equal(r.adjustments[0].edge, "out");
    assert.ok(r.adjustments[0].to >= 5.15, `saída depois da cauda (${r.adjustments[0].to})`);
    assert.match(r.adjustments[0].reason, /limiar -5\d dB, piso local \+ 3 dB\): aberto até o silêncio/);
    assert.deepEqual(r.warnings, []);
  });
});

describe("#13194 sala ruidosa: o limiar relativo nunca estica a borda além do teto", () => {
  it("ruído que nunca cai ao piso + 3 dB: a borda fica onde estava e vira pendência (não anda maxOpenS)", () => {
    // piso -55, mas rajadas de -48 a cada 50 ms (gate da sala abrindo): nenhum trecho de 40 ms abaixo do limiar
    const { env, level } = synth(10, CAIR, (t) => (Math.floor(t / 0.05) % 2 === 0 ? -55 : -48));
    const thr = localEdgeThreshold(env, FIXED);
    const r = openCutSoundEdges([clip(1.9, OUT)], FPS, level, thr, { durationS: 10 });
    assert.equal(r.clips[0].frameOut, 151, "a saída não se mexe");
    assert.equal(r.clips[0].frameIn, Math.round(1.9 * FPS), "nem a entrada (também no ruído)");
    assert.deepEqual(r.opened, []);
    assert.ok(r.unresolved.some((u) => u.edge === "out"), "e o verify-xml segue acusando a saída");
  });

  it("silêncio só depois do teto (`CUT_EDGE_OPEN.maxS`): não abre", () => {
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.0, 5.0 + CUT_EDGE_OPEN.maxS + 0.2, -47]]);
    const r = openCutSoundEdges([clip(1.9, OUT)], FPS, level, localEdgeThreshold(env, FIXED), { durationS: 10 });
    assert.deepEqual(r.opened, []);
    assert.equal(r.clips[0].frameOut, 151);
  });

  it("palavra vizinha de fora: a abertura entra no máximo NEIGHBOR_WORD_GRACE_S no tempo dela (a cauda que o Whisper deu a ela)", () => {
    // 261117, clipe 43: o Whisper começou "No" em 941,40, em cima da cauda de "ele." (até ~941,53)
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.0, 5.1, -47], [6.0, 6.5, -24]]);
    const thr = localEdgeThreshold(env, FIXED);
    const words = [w("No", OUT + 0.005, 6.5)];
    const blocked = openCutSoundEdges([clip(1.9, OUT)], FPS, level, thr, { durationS: 10, words, maxOpenS: 0.6 });
    assert.equal(blocked.opened.length, 1, "a cauda dentro do tempo do Whisper da palavra seguinte abre");
    assert.ok(blocked.clips[0].srcOut <= OUT + 0.005 + NEIGHBOR_WORD_GRACE_S + 1e-6, `até a folga (${blocked.clips[0].srcOut})`);
    // palavra vizinha com som de verdade emendado: além da folga não abre
    const glued = synth(10, [[2.0, 5.0, -24], [5.0, 5.5, -40]]);
    const g = openCutSoundEdges([clip(1.9, OUT)], FPS, glued.level, localEdgeThreshold(glued.env, FIXED), { durationS: 10, words: [w("No", OUT + 0.005, 5.5)] });
    assert.deepEqual(g.opened, [], "não atravessa a palavra vizinha que soa");
    assert.equal(g.unresolved.length, 1);
  });

  it("palavra vizinha curta: a folga nunca passa de metade dela", () => {
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.0, 5.2, -47]]);
    const r = openCutSoundEdges([clip(1.9, OUT)], FPS, level, localEdgeThreshold(env, FIXED), { durationS: 10, words: [w("e", OUT + 0.005, OUT + 0.085)] });
    assert.deepEqual(r.opened, [], "\"e\" de 80 ms: folga de 40 ms, sem silêncio até lá");
  });
});
