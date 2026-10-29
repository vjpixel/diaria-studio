/**
 * #11500 — refino dos cortes pelo áudio do bruto, em toda montagem.
 *
 * O ajuste manual da 261029 (tabela da issue) achou, nos cortes que saíram dos
 * tempos do Whisper: corte em plena fala, corte na cauda da palavra, hesitação
 * "a," fora do roteiro na borda (o Whisper esticou "junto" por cima dela:
 * 573,11–573,91 s; a retranscrição sem VAD ouviu "a," e "junto" em 573,6 s),
 * cauda depois de "anos," e sobreposição entre clipes contíguos. Áudio
 * sintético aqui: trechos de "fala" (tom de -14 dBFS) e silêncio (-66 dBFS),
 * limiar -34 dB (o da 261029).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CUT_REFINE,
  dbAt,
  edgeExtras,
  edgeWindowsFor,
  energyEnvelope,
  parseWavPcm16,
  snapClipEdges,
  snapToValley,
  speechCutWarnings,
  trimEdgeExtras,
  type Envelope,
} from "../scripts/lib/diaria/video-cut-refine.ts";
import { assembleClips, defaultSequences, makeMatcher, type RawClip, type Word } from "../scripts/lib/diaria/video-montage.ts";

const SR = 16000;
const TH = -34;

/** WAV PCM 16 bits mono com fala (tom) nos intervalos dados e quase-silêncio no resto. */
function wav(durationS: number, speech: Array<[number, number]>, opts: { channels?: number; extraChunk?: boolean } = {}): Buffer {
  const ch = opts.channels ?? 1;
  const n = Math.round(durationS * SR);
  const data = Buffer.alloc(n * 2 * ch);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const loud = speech.some(([a, b]) => t >= a && t < b);
    const amp = loud ? 0.28 : 0.0007;
    const v = Math.round(amp * 32767 * Math.sin(2 * Math.PI * 220 * t));
    for (let c = 0; c < ch; c++) data.writeInt16LE(v, 2 * (i * ch + c));
  }
  const extra = opts.extraChunk ? Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]) : Buffer.alloc(0);
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(ch, 10);
  fmt.writeUInt32LE(SR, 12);
  fmt.writeUInt32LE(SR * 2 * ch, 16);
  fmt.writeUInt16LE(2 * ch, 20);
  fmt.writeUInt16LE(16, 22);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0);
  head.writeUInt32LE(4 + fmt.length + extra.length + 8 + data.length, 4);
  head.write("WAVE", 8);
  const dh = Buffer.alloc(8);
  dh.write("data", 0);
  dh.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, fmt, extra, dh, data]);
}

function envOf(durationS: number, speech: Array<[number, number]>): Envelope {
  const { samples, sampleRate } = parseWavPcm16(wav(durationS, speech));
  return energyEnvelope(samples, sampleRate);
}

const w = (start: number, end: number, text: string): Word => ({ start, end, text });

describe("áudio: WAV e envelope de energia (#11500)", () => {
  it("lê o WAV do ffmpeg (com chunk LIST no meio) e mistura estéreo para mono", () => {
    const mono = parseWavPcm16(wav(0.5, [[0, 0.5]], { extraChunk: true }));
    assert.equal(mono.sampleRate, SR);
    assert.equal(mono.samples.length, SR / 2);
    const st = parseWavPcm16(wav(0.5, [[0, 0.5]], { channels: 2 }));
    assert.equal(st.samples.length, SR / 2);
    assert.throws(() => parseWavPcm16(Buffer.from("not a wav file")), /não é WAV/);
  });

  it("fala acima do limiar + 15 dB, silêncio abaixo do limiar", () => {
    const env = envOf(2, [[0.5, 1.5]]);
    assert.ok(dbAt(env, 1) > TH + CUT_REFINE.speechAboveDb, `fala ${dbAt(env, 1)}`);
    assert.ok(dbAt(env, 0.2) < TH, `silêncio ${dbAt(env, 0.2)}`);
  });
});

describe("passada A: vale de energia mais próximo (#11500 itens 1 e 2)", () => {
  // Fala até 83,62 s; o corte do Whisper em 83,47 cai na cauda ("23 bilhões.").
  const env = envOf(86, [[80, 83.62], [84.4, 86]]);

  it("corte na cauda da palavra vai para o silêncio logo depois", () => {
    const r = snapToValley(env, 83.47, 83.07, 83.87, TH);
    assert.equal(r.how, "vale");
    assert.ok(r.t > 83.62 && r.t < 83.7, `t ${r.t}`);
  });

  it("corte já no silêncio fica", () => {
    assert.deepEqual(snapToValley(env, 84, 83.6, 84.4, TH), { t: 84, how: "ja-no-silencio" });
  });

  it("sem silêncio na janela e sem queda de energia, o corte fica (e vira aviso de plena fala)", () => {
    const r = snapToValley(env, 81, 80.6, 81.4, TH);
    assert.equal(r.how, "sem-vale");
    const warns = speechCutWarnings([{ block: "comentario", srcIn: 81, srcOut: 84 }], env, TH);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /entrada em 81\.00 s do bruto cai em plena fala/);
  });

  it("snapClipEdges: início em plena fala vai para o vale antes da 1ª palavra, sem passar do meio da vizinha", () => {
    // "Artificial." (fala até 74,10) e "O Plano..." a partir de 74,70: corte do Whisper em 73,88.
    // (O 73,88 → 74,70 da 261029 passa da janela de ±0,4 s: lá quem tira a cauda é a passada B.)
    const env2 = envOf(80, [[72, 74.1], [74.7, 79]]);
    const words = [w(73.455, 73.875, "Artificial."), w(73.875, 75.055, "O"), w(75.055, 75.295, "Plano"), w(75.3, 79, "Brasileiro")];
    const { clips, adjustments } = snapClipEdges([{ block: "comentario", srcIn: 73.88, srcOut: 79.2 }], env2, words, { thresholdDb: TH, durationS: 80 });
    assert.ok(clips[0].srcIn > 74.1 && clips[0].srcIn <= 73.88 + CUT_REFINE.windowS, `srcIn ${clips[0].srcIn}`);
    assert.ok(dbAt(env2, clips[0].srcIn) <= TH);
    assert.ok(clips[0].srcIn < (73.875 + 75.055) / 2, "nunca passa do meio da 1ª palavra do clipe");
    assert.equal(adjustments[0].edge, "in");
    assert.match(adjustments[0].reason, /vale de energia/);
  });
});

describe("passada B: som fora do roteiro na borda (#11500 item 3)", () => {
  const match = makeMatcher();

  it("hesitação 'a,' antes de 'junto' (261029): a entrada vai para o vale antes de 'junto'", () => {
    // Bruto: "anos," até 571,72; hesitação 573,08–573,45; "junto com os modelos" a partir de 573,60.
    const env = envOf(580, [[570, 571.72], [573.08, 573.45], [573.6, 579]]);
    const reference = [w(573.113, 573.913, "junto"), w(573.913, 574.313, "com"), w(574.313, 574.453, "os"), w(574.453, 574.873, "modelos")];
    // A retranscrição esticou a hesitação por cima da pausa, como na 261029.
    const heard = [w(571.36, 571.74, "anos"), w(571.74, 573.28, "a,"), w(573.6, 574.06, "junto"), w(574.06, 574.3, "com"), w(574.3, 574.46, "os"), w(574.46, 574.9, "modelos")];
    const d = edgeExtras({ edge: "in", clip: { srcIn: 573.08, srcOut: 579, script: "Espere nos próximos anos, junto com os modelos" }, heard, reference, env, thresholdDb: TH, match });
    assert.equal(d.extra, "a,");
    assert.ok(d.to !== undefined && d.to >= 573.45 && d.to <= 573.6, `to ${d.to}`);
  });

  it("cauda depois de 'anos,': a saída vai para antes do som a mais", () => {
    const env = envOf(575, [[570, 571.72], [571.76, 572.0]]);
    const reference = [w(569.773, 570.673, "espere"), w(570.673, 570.853, "nos"), w(570.853, 571.313, "próximos"), w(571.313, 571.713, "anos,")];
    const heard = [w(570, 570.68, "Espere"), w(570.68, 570.86, "nos"), w(570.86, 571.36, "próximos"), w(571.36, 571.74, "anos"), w(571.76, 572.0, "a,")];
    const d = edgeExtras({ edge: "out", clip: { srcIn: 569.6, srcOut: 571.9, script: "Espere nos próximos anos, junto com os modelos" }, heard, reference, env, thresholdDb: TH, match });
    assert.equal(d.extra, "a,");
    assert.ok(d.to !== undefined && d.to >= 571.72 && d.to <= 571.76, `to ${d.to}`);
  });

  it("fim de 'Artificial.' da frase anterior no começo do clipe (261029, 73,88 → 74,70 s) sai", () => {
    const env = envOf(80, [[72, 74.2], [74.7, 79]]);
    // O Whisper esticou "O" (73,875–75,055); a retranscrição ouve a cauda de "Artificial." e "O" em 74,7.
    const reference = [w(73.875, 75.055, "O"), w(75.055, 75.295, "Plano"), w(75.295, 75.755, "Brasileiro")];
    const heard = [w(73.46, 74.2, "Artificial."), w(74.7, 74.9, "O"), w(74.9, 75.3, "Plano"), w(75.3, 75.76, "Brasileiro")];
    const d = edgeExtras({ edge: "in", clip: { srcIn: 73.88, srcOut: 79, script: "O Plano Brasileiro de Inteligência Artificial," }, heard, reference, env, thresholdDb: TH, match });
    assert.equal(d.extra, "Artificial.");
    assert.ok(d.to !== undefined && d.to > 74.2 && d.to <= 74.7, `to ${d.to}`);
  });

  it("palavra a mais que é a do roteiro (o transcript longo a engoliu) fica", () => {
    const env = envOf(14, [[10.1, 10.3], [10.6, 13]]);
    const reference = [w(10.6, 11, "junto"), w(11, 11.3, "com"), w(11.3, 11.6, "os")];
    const heard = [w(10.1, 10.3, "E"), w(10.6, 11, "junto"), w(11, 11.3, "com"), w(11.3, 11.6, "os")];
    const d = edgeExtras({ edge: "in", clip: { srcIn: 10, srcOut: 13, script: "E junto com os modelos" }, heard, reference, env, thresholdDb: TH, match });
    assert.equal(d.to, undefined);
    assert.match(d.note ?? "", /é a do roteiro/);
  });

  it("som a mais sem energia de fala (ruído que o Whisper transcreveu) não mexe", () => {
    const env = envOf(14, [[10.6, 13]]);
    const reference = [w(10.6, 11, "junto"), w(11, 11.3, "com")];
    const heard = [w(10.1, 10.4, "Obrigado"), w(10.6, 11, "junto"), w(11, 11.3, "com")];
    assert.deepEqual(edgeExtras({ edge: "in", clip: { srcIn: 10, srcOut: 13 }, heard, reference, env, thresholdDb: TH, match }), {});
  });

  it("retranscrição que casa menos de 2 palavras não decide nada", () => {
    const env = envOf(14, [[10, 13]]);
    const d = edgeExtras({ edge: "in", clip: { srcIn: 10, srcOut: 13 }, heard: [w(10, 10.4, "xis"), w(10.6, 11, "junto")], reference: [w(10.6, 11, "junto"), w(11, 11.3, "com")], env, thresholdDb: TH, match });
    assert.equal(d.to, undefined);
  });

  it("trimEdgeExtras usa a janela da borda e registra o ajuste", () => {
    const env = envOf(580, [[573.08, 573.45], [573.6, 579]]);
    const clip: RawClip = { block: "comentario", srcIn: 573.08, srcOut: 579, script: "junto com os modelos que a gente" };
    const [win] = edgeWindowsFor(clip, 700);
    const words = [w(573.113, 573.913, "junto"), w(573.913, 574.313, "com"), w(574.313, 574.453, "os"), w(574.453, 574.873, "modelos")];
    const heard = new Map([[win.key, [w(571.74, 573.28, "a,"), w(573.6, 574.06, "junto"), w(574.06, 574.3, "com"), w(574.3, 574.46, "os")]]]);
    const r = trimEdgeExtras([clip], heard, words, env, { thresholdDb: TH, durationS: 700, match });
    assert.equal(r.adjustments.length, 1);
    assert.match(r.adjustments[0].reason, /som fora do roteiro na borda: "a,"/);
    assert.ok(r.clips[0].srcIn > 573.45);
  });
});

describe("janelas e emendas depois do refino (#11500 itens 3 e 4)", () => {
  it("clipe curto: uma janela só, cobrindo as duas bordas; longo: uma por borda", () => {
    assert.equal(edgeWindowsFor({ srcIn: 10, srcOut: 12 }, 100).length, 1);
    const two = edgeWindowsFor({ srcIn: 10, srcOut: 30 }, 100);
    assert.equal(two.length, 2);
    assert.equal(two[0].start, 10 - CUT_REFINE.edgeOutsideS);
    assert.equal(two[1].end, 30 + CUT_REFINE.edgeOutsideS);
  });

  it("refino que deixa dois clipes sobrepostos no bruto funde sem repetir áudio", () => {
    const [, IG] = defaultSequences();
    const r = assembleClips(IG, [{ block: "comentario", srcIn: 575, srcOut: 580.7 }, { block: "comentario", srcIn: 580.6, srcOut: 585.59 }], 30);
    assert.equal(r.clips.length, 1);
    assert.match(r.merges[0].reason, /sobreposição de 100 ms/);
  });
});
