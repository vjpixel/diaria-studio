/**
 * #11557: revisão automática do export do Premiere. Casos reais da edição
 * 261029, que o editor pediu à mão 4 vezes: Instagram V1 em 1920x1080 com a
 * imagem vertical no meio (cropdetect 608:1072:656:4), V4 em -9,6 LUFS com
 * pico -0,2 dBTP, estalo de 10 ms (pico 0,64) em 0:03,03, fragmento de 0,12 s
 * em 0:51,4 e o "para" que o corte comeu em "eleições presidente".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkFormat,
  checkLoudness,
  checkText,
  dedupeAudioFindings,
  detectClicks,
  detectFragments,
  exportClock,
  exportTarget,
  exportTimeToRaw,
  finalReviewTable,
  parseCropdetect,
  parsePeakWindows,
  type PeakWindow,
} from "../scripts/lib/diaria/video-final-review.ts";
import { defaultSequences, type SequencePlan, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { reviewFinalTarget } from "../scripts/video-montagem.ts";

test("destino pelo nome do export; --seq sobrepõe; nome sem destino pede --seq", () => {
  assert.equal(exportTarget("Diaria comentada_Instagram_V1.mp4"), "instagram");
  assert.equal(reviewFinalTarget("/x/Diaria comentada_Youtube_V5.mp4", undefined), "youtube");
  assert.equal(reviewFinalTarget("/x/qualquer.mp4", "outras-redes"), "outras-redes");
  assert.throws(() => reviewFinalTarget("/x/qualquer.mp4", undefined), /--seq/);
  assert.throws(() => reviewFinalTarget("/x/a.mp4", "tiktok"), /--seq/);
});

test("formato: Instagram V1 da 261029 (1920x1080, imagem 608x1072 no meio) → formato + faixa-preta", () => {
  const crop = parseCropdetect("[Parsed_cropdetect_1] x1:656 ... crop=608:1072:656:4\n... crop=608:1072:656:4\n... crop=1920:1072:0:4\n");
  assert.deepEqual(crop, { w: 608, h: 1072, x: 656, y: 4 });
  const f = checkFormat({ width: 1920, height: 1080, fps: 30, durationS: 95 }, "instagram", { crop, expectedFps: 30 });
  assert.deepEqual(f.map((x) => x.kind), ["formato", "faixa-preta"]);
  assert.match(f[1].what, /608:1072:656:4/);
  // O mesmo arquivo como YouTube: a proporção serve, mas as faixas continuam.
  assert.deepEqual(checkFormat({ width: 1920, height: 1080, fps: 30, durationS: 95 }, "youtube", { crop }).map((x) => x.kind), ["faixa-preta"]);
  // Export certo: nada.
  assert.deepEqual(checkFormat({ width: 1080, height: 1920, fps: 30, durationS: 170 }, "outras-redes", { crop: { w: 1080, h: 1920, x: 0, y: 0 }, expectedFps: 30 }), []);
  // fps e teto do vertical.
  const g = checkFormat({ width: 1080, height: 1920, fps: 25, durationS: 200 }, "instagram", { expectedFps: 30 });
  assert.deepEqual(g.map((x) => x.kind), ["fps", "duracao"]);
});

test("áudio: V4 em -9,6 LUFS e -0,2 dBTP → loudness + pico; -14,3 LUFS / -1,5 dBTP passa", () => {
  const f = checkLoudness({ inputI: -9.6, inputTp: -0.2, inputLra: 5 });
  assert.deepEqual(f.map((x) => x.kind), ["loudness", "pico"]);
  assert.match(f[0].fix, /baixar 4\.4 dB/);
  assert.deepEqual(checkLoudness({ inputI: -14.3, inputTp: -1.5, inputLra: 5 }), []);
  assert.equal(checkLoudness(null)[0].kind, "loudness");
});

/** Janelas de 10 ms: silêncio, com `loud` em [from, to) e fala contínua em `speech`. */
function windows(durationS: number, loud: Array<[number, number, number]>): PeakWindow[] {
  const out: PeakWindow[] = [];
  for (let i = 0; i < Math.round(durationS * 100); i++) {
    const t = Math.round(i) / 100;
    const hit = loud.find(([a, b]) => t >= a - 1e-9 && t < b - 1e-9);
    out.push({ t, peakDb: hit ? hit[2] : -60 });
  }
  return out;
}

test("estalo: 10 ms com pico 0,64 em 0:03,03 entre silêncios; fala contínua não conta", () => {
  const w = windows(5, [[0.5, 2.5, -6], [3.03, 3.04, 20 * Math.log10(0.64)]]);
  const clicks = detectClicks(w);
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].at, 3.03);
  assert.match(clicks[0].what, /pico 0\.64/);
  assert.equal(exportClock(3.03), "0:03,03");
});

test("parsePeakWindows: lê pts_time e Peak_level (inclusive -inf)", () => {
  const txt = "frame:0    pts:0       pts_time:0\nlavfi.astats.Overall.Peak_level=-inf\nframe:1    pts:480     pts_time:0.01\nlavfi.astats.Overall.Peak_level=-3.876\n";
  assert.deepEqual(parsePeakWindows(txt), [{ t: 0, peakDb: -Infinity }, { t: 0.01, peakDb: -3.876 }]);
});

test("fragmento: 0,12 s de som entre dois silêncios em 0:51,4; o mesmo instante de um estalo sai uma vez só", () => {
  const frag = detectFragments([{ start: 50, end: 51.4 }, { start: 51.52, end: 52 }, { start: 53, end: 54 }]);
  assert.equal(frag.length, 1);
  assert.equal(frag[0].at, 51.4);
  assert.match(frag[0].what, /0\.12 s/);
  const click = { kind: "estalo" as const, at: 51.41, what: "x", fix: "y" };
  assert.deepEqual(dedupeAudioFindings([click], frag), [click]);
});

test("texto: o 'para' comido em 'eleições para presidente' sai com tempo no export e no bruto", () => {
  const spec = defaultSequences()[0];
  const plan: SequencePlan = {
    spec,
    clips: [
      { block: "comentario", srcIn: 100, srcOut: 102, frameIn: 3000, frameOut: 3060, seqStart: 0, seqEnd: 60, scale: 50 },
      { block: "comentario", srcIn: 110, srcOut: 112, frameIn: 3300, frameOut: 3360, seqStart: 60, seqEnd: 120, scale: 62 },
    ],
    durationFrames: 120,
    script: "as eleições para presidente começam",
    missingBlocks: [],
    dropped: [],
  };
  const words: Word[] = [
    { start: 0.2, end: 0.4, text: "as" },
    { start: 0.5, end: 1.1, text: "eleições" },
    { start: 2.05, end: 2.7, text: "presidente" },
    { start: 2.8, end: 3.3, text: "começam" },
  ];
  const f = checkText({ words, plan, fps: 30, durationS: 4 });
  const missing = f.find((x) => x.kind === "fala-faltando");
  assert.ok(missing, JSON.stringify(f));
  assert.match(missing.what, /para/);
  assert.equal(missing.at, 1.1);
  assert.equal(missing.rawAt, 101.1, "1,1 s no export = 100 + 1,1 no bruto");
  assert.equal(exportTimeToRaw(2.5, plan, 30), 110.5);
  assert.equal(exportTimeToRaw(9, plan, 30), null);
});

test("tabela: #, tempo no export, tempo no bruto, o que está, correção (arquivo inteiro primeiro)", () => {
  const md = finalReviewTable([
    { kind: "estalo", at: 3.03, what: "estalo | 10 ms", fix: "aparar" },
    { kind: "formato", at: null, what: "1920x1080", fix: "exportar 9:16" },
  ]);
  const lines = md.trim().split("\n");
  assert.equal(lines[0], "| # | Tempo no export | Tempo no bruto | O que está | Correção |");
  assert.match(lines[2], /^\| 1 \| arquivo inteiro \| — \| \[formato\]/);
  assert.match(lines[3], /^\| 2 \| 0:03,03 \| — \| \[estalo\] estalo \\\| 10 ms/);
  assert.match(finalReviewTable([]), /nenhum achado/);
});
