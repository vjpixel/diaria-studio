/**
 * #13194 (resíduo da PR #13203): a borda que o `verify-xml` acusa como SOM
 * CORTADO passa a ser corrigida pelo próprio `build`, que abre o corte até o
 * silêncio no mesmo critério (`edgeFindings`), em vez de só avisar.
 *
 * Áudio sintético a 16 kHz (o `audio.wav` do `transcribe`): piso a ~-83 dBFS e
 * "fala" a ~-24 dBFS, com a cauda da palavra caindo depois do tempo do Whisper,
 * que é o perfil da 261116 (a borda do item vinha do Whisper, que termina antes
 * da cauda).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { energyEnvelope, maxDbIn } from "../scripts/lib/diaria/video-cut-refine.ts";
import { assembleClips, type PlannedClip, type SourceInfo, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { edgeFindings, openCutSoundEdges, type OpenableClip } from "../scripts/lib/diaria/video-xml-verify.ts";
import { openCutEdgesOfPlan, rawClipOf } from "../scripts/video-montagem.ts";

const SR = 16000;
const FPS = 30;
const THR = -50;

/** Bruto sintético: piso baixo e tons de "fala" nos intervalos dados (s). */
function synth(durationS: number, speech: Array<[number, number]>) {
  const n = Math.round(durationS * SR);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const loud = speech.some(([a, b]) => t >= a && t < b);
    samples[i] = Math.round((loud ? 3000 : 3) * Math.sin(2 * Math.PI * 220 * t));
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
const cutEdges = (cs: readonly OpenableClip[], level: (a: number, b: number) => number) =>
  edgeFindings(tl(cs), FPS, level, THR).filter((e) => e.cutIn || e.cutOut).length;
const w = (text: string, start: number, end: number): Word => ({ text, start, end });

describe("#13194 openCutSoundEdges: o build corrige o SOM CORTADO que o verify-xml acusaria", () => {
  it("saída antes da cauda da palavra abre até o silêncio e o verify passa a zerar a borda", () => {
    // fala de 2,0 a 5,4 s; o Whisper terminou a última palavra em 5,0 e o item saiu em 5,1
    const { level } = synth(10, [[2.0, 5.4]]);
    const before = [clip(1.9, 5.1)];
    assert.equal(cutEdges(before, level), 1, "pré-condição: o verify-xml acusa a saída");
    const r = openCutSoundEdges(before, FPS, level, THR, { durationS: 10 });
    assert.equal(r.opened.length, 1);
    assert.equal(r.opened[0].edge, "out");
    assert.ok(r.clips[0].srcOut > 5.4 && r.clips[0].srcOut < 5.5, `saída aberta até depois da cauda (${r.clips[0].srcOut})`);
    assert.equal(r.clips[0].frameOut, Math.round(r.clips[0].srcOut * FPS));
    assert.deepEqual(r.unresolved, []);
    assert.equal(cutEdges(r.clips, level), 0);
  });

  it("entrada depois do ataque abre para trás até o silêncio", () => {
    // o "No" de "No índice" (617,1 s com fala desde 616,8 s), em escala: fala desde 3,7, item em 4,0
    const { level } = synth(10, [[3.7, 6.0]]);
    const r = openCutSoundEdges([clip(4.0, 6.2)], FPS, level, THR, { durationS: 10 });
    assert.equal(r.opened.length, 1);
    assert.equal(r.opened[0].edge, "in");
    assert.ok(r.clips[0].srcIn < 3.7 && r.clips[0].srcIn > 3.6, `entrada antes do ataque (${r.clips[0].srcIn})`);
    assert.equal(cutEdges(r.clips, level), 0);
  });

  it("palavra vizinha inteira de fora limita a abertura: sem silêncio até ela, a borda fica e vira pendência", () => {
    // fala contínua de 2,0 a 8,0: depois da saída em 5,0 vem a palavra seguinte, do bloco que saiu do roteiro
    const { level } = synth(10, [[2.0, 8.0]]);
    const words = [w("fim", 4.6, 5.0), w("outra", 5.05, 5.6)];
    const r = openCutSoundEdges([clip(1.9, 5.0)], FPS, level, THR, { durationS: 10, words });
    assert.deepEqual(r.opened, []);
    assert.equal(r.clips[0].srcOut, 5.0, "na dúvida, não avança sobre a palavra de fora");
    assert.equal(r.unresolved.length, 1);
    assert.equal(r.unresolved[0].edge, "out");
  });

  it("a palavra que a borda corta ao meio não limita (é ela que se reabre)", () => {
    const { level } = synth(10, [[2.0, 5.4]]);
    // o Whisper deu a última palavra de 4,8 a 5,3, atravessando a saída em 5,1
    const r = openCutSoundEdges([clip(1.9, 5.1)], FPS, level, THR, { durationS: 10, words: [w("dados", 4.8, 5.3)] });
    assert.equal(r.opened.length, 1);
    assert.equal(cutEdges(r.clips, level), 0);
  });

  it("a 1ª palavra do próprio roteiro colada na borda (tempo do Whisper atrasado) não limita via ownWord", () => {
    const { level } = synth(10, [[3.7, 6.0]]);
    // Whisper pôs o "No" de 3,85 a 3,95, inteiro antes da entrada em 4,0
    const words = [w("No", 3.85, 3.95), w("índice", 4.0, 4.5)];
    const blocked = openCutSoundEdges([clip(4.0, 6.2)], FPS, level, THR, { durationS: 10, words });
    assert.deepEqual(blocked.opened, [], "sem ownWord, o \"No\" de fora segura a entrada");
    const own = openCutSoundEdges([clip(4.0, 6.2)], FPS, level, THR, { durationS: 10, words, ownWord: (_c, edge, x) => edge === "in" && x.text === "No" });
    assert.equal(own.opened.length, 1);
    assert.ok(own.clips[0].srcIn < 3.7);
  });

  it("teto maxOpenS: cauda mais longa que o teto fica como pendência", () => {
    const { level } = synth(10, [[2.0, 6.5]]);
    const r = openCutSoundEdges([clip(1.9, 5.1)], FPS, level, THR, { durationS: 10, maxOpenS: 0.6 });
    assert.deepEqual(r.opened, []);
    assert.equal(r.unresolved.length, 1);
  });

  it("emenda com o clipe vizinho da sequência (contíguo no bruto) não é corte e não mexe", () => {
    const { level } = synth(10, [[2.0, 6.0]]);
    const cs = [clip(1.9, 4.0), clip(4.0, 6.1)];
    const r = openCutSoundEdges(cs, FPS, level, THR, { durationS: 10 });
    assert.deepEqual(r.opened, []);
    assert.deepEqual(r.unresolved, []);
    assert.deepEqual(r.clips.map((c) => [c.frameIn, c.frameOut]), cs.map((c) => [c.frameIn, c.frameOut]));
  });

  it("outro clipe da sequência no caminho: a abertura para nele (o áudio nunca se repete)", () => {
    // V2 com ordem trocada: o 2º clipe da sequência (3,35–3,9) vem antes no bruto, logo antes da entrada do 1º.
    // Há silêncio em 3,0–3,3: sem o limite do outro clipe, a entrada do 1º abriria até lá, por cima do 2º.
    const { level } = synth(10, [[2.0, 3.0], [3.3, 6.0]]);
    const cs = [clip(4.0, 6.1), clip(3.35, 3.9)];
    const r = openCutSoundEdges(cs, FPS, level, THR, { durationS: 10, maxOpenS: 1.0 });
    assert.ok(r.clips[0].frameIn >= cs[1].frameOut, `entrada do 1º não passa da saída do 2º (${r.clips[0].frameIn} < ${cs[1].frameOut})`);
    assert.ok(r.clips[1].frameOut <= cs[0].frameIn, "saída do 2º não passa da entrada do 1º");
    assert.deepEqual(r.unresolved.map((u) => [u.atS.toFixed(2), u.edge]), [["4.00", "in"], ["3.90", "out"]]);
  });

  it("bruto em vários arquivos: não abre para o arquivo vizinho", () => {
    const { level } = synth(10, [[4.0, 6.0]]);
    // o 2º arquivo começa em 5,0; o clipe começa no 1º quadro dele, com fala do 1º arquivo antes
    const r = openCutSoundEdges([clip(5.0, 6.1)], FPS, level, THR, { durationS: 10, bounds: [{ start: 0, end: 5 }, { start: 5, end: 10 }] });
    assert.ok(r.clips[0].srcIn >= 5.0);
    assert.deepEqual(r.unresolved, [], "borda na emenda dos arquivos não é corte (como no verify-xml)");
  });
});

describe("#13194 openCutEdgesOfPlan: o refino do build, no mesmo plano que vai para o XML", () => {
  const source: SourceInfo = { path: "G:/x/bruto.mp4", fps: FPS, durationS: 10, width: 1920, height: 1080, mirrored: false };
  const spec = { scales: [100, 115] as [number, number] };
  const planned = (raws: Array<[number, number, string]>): PlannedClip[] =>
    assembleClips(spec, raws.map(([srcIn, srcOut, script]) => ({ block: "comentario" as const, srcIn, srcOut, script })), FPS).clips;

  it("abre a saída cortada, registra o ajuste e a remontagem mantém quadros e posições coerentes", () => {
    const { env, level } = synth(10, [[2.0, 5.4], [7.0, 8.0]]);
    const clips = planned([[1.9, 5.1, "um dois dados"], [6.9, 8.1, "outra frase"]]);
    const words = [w("um", 2.0, 2.5), w("dois", 2.6, 3.4), w("dados", 3.5, 5.0), w("outra", 7.0, 7.4), w("frase", 7.5, 8.0)];
    const r = openCutEdgesOfPlan(clips, env, THR, source, words, null);
    assert.equal(r.adjustments.length, 1);
    assert.equal(r.adjustments[0].edge, "out");
    assert.match(r.adjustments[0].reason, /SOM CORTADO.*aberto até o silêncio.*#13194/);
    assert.deepEqual(r.warnings, []);
    const re = assembleClips(spec, r.clips.map(rawClipOf), FPS);
    assert.equal(re.clips.length, 2);
    assert.equal(re.clips[1].seqStart, re.clips[0].seqEnd);
    assert.equal(cutEdges(re.clips, level), 0, "o XML remontado sai sem SOM CORTADO");
  });

  it("a palavra da retranscrição das bordas (som fora do roteiro) também limita, e a pendência vira aviso", () => {
    const { env } = synth(10, [[2.0, 6.0]]);
    const clips = planned([[1.9, 5.1, "um dois"]]);
    const heard = new Map<string, Word[]>([["k", [w("éé", 5.15, 5.6)]]]);
    const r = openCutEdgesOfPlan(clips, env, THR, source, [w("dois", 4.0, 5.0)], heard);
    assert.deepEqual(r.adjustments, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /saída em 5\.10 s do bruto com SOM CORTADO.*verify-xml vai acusar/);
  });

  it("ownWord pelo roteiro do clipe: a 1ª palavra do script colada na entrada não segura a abertura", () => {
    const { env, level } = synth(10, [[3.7, 6.0]]);
    const clips = planned([[4.0, 6.2, "No índice"]]);
    const r = openCutEdgesOfPlan(clips, env, THR, source, [w("No", 3.85, 3.95), w("índice", 4.0, 4.5)], null);
    assert.equal(r.adjustments.length, 1);
    assert.equal(r.adjustments[0].edge, "in");
    assert.equal(cutEdges(r.clips, level), 0);
  });
});
