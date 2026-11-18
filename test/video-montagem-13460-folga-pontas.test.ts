/**
 * #13460: palavras que o editor recoloca à mão porque o XML as cortou
 * (comparação XML × final, #13196). Duas regras do `build`:
 *
 *   1. `openCutSoundEdges`: a borda com SOM CORTADO acima do fixo que não acha
 *      silêncio antes do limite vai para o vale de energia, em vez de ficar no
 *      pico da palavra (261105, entrada de "diferença" em 1175,78 s a -5 dBFS).
 *   2. `closeSliverGaps`: vão de menos de 0,1 s entre clipes contíguos no bruto
 *      fecha (261104, "a" de "equivalente a 127", vão de 60 ms; 261116, "com",
 *      vão de 35 ms no meio da palavra).
 *
 * Áudio sintético a 16 kHz, como em video-montagem-13194-verify-borda.test.ts.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { energyEnvelope, maxDbIn } from "../scripts/lib/diaria/video-cut-refine.ts";
import { assembleClips, closeSliverGaps, SLIVER_GAP, type PlannedClip, type SourceInfo, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { CUT_EDGE_VALLEY, openCutSoundEdges, valleyFrame, type OpenableClip } from "../scripts/lib/diaria/video-xml-verify.ts";
import { openCutEdgesOfPlan } from "../scripts/video-montagem.ts";

const SR = 16000;
const FPS = 30;
const THR = -50;

/** Bruto sintético: piso baixo e tons nos intervalos dados (s), cada um com a sua amplitude (3000 ≈ -24 dBFS, 400 ≈ -41 dBFS). */
function synth(durationS: number, parts: Array<[number, number, number]>) {
  const n = Math.round(durationS * SR);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const p = parts.find(([a, b]) => t >= a && t < b);
    samples[i] = Math.round((p ? p[2] : 3) * Math.sin(2 * Math.PI * 220 * t));
  }
  const env = energyEnvelope(samples, SR);
  return { env, level: (a: number, b: number) => maxDbIn(env, a, b) };
}

const clip = (srcIn: number, srcOut: number, extra: Partial<OpenableClip> = {}): OpenableClip => ({
  block: "comentario",
  srcIn,
  srcOut,
  frameIn: Math.round(srcIn * FPS),
  frameOut: Math.round(srcOut * FPS),
  ...extra,
});
const w = (text: string, start: number, end: number): Word => ({ text, start, end });

describe("#13460 openCutSoundEdges: SOM CORTADO sem silêncio até o limite vai para o vale", () => {
  // O perfil da 261105 em 1175 s: hesitação (-41 dBFS, acima do limiar e abaixo da fala) desde 2,0 s, o ataque
  // da palavra em 3,6 s e a entrada do item em 4,0 s, no pico (-24 dBFS). Não há silêncio nos 0,6 s antes.
  const hesitacao = (): ReturnType<typeof synth> => synth(10, [[2.0, 3.6, 400], [3.6, 6.0, 3000]]);

  it("a entrada no meio da palavra recua até o vale e recupera o ataque", () => {
    const { level } = hesitacao();
    const r = openCutSoundEdges([clip(4.0, 6.2)], FPS, level, THR, { durationS: 10 });
    assert.equal(r.opened.length, 1);
    assert.equal(r.opened[0].valley, true);
    assert.equal(r.opened[0].edge, "in");
    assert.ok(r.clips[0].srcIn < 3.6 && r.clips[0].srcIn >= 3.4 - 1e-9, `entrada antes do ataque, dentro do teto (${r.clips[0].srcIn})`);
    assert.equal(r.clips[0].frameIn, Math.round(r.clips[0].srcIn * FPS));
    assert.ok(r.opened[0].toDb <= r.opened[0].fromDb - CUT_EDGE_VALLEY.minDropDb, `vale pelo menos ${CUT_EDGE_VALLEY.minDropDb} dB abaixo (${r.opened[0].fromDb} → ${r.opened[0].toDb})`);
    // Fora do clipe ainda há som acima do limiar: segue como pendência, o verify-xml continua acusando.
    assert.equal(r.unresolved.length, 1);
    assert.equal(r.unresolved[0].error, true);
  });

  it("antes do #13460 (sem vale) a borda ficava no pico: a regra só age quando não há silêncio", () => {
    // Com silêncio antes do limite vale a abertura de sempre, até o silêncio, sem marcar vale.
    const { level } = synth(10, [[3.7, 6.0, 3000]]);
    const r = openCutSoundEdges([clip(4.0, 6.2)], FPS, level, THR, { durationS: 10 });
    assert.equal(r.opened.length, 1);
    assert.equal(r.opened[0].valley, undefined);
    assert.deepEqual(r.unresolved, []);
  });

  it("fala contínua até a palavra vizinha (sem vale claro): a borda fica, nunca avança só por avançar", () => {
    // O "e" de "veículos e" (261105, 926,17 s): falado inteiro, fora do roteiro, colado na saída.
    const { level } = synth(10, [[2.0, 8.0, 3000]]);
    const r = openCutSoundEdges([clip(1.9, 5.0)], FPS, level, THR, { durationS: 10, words: [w("fim", 4.6, 5.0), w("e", 5.05, 5.6)] });
    assert.deepEqual(r.opened, []);
    assert.equal(r.clips[0].srcOut, 5.0);
    assert.equal(r.unresolved.length, 1);
  });

  it("borda abaixo do fixo (o [aviso] de sala ruidosa) não vai para o vale", () => {
    // Limiar relativo -60, fixo -30: a energia de fora (-41) está entre os dois, sustentada; vale de -58 depois.
    const { level } = synth(10, [[2.0, 4.0, 3000], [4.0, 4.4, 400], [4.4, 6.0, 60]]);
    const thr = Object.assign((_t: number) => -60, { fixedDb: -30 });
    const r = openCutSoundEdges([clip(1.9, 4.1)], FPS, level, thr, { durationS: 10 });
    assert.deepEqual(r.opened, []);
    assert.equal(r.clips[0].srcOut, 4.1);
    assert.equal(r.unresolved.length, 1, "pré-condição: a borda é pendência (sem-abertura)");
    assert.equal(r.unresolved[0].error, false);
  });

  it("o filler da pausa da vinheta não vai para o vale", () => {
    const { level } = hesitacao();
    const r = openCutSoundEdges([clip(4.0, 6.2, { filler: true })], FPS, level, THR, { durationS: 10 });
    assert.deepEqual(r.opened, []);
    assert.equal(r.clips[0].srcIn, 4.0);
  });

  it("valleyFrame: o mais quieto até o limite, no empate o mais perto da borda; sem queda suficiente, null", () => {
    const db = new Map([[10, -5], [9, -20], [8, -30], [7, -30], [6, -10]]);
    const at = (t: number) => db.get(Math.round(t * FPS)) ?? 0;
    assert.equal(valleyFrame(10, 6, -1, FPS, at), 8);
    assert.equal(valleyFrame(10, 10, -1, FPS, at), null, "limite na própria borda: nada a procurar");
    const flat = (_t: number) => -20;
    assert.equal(valleyFrame(10, 14, 1, FPS, flat), null);
  });

  it("openCutEdgesOfPlan registra o vale no motivo do ajuste (#13460)", () => {
    const { env } = hesitacao();
    const source: SourceInfo = { path: "G:/x/bruto.mp4", fps: FPS, durationS: 10, width: 1920, height: 1080, mirrored: false };
    const clips = assembleClips({ scales: [100, 115] }, [{ block: "comentario", srcIn: 4.0, srcOut: 6.2, script: "diferença de como" }], FPS).clips;
    const r = openCutEdgesOfPlan(clips, env, THR, source, [w("diferença", 3.5, 4.6), w("de", 4.6, 4.8)], null);
    assert.equal(r.adjustments.length, 1);
    assert.match(r.adjustments[0].reason, /vale de energia.*#13460/);
    assert.ok(r.clips[0].srcIn < 3.6);
  });
});

describe("#13460 closeSliverGaps: vão de menos de 0,1 s entre clipes contíguos no bruto fecha", () => {
  const spec = { scales: [100, 115] as [number, number] };
  const planned = (raws: Array<[number, number]>, extra: Array<Partial<PlannedClip>> = []): PlannedClip[] =>
    assembleClips(spec, raws.map(([srcIn, srcOut], i) => ({ block: "comentario" as const, srcIn, srcOut, ...(extra[i] ?? {}) })), FPS).clips;

  it("261104: o vão de 60 ms entre \"equivalente a\" e \"127\" fecha e os dois clipes viram um", () => {
    const clips = planned([[336.96, 338.39], [338.45, 340.78]]);
    assert.equal(clips.length, 2, "pré-condição: o assembleClips sozinho não funde vão de 2 quadros");
    const words = [w("equivalente", 337.29, 338.09), w("a", 338.09, 338.73), w("127", 338.73, 339.27)];
    const r = closeSliverGaps(clips, words, FPS);
    assert.equal(r.adjustments.length, 1);
    assert.equal(r.adjustments[0].edge, "emenda");
    assert.match(r.adjustments[0].reason, /#13460/);
    const re = assembleClips(spec, r.clips.map((c) => ({ block: c.block, srcIn: c.srcIn, srcOut: c.srcOut })), FPS);
    assert.equal(re.clips.length, 1);
    const mid = (338.09 + 338.73) / 2;
    assert.ok(re.clips[0].srcIn <= mid && re.clips[0].srcOut >= mid, "o meio do \"a\" fica dentro do clipe");
  });

  it("261116: o vão de 35 ms no meio de \"com\" fecha", () => {
    const clips = planned([[1009.51, 1012.63], [1012.665, 1016.735]]);
    const r = closeSliverGaps(clips, [w("vegetariano", 1011.03, 1012.33), w("com", 1012.33, 1012.97), w("mesa", 1012.97, 1013.23)], FPS);
    assert.equal(r.adjustments.length, 1);
    assert.equal(r.clips[0].frameOut, r.clips[1].frameIn);
  });

  it("palavra inteira dentro do vão (o corte a tirou de propósito) não fecha", () => {
    const clips = planned([[1.0, 2.0], [2.09, 3.0]]);
    const r = closeSliverGaps(clips, [w("é", 2.01, 2.08)], FPS);
    assert.deepEqual(r.adjustments, []);
  });

  it("o vão do corte de pausa (0,21 s ou mais) não fecha", () => {
    const clips = planned([[1.0, 2.0], [2.21, 3.0]]);
    assert.ok(2.21 - 2.0 >= SLIVER_GAP.maxS);
    assert.deepEqual(closeSliverGaps(clips, [], FPS).adjustments, []);
  });

  it("enquadramentos diferentes, arquivos diferentes, filler e trecho que volta no bruto não fecham", () => {
    const pair: Array<[number, number]> = [[1.0, 2.0], [2.06, 3.0]];
    const framed = planned(pair, [{ framing: { faceX: 0.5, eyeY: 0.4 } }, { framing: { faceX: 0.6, eyeY: 0.4 } }]);
    assert.deepEqual(closeSliverGaps(framed, [], FPS).adjustments, []);
    const files = planned(pair, [{ file: 0 }, { file: 1 }]);
    assert.deepEqual(closeSliverGaps(files, [], FPS).adjustments, []);
    const filler = planned(pair, [{}, { filler: true }]);
    assert.deepEqual(closeSliverGaps(filler, [], FPS).adjustments, []);
    const back = planned([[2.06, 3.0], [1.0, 2.0]]);
    assert.deepEqual(closeSliverGaps(back, [], FPS).adjustments, []);
  });

  it("não muta os clipes de entrada", () => {
    const clips = planned([[1.0, 2.0], [2.05, 3.0]]);
    const before = JSON.stringify(clips);
    closeSliverGaps(clips, [], FPS);
    assert.equal(JSON.stringify(clips), before);
  });
});
