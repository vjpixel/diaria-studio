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
import { edgeWindowsFor, energyEnvelope, maxDbIn } from "../scripts/lib/diaria/video-cut-refine.ts";
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
  softEdgeWarnings,
  SUSTAINED_EDGE,
  type OpenableClip,
} from "../scripts/lib/diaria/video-xml-verify.ts";
import { openCutEdgesOfPlan, verifyEdgeContext, verifyEdgeWords } from "../scripts/video-montagem.ts";

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
    // piso -55, mas rajadas de -49 a cada 50 ms (gate da sala abrindo): nenhum trecho de 40 ms abaixo do limiar, e nada acima do -45 fixo
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.0, 5.15, -51]], (t) => (Math.floor(t / 0.05) % 2 === 0 ? -55 : -49));
    const thr = localEdgeThreshold(env, FIXED);
    const r = openCutSoundEdges([clip(1.9, OUT)], FPS, level, thr, { durationS: 10 });
    assert.equal(r.clips[0].frameOut, 151, "a saída não se mexe");
    assert.equal(r.clips[0].frameIn, Math.round(1.9 * FPS), "nem a entrada (também no ruído)");
    assert.deepEqual(r.opened, []);
    const out = r.unresolved.find((u) => u.edge === "out");
    assert.ok(out, "a saída fica pendente no build");
    assert.equal(out.error, false, "rajadas sem silêncio até o teto: aviso, não erro do verify-xml");
    const e = edgeFindings(tl(r.clips), FPS, level, thr)[0];
    assert.equal(e.cutOut, false);
    assert.equal(e.softOut, true);
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

describe("#13194 verify-xml: ruído em rajada é aviso, cauda sustentada é SOM CORTADO", () => {
  it("rajada curta (30 ms) de ruído logo fora da borda: aviso com limiar e duração, sem erro", () => {
    // fala até 5,0 s; a saída em 5,033 s; um estalo de 30 ms a -47 dBFS em 5,04 s e depois a sala a -55
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.04, 5.07, -47]]);
    const e = edgeFindings(tl([clip(1.9, OUT)]), FPS, level, localEdgeThreshold(env, FIXED))[0];
    assert.equal(e.overOut, true, "passa do limiar relativo");
    assert.equal(e.cutOut, false, "mas não é sustentado: não é SOM CORTADO");
    assert.equal(e.softOut, true);
    assert.ok(e.aboveOutS < SUSTAINED_EDGE.minS, `duração acima do limiar (${e.aboveOutS})`);
    const warns = softEdgeWarnings([e], (s) => s.toFixed(2));
    assert.equal(warns.length, 1);
    assert.match(warns[0], /saída em 5\.03 com -4\d dB fora: curta: \d+ ms acima do limiar -5\d dB/);
    assert.match(edgeLine(e, (s) => s.toFixed(2)), /\[aviso\] curta, \d+ ms acima do limiar -5\d dB/);
    assert.equal(e.softReasonOut, "curta");
    assert.equal(e.openOut, false, "estalo não é fala: o build não abre");
  });

  it("cauda sustentada (150 ms) acima do piso local: SOM CORTADO", () => {
    const { env, level } = synth(10, CAIR);
    const e = edgeFindings(tl([clip(1.9, OUT)]), FPS, level, localEdgeThreshold(env, FIXED))[0];
    assert.equal(e.cutOut, true);
    assert.equal(e.softOut, false);
    assert.ok(e.aboveOutS >= SUSTAINED_EDGE.minS, `sustentada (${e.aboveOutS})`);
  });

  it("acima do -45 fixo segue erro mesmo curto (não afrouxa o que já se pegava)", () => {
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.04, 5.07, -30]]);
    const e = edgeFindings(tl([clip(1.9, OUT)]), FPS, level, localEdgeThreshold(env, FIXED))[0];
    assert.ok(e.afterDb > FIXED);
    assert.equal(e.cutOut, true);
  });
});

describe("#13194 filler da vinheta e limites do build no verify-xml", () => {
  it("filler ao lado de uma cauda de -48: só o limiar fixo vale, a regra relativa não o abre nem dá SOM CORTADO", () => {
    // a pausa da vinheta (#13239) começa em 5,6 s, encostada numa cauda de -48 dBFS (5,5 a 5,6 s) com silêncio antes
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.5, 5.6, -48]]);
    const thr = localEdgeThreshold(env, FIXED);
    const filler: OpenableClip = { ...clip(5.6, 6.0, "vinheta"), filler: true };
    const asSpeech = openCutSoundEdges([{ ...filler, filler: false }], FPS, level, thr, { durationS: 10 });
    assert.equal(asSpeech.opened.length, 1, "pré-condição: sem o flag, a regra nova abriria a entrada do filler");
    const e = edgeFindings(tl([filler]), FPS, level, thr, { fixedOnly: [true] })[0];
    assert.equal(e.thrInDb, FIXED);
    assert.equal(e.overIn, false);
    assert.equal(e.cutIn, false);
    const r = openCutSoundEdges([filler], FPS, level, thr, { durationS: 10 });
    assert.deepEqual(r.opened, []);
    assert.deepEqual(r.unresolved, []);
    assert.equal(r.clips[0].frameIn, filler.frameIn);
  });

  it("o filler continua limitando o vizinho: a saída da fala não entra nele", () => {
    // V2 com a vinheta logo depois no bruto: a fala sai em 5,033 s com a cauda até 5,15; o filler começa em 5,1
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.0, 5.15, -48]]);
    const filler: OpenableClip = { ...clip(5.1, 5.6, "vinheta"), filler: true };
    const r = openCutSoundEdges([clip(1.9, OUT), filler], FPS, level, localEdgeThreshold(env, FIXED), { durationS: 10 });
    assert.ok(r.clips[0].frameOut <= filler.frameIn, `saída da fala até o filler (${r.clips[0].frameOut} <= ${filler.frameIn})`);
    assert.equal(r.clips[1].frameIn, filler.frameIn, "o filler não se mexe");
  });

  it("verify-xml: cauda emendada com palavra descartada que o build não abriria é aviso, não erro", () => {
    // cauda de -47 até 5,12 s emendada na palavra seguinte (fora do roteiro) até 5,5; silêncio só depois dela
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.0, 5.12, -47], [5.12, 5.5, -30]]);
    const thr = localEdgeThreshold(env, FIXED);
    const cs = [clip(1.9, OUT)];
    const blind = edgeFindings(tl(cs), FPS, level, thr)[0];
    assert.equal(blind.cutOut, true, "pré-condição: sem a palavra, o verify contava com abrir até depois dela");
    const ctx = { words: [w("outra", OUT + 0.005, 5.5)] };
    const e = edgeFindings(tl(cs), FPS, level, thr, ctx)[0];
    assert.equal(e.cutOut, false, "o build pararia na palavra (com a folga de 0,15 s): não é erro");
    assert.equal(e.softOut, true, "fica como aviso");
    const r = openCutSoundEdges(cs, FPS, level, thr, { durationS: 10, words: ctx.words });
    assert.deepEqual(r.opened, [], "e o build de fato não abre");
    assert.equal(r.unresolved[0]?.error, false);
    assert.equal(e.softReasonOut, "sem-abertura", "sustentada, mas sem abertura: provável fala cortada");
    assert.equal(e.limitOut, "palavra vizinha", "nomeia o limite");
    assert.ok(Math.abs(e.limitOutS! - (OUT + 0.005 + NEIGHBOR_WORD_GRACE_S)) < 1e-6);
    assert.match(softEdgeWarnings([e], (x) => x.toFixed(2))[0], /sem-abertura: .*limite da abertura \(palavra vizinha em 5\.19\); provável fala cortada, conferir no Premiere/);
    assert.equal(r.unresolved[0]?.limit, "palavra vizinha");
  });
});

describe("#13194 filler sem regressão: acima do -45 fixo segue abrindo como antes", () => {
  it("filler encostado numa cauda acima de -45 é aberto até o silêncio (regra antiga)", () => {
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.5, 5.6, -40]]);
    const filler: OpenableClip = { ...clip(5.6, 6.0, "vinheta"), filler: true };
    const r = openCutSoundEdges([filler], FPS, level, localEdgeThreshold(env, FIXED), { durationS: 10 });
    assert.equal(r.opened.length, 1, "acima do fixo: abre, como antes da PR");
    assert.equal(r.opened[0].edge, "in");
    assert.equal(r.opened[0].thresholdDb, FIXED, "no limiar fixo, não no relativo");
    assert.ok(r.clips[0].srcIn <= 5.5, `entrada antes da cauda (${r.clips[0].srcIn})`);
    assert.deepEqual(r.unresolved, []);
  });
});

/** Limiar relativo fixo em -52 sobre o fixo de -45, sem envelope: a duração acima dele é exata (passos de 10 ms). */
const REL = Object.assign(() => -52, { fixedDb: FIXED });
/** Energia: fala até 5,0 s, cauda a -47 de 5,0 a `tailEnd`, sala a -55 depois. */
const stepLevel = (tailEnd: number) => (a: number, _b: number) => (a < 5.0 - 1e-9 ? -24 : a < tailEnd - 1e-9 ? -47 : -55);

describe("#13194 fronteira da energia sustentada (60 ms)", () => {
  it("~50 ms acima do relativo: aviso curta; 75 ms: SOM CORTADO", () => {
    const c = [{ start: 0, end: 0, in: 57, out: 150, fileId: "file-1", gIn: 57, gOut: 150 }];
    // a saída em 5,0 s (quadro 150); `aboveS` = cauda em passos de 10 ms menos 15 ms do envelope
    // 7 passos acima (5,00 a 5,06) menos 15 ms = 55 ms, logo abaixo dos 60 ms
    const short = edgeFindings(c, FPS, stepLevel(5.065), REL)[0];
    assert.ok(short.aboveOutS >= 0.045 && short.aboveOutS < SUSTAINED_EDGE.minS, `~50 ms (${short.aboveOutS})`);
    assert.equal(short.cutOut, false);
    assert.equal(short.softReasonOut, "curta");
    // 9 passos acima (5,00 a 5,08) menos 15 ms = 75 ms
    const long = edgeFindings(c, FPS, stepLevel(5.085), REL)[0];
    assert.ok(Math.abs(long.aboveOutS - 0.075) < 1e-6, `75 ms (${long.aboveOutS})`);
    assert.equal(long.cutOut, true);
    assert.equal(long.openOut, true);
  });
});

describe("#13194 o build só abre por fala: estalo e respiro curto ficam", () => {
  it("estalo de 30 ms a -47 em sala de -55: o build não abre", () => {
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.04, 5.07, -47]]);
    const r = openCutSoundEdges([clip(1.9, OUT)], FPS, level, localEdgeThreshold(env, FIXED), { durationS: 10 });
    assert.deepEqual(r.opened, []);
    assert.deepEqual(r.unresolved, [], "curta não é pendência do build (o verify-xml avisa)");
  });

  it("bruto quieto (piso -85) com respiro curto de -52: o build não abre", () => {
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.05, 5.08, -52]], -85);
    const thr = localEdgeThreshold(env, FIXED);
    assert.equal(thr(5.0), LOCAL_FLOOR_EDGE.minThresholdDb, "limiar no piso mínimo de -60");
    const r = openCutSoundEdges([clip(1.9, OUT)], FPS, level, thr, { durationS: 10 });
    assert.deepEqual(r.opened, []);
  });

  it("controle: montagem normal com as bordas no silêncio não abre nada", () => {
    const { env, level } = synth(12, [[2.0, 4.0, -24], [6.0, 8.0, -24]]);
    const r = openCutSoundEdges([clip(1.85, 4.15), clip(5.85, 8.15)], FPS, level, localEdgeThreshold(env, FIXED), { durationS: 12 });
    assert.deepEqual(r.opened, []);
    assert.deepEqual(r.unresolved, []);
  });

  it("palavra vizinha que começa com um vale de ~50 ms (oclusão de um \"t\"): não abre e vira aviso sem-abertura (comportamento documentado)", () => {
    // cauda de -47 até 5,1; o Whisper deu a "Tem" o tempo desde a borda, mas o som dela só vem em 5,15 (vale de 50 ms).
    // O envelope (30 ms) estica as duas pontas do vale: sobram ~20 ms abaixo do limiar, menos que a janela de 40 ms.
    // Então o vale não conta como silêncio, a abertura não acha onde parar antes do limite (palavra + 0,15 s) e a
    // borda fica: nada do som de "Tem" entra, e o verify-xml avisa sem-abertura (provável fala cortada).
    const { env, level } = synth(10, [[2.0, 5.0, -24], [5.0, 5.1, -47], [5.15, 5.6, -30]]);
    const r = openCutSoundEdges([clip(1.9, OUT)], FPS, level, localEdgeThreshold(env, FIXED), { durationS: 10, words: [w("Tem", OUT + 0.005, 5.6)] });
    assert.deepEqual(r.opened, []);
    assert.equal(r.clips[0].frameOut, 151);
    assert.equal(r.unresolved.length, 1);
    assert.equal(r.unresolved[0].error, false);
    assert.equal(r.unresolved[0].limit, "palavra vizinha");
  });
});

describe("#13194 filler pelo openCutEdgesOfPlan (PlannedClip)", () => {
  const source: SourceInfo = { path: "G:/x/bruto.mp4", fps: FPS, durationS: 10, width: 1920, height: 1080, mirrored: false };
  const plannedWithFiller = () =>
    assembleClips(
      { scales: [100, 115] as [number, number] },
      [
        { block: "comentario" as const, srcIn: 1.9, srcOut: OUT, script: "veja como não cair" },
        { block: "comentario" as const, srcIn: 5.6, srcOut: 6.0, filler: true as const },
      ],
      FPS,
    ).clips;

  it("cauda de -48 encostada no filler: não abre", () => {
    const { env } = synth(10, [[2.0, 5.0, -24], [5.5, 5.6, -48]]);
    const clips = plannedWithFiller();
    assert.equal(clips[1].filler, true, "pré-condição: o assembleClips mantém o filler");
    const r = openCutEdgesOfPlan(clips, env, FIXED, source, [], null);
    assert.ok(!r.adjustments.some((a) => Math.abs(a.from - 5.6) < 1e-6), "a entrada do filler fica");
  });

  it("cauda acima do fixo encostada no filler: abre como antes do #13194", () => {
    const { env } = synth(10, [[2.0, 5.0, -24], [5.5, 5.6, -40]]);
    const r = openCutEdgesOfPlan(plannedWithFiller(), env, FIXED, source, [], null);
    const a = r.adjustments.find((x) => x.edge === "in" && Math.abs(x.from - 5.6) < 1e-6);
    assert.ok(a, "abre a entrada do filler");
    assert.ok(a.to <= 5.5);
  });
});

describe("#13194 verifyEdgeContext e verifyEdgeWords", () => {
  const plan = {
    clips: [
      { frameIn: 57, frameOut: 151, script: "veja como não cair" },
      { frameIn: 168, frameOut: 180, filler: true as const },
    ],
  };

  it("clipe alinhado com o plano (±1 quadro) leva filler e roteiro; desalinhado com a mesma contagem vira aviso", () => {
    const ok = verifyEdgeContext(plan, [{ gIn: 57, gOut: 152 }, { gIn: 168, gOut: 180 }], { fps: FPS, rate: FPS, words: [], durationS: 10 });
    assert.deepEqual(ok.warnings, []);
    assert.deepEqual(ok.ctx.fixedOnly, [false, true]);
    assert.equal(ok.ctx.ownWord?.(0, "out", { start: 0, end: 0, text: "cair." }), true);
    const off = verifyEdgeContext(plan, [{ gIn: 57, gOut: 151 }, { gIn: 172, gOut: 184 }], { fps: FPS, rate: FPS, words: [], durationS: 10 });
    assert.equal(off.warnings.length, 1);
    assert.match(off.warnings[0], /clipe 2: bordas do XML .* diferentes das do plano/);
    assert.deepEqual(off.ctx.fixedOnly, [false, false], "o filler do plano não vale no clipe desalinhado");
    const count = verifyEdgeContext(plan, [{ gIn: 57, gOut: 151 }], { fps: FPS, rate: FPS, words: [], durationS: 10 });
    assert.match(count.warnings[0], /1 clipes no XML, 2 no plano/);
  });

  it("palavras: transcript + só as janelas do plano atual do cache do MESMO audio.wav; o resto vira aviso, sem abortar", () => {
    const planClips = [{ srcIn: 1.9, srcOut: OUT }];
    const keys = edgeWindowsFor(planClips[0], 10).map((x) => x.key);
    const audio = { size: 1000, mtimeMs: 1794840358425.008 };
    // formato real do edge-retranscribe.json: { audio: { size, mtimeMs }, windows: { "a-b": Word[] } }
    const cache = { audio: { ...audio }, windows: { [keys[0]]: [w("veja", 1.95, 2.2)], "7.000-8.000": [w("velha", 7.1, 7.5)] } };
    const ok = verifyEdgeWords({ transcript: [w("cair.", 4.5, 5.0)], cache, audio, planClips, durationS: 10 });
    assert.deepEqual(ok.warnings, []);
    assert.deepEqual(ok.words.map((x) => x.text), ["cair.", "veja"], "a janela de outro plano fica de fora");
    const other = verifyEdgeWords({ transcript: [w("cair.", 4.5, 5.0)], cache, audio: { size: 1000, mtimeMs: 1 }, planClips, durationS: 10 });
    assert.deepEqual(other.words.map((x) => x.text), ["cair."]);
    assert.match(other.warnings[0], /de outro audio\.wav/);
    const none = verifyEdgeWords({ transcript: null, cache: null, audio, planClips, durationS: 10 });
    assert.deepEqual(none.words, []);
    assert.equal(none.warnings.length, 2);
    assert.match(none.warnings[0], /limites de palavra do build não aplicados/);
    const empty = verifyEdgeWords({ transcript: [], cache: { audio }, audio, planClips, durationS: 10 });
    assert.equal(empty.warnings.length, 2, "transcript vazio e cache sem windows: dois avisos");
  });
});
