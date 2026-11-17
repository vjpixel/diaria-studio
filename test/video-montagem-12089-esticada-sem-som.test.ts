/**
 * test/video-montagem-12089-esticada-sem-som.test.ts — #12089, medição da
 * 261116 (XML gerado × final exportado, dados do Neo).
 *
 * As pausas longas que sobravam no XML com o detector de fala vinham de
 * palavras que o Whisper esticou por cima da pausa com menos da metade em
 * ilhas ("e" de 30,34 a 31,62 s, "que" de 1014,43 a 1015,53 s): a proteção de
 * palavra devolvia a pausa inteira (0,5 a 0,9 s) mesmo sem som nenhum nela.
 * Num trecho do bruto, o "silêncio" era um zumbido de -52 dB (piso global
 * -79 dB), por isso o som é medido contra o piso LOCAL. Também: o build passa
 * a avisar a pausa longa dentro de um clipe, não só na emenda.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSequencePlan, type ResolvedItem, type SourceInfo, type Word } from "../scripts/lib/diaria/video-montage.ts";
import {
  SPEECH_DETECT,
  SPEECH_DETECT_PLAN,
  extendIslandAttacks,
  pauseSpanHasSound,
  protectTranscribedWords,
  speechIslands,
  speechJoinWarnings,
  speechPauseSilences,
  type FrameEnergy,
} from "../scripts/lib/diaria/video-cut-refine.ts";

const HOP = 0.005;
const FPS = 30;
const SOURCE: SourceInfo = { path: "G:/x/bruto.mp4", fps: FPS, durationS: 600, width: 3840, height: 2160, mirrored: true };
const SPEC = { target: "youtube" as const, name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario" as const], scales: [60, 85] as [number, number] };

/** Envelope de 5 ms: piso `floorDb` (cheio) / `floorDb - 8` (1ª diferença), e `segs` = [início, fim, dB cheio, voz?, dB da 1ª diferença?]. */
function envelope(durationS: number, segs: Array<[number, number, number, boolean, number?]>, floorDb = -79): FrameEnergy {
  const n = Math.round(durationS / HOP);
  const fullDb = new Float64Array(n).fill(floorDb);
  const diffDb = new Float64Array(n).fill(floorDb - 8);
  const voiced = new Uint8Array(n);
  for (const [a, b, full, v, diff] of segs) {
    for (let i = Math.round(a / HOP); i < Math.round(b / HOP); i++) {
      fullDb[i] = full;
      diffDb[i] = diff ?? full - 12;
      voiced[i] = v ? 1 : 0;
    }
  }
  return { hopS: HOP, fullDb, diffDb, voiced };
}

const item = (start: number, end: number, text: string, words: Word[] = []): ResolvedItem => ({
  interval: { start, end },
  text,
  words,
  lastWordEnd: words.length ? words[words.length - 1].end : null,
  holdLimit: end,
  how: "explicit",
});

describe("#12089 (261116): pauseSpanHasSound mede contra o piso local", () => {
  it("trecho no piso: sem som", () => {
    const e = envelope(10, [[1, 3, -20, true], [5, 7, -20, true]]);
    assert.equal(pauseSpanHasSound(e, 3.2, 4.8), false);
  });

  it("80 ms a 20 dB do piso no meio da pausa (fala dita baixo): som", () => {
    const e = envelope(10, [[1, 3, -20, true], [3.9, 3.98, -59, true], [5, 7, -20, true]]);
    assert.equal(pauseSpanHasSound(e, 3.2, 4.8), true);
  });

  it("estalo de 30 ms (abaixo de protectStretchSoundS): sem som", () => {
    const e = envelope(10, [[1, 3, -20, true], [3.9, 3.93, -40, false], [5, 7, -20, true]]);
    assert.equal(pauseSpanHasSound(e, 3.2, 4.8), false);
  });

  it("zumbido de -52 dB num trecho do bruto com piso global de -79 dB (o gancho da 261116): sem som", () => {
    // De 0 a 10 s o bruto tem zumbido (-52/-56 dB no cheio, -78 na 1ª diferença); fala a -25 dB.
    const segs: Array<[number, number, number, boolean, number?]> = [];
    for (let t = 0; t < 10; t += 0.04) segs.push([t, t + 0.02, -52, false, -78], [t + 0.02, t + 0.04, -56, false, -80]);
    segs.push([1, 3, -25, true, -45], [5, 7, -25, true, -45]);
    const e = envelope(60, segs);
    assert.equal(pauseSpanHasSound(e, 3.2, 4.8), false, "o zumbido é o piso daquele trecho, não fala");
  });
});

describe("#12089 (261116): palavra esticada sobre pausa sem som não devolve a pausa", () => {
  // Ilhas de 1 a 3 s e de 3,9 a 6 s; o "e" do Whisper vai de 2,8 a 4,08 s: 0,38 s dos 1,28 s em ilhas (30%), 0,58 s na pausa.
  const islands = [{ start: 1, end: 3 }, { start: 3.9, end: 6 }];
  const pauses = speechPauseSilences(islands, 10);
  const words: Word[] = [{ start: 2.8, end: 4.08, text: "e" }];

  it("sem a energia (a regra de antes): o \"e\" segue protegido e a pausa volta", () => {
    const g = protectTranscribedWords(pauses, words, { islands });
    assert.deepEqual(g.protectedWords.map((w) => w.text), ["e"]);
    assert.notDeepEqual(g.silences, pauses);
  });

  it("com a energia e a pausa no piso: perde a proteção, sai em stretchedWords e a pausa sai inteira", () => {
    const e = envelope(10, [[1, 3, -20, true], [3.9, 6, -20, true]]);
    const g = protectTranscribedWords(pauses, words, { islands, energy: e });
    assert.deepEqual(g.protectedWords, []);
    assert.deepEqual(g.stretchedWords.map((w) => w.text), ["e"]);
    assert.deepEqual(g.silences, pauses);
  });

  it("com som baixo na pausa (o \"e\" dito baixo de verdade): segue protegido", () => {
    const e = envelope(10, [[1, 3, -20, true], [3.4, 3.55, -58, true], [3.9, 6, -20, true]]);
    const g = protectTranscribedWords(pauses, words, { islands, energy: e });
    assert.deepEqual(g.protectedWords.map((w) => w.text), ["e"]);
    assert.deepEqual(g.stretchedWords, []);
  });

  it("palavra sem nenhum trecho em ilha (o \"e\" sussurrado da PR #12142) segue protegida mesmo sem som", () => {
    const e = envelope(10, [[1, 3, -20, true], [3.9, 6, -20, true]]);
    const g = protectTranscribedWords(pauses, [{ start: 3.3, end: 3.5, text: "e" }], { islands, energy: e });
    assert.deepEqual(g.protectedWords.map((w) => w.text), ["e"]);
  });

  it("no plano: a pausa de 0,9 s entre as ilhas fica com as folgas (150 + 120 ms), sem palavra perdida", () => {
    const e = envelope(10, [[1, 3, -20, true], [3.9, 6, -20, true]]);
    const all: Word[] = [{ start: 1, end: 2.8, text: "Fala" }, ...words, { start: 4.08, end: 6, text: "outra." }];
    const sil = protectTranscribedWords(pauses, all, { islands, energy: e }).silences;
    const plan = buildSequencePlan(SPEC, { comentario: [item(0.8, 6.2, "Fala e outra.", all)] }, sil, SOURCE, SPEECH_DETECT_PLAN);
    assert.deepEqual(plan.dropped, []);
    assert.equal(plan.lostWords, undefined);
    assert.equal(plan.clips.length, 2, JSON.stringify(plan.clips.map((c) => [c.frameIn / FPS, c.frameOut / FPS])));
    const left = 3 - plan.clips[0].frameOut / FPS;
    const right = 3.9 - plan.clips[1].frameIn / FPS;
    assert.ok(left + right <= SPEECH_DETECT.padAfterS + SPEECH_DETECT.padBeforeS + 2 / FPS + 1e-9, `sobra ${(left + right).toFixed(3)} s`);
  });
});

describe("#12089: o envelope da issue (piso -39, respiração -30 a 0,4 s do ataque, fala -8)", () => {
  it("a entrada fica a no máximo 150 ms (+1 quadro) do ataque, nunca no ar da respiração", () => {
    // Folga de 150 ms pela correção do editor na 261104 (comentário de 04/11, substitui os 80–100 ms do corpo da issue).
    const e = envelope(12, [[1.6, 1.8, -30, false, -40], [2, 4, -8, true], [5, 7, -8, true], [8, 10, -8, true]], -39);
    const islands = extendIslandAttacks(e, speechIslands(e));
    const sil = speechPauseSilences(islands, 12);
    const plan = buildSequencePlan(SPEC, { comentario: [item(1.0, 4.3, "Fala.", [{ start: 2, end: 4, text: "Fala." }])] }, sil, SOURCE, SPEECH_DETECT_PLAN);
    assert.equal(plan.clips.length, 1);
    const inS = plan.clips[0].frameIn / FPS;
    assert.ok(2 - inS <= SPEECH_DETECT.padBeforeS + 1 / FPS + 1e-9, `entrada ${inS}`);
    assert.ok(inS >= 1.8, `entrada ${inS} no ar da respiração`);
  });

  it("vogal curta com voz (40 ms a -26 dB) antes de um vale e do ataque: a entrada fica antes da vogal", () => {
    const e = envelope(12, [[1.9, 1.94, -26, true, -38], [2.1, 4, -8, true], [5, 7, -8, true], [8, 10, -8, true]], -39);
    const islands = extendIslandAttacks(e, speechIslands(e));
    const sil = speechPauseSilences(islands, 12);
    const plan = buildSequencePlan(SPEC, { comentario: [item(1.0, 4.3, "A empresa.", [{ start: 1.9, end: 1.94, text: "A" }, { start: 2.1, end: 4, text: "empresa." }])] }, sil, SOURCE, SPEECH_DETECT_PLAN);
    assert.equal(plan.clips.length, 1);
    assert.ok(plan.clips[0].frameIn / FPS <= 1.9 + 1e-9, `entrada ${plan.clips[0].frameIn / FPS} depois da vogal`);
  });
});

describe("#12089 (261116): aviso de pausa longa dentro do clipe", () => {
  const islands = [{ start: 1, end: 3 }, { start: 3.86, end: 6 }];
  const clip = (a: number, b: number, seqStart = 0) => ({ block: "comentario", frameIn: Math.round(a * FPS), frameOut: Math.round(b * FPS), seqStart });

  it("0,86 s entre duas ilhas no mesmo clipe: avisa com o tempo na sequência e no bruto", () => {
    const w = speechJoinWarnings([clip(0.85, 6.12, 30)], islands, FPS);
    const hit = w.filter((x) => x.includes("dentro do clipe"));
    assert.equal(hit.length, 1, JSON.stringify(w));
    // Entrada no quadro 26 (0,867 s) e o clipe começa a 1 s da sequência: a pausa (3,00 s do bruto) cai em 3,13 s dela.
    assert.match(hit[0], /pausa de 0\.86 s dentro do clipe em 3\.13 s da sequência \(bruto 3\.00–3\.86 s/);
  });

  it("pausa já cortada (dois clipes) ou curta: sem aviso de pausa interna", () => {
    const cut = speechJoinWarnings([clip(0.85, 3.12, 0), clip(3.71, 6.12, 68)], islands, FPS);
    assert.ok(!cut.some((x) => x.includes("dentro do clipe")), JSON.stringify(cut));
    const short = speechJoinWarnings([clip(0.85, 6.12)], [{ start: 1, end: 3 }, { start: 3.3, end: 6 }], FPS);
    assert.ok(!short.some((x) => x.includes("dentro do clipe")), JSON.stringify(short));
  });
});
