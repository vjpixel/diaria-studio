/**
 * #11503 — o zoom (punch-in) muda em todo corte e só em corte (decisão do
 * editor, 28/10/2026), em todas as versões.
 *
 * Bug: o `build` alternava a escala a cada clipe, e cada item do `blocks.json`
 * virava pelo menos um clipe. Como o roteiro é escrito frase a frase, uma fala
 * contínua no bruto virava vários itens contíguos (o `srcOut` de um igual ao
 * `srcIn` do seguinte) e o zoom pulava no meio da fala: 6 vezes em 1:20 no
 * vertical da 261029 (em 234,79, 239,94, 250,24, 567,55, 578,77 e 580,70 s).
 * Também cobre a sobreposição de 20–100 ms entre clipes contíguos (#11500 item
 * 4: 234,77/234,79 s), que repetia áudio.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleClips,
  buildSequencePlan,
  buildXmeml,
  clipSecondsOfBlock,
  defaultSequences,
  resolveBlocks,
  type BlocksFile,
  type Interval,
  type PlannedClip,
  type SequenceSpec,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { roteiroMarkdown } from "../scripts/lib/diaria/video-montage-docs.ts";

const FPS = 30;
const SOURCE = { fps: FPS, durationS: 700 };
const [YT, IG] = defaultSequences() as [SequenceSpec, SequenceSpec, SequenceSpec];

/** Uma palavra a cada 0,4 s em [a, b), coladas (fala contínua). */
function speech(a: number, b: number, prefix: string): Word[] {
  const out: Word[] = [];
  for (let t = a, n = 0; t < b - 1e-9; t += 0.4, n++) out.push({ start: +t.toFixed(3), end: +(t + 0.4).toFixed(3), text: ` ${prefix}${n}` });
  return out;
}

/** As duas regras, sobre os clipes já montados. */
function assertZoomRules(clips: PlannedClip[]): void {
  for (let i = 1; i < clips.length; i++) {
    const [p, c] = [clips[i - 1], clips[i]];
    assert.notEqual(c.scale, p.scale, `clipe ${i}: fronteira sem troca de zoom`);
    assert.notEqual(c.srcIn, p.srcOut, `clipe ${i}: troca de zoom sem corte (srcIn = srcOut anterior)`);
    assert.notEqual(c.frameIn, p.frameOut, `clipe ${i}: troca de zoom sem corte (frameIn = frameOut anterior)`);
  }
}

describe("assembleClips: zoom só nos cortes (#11503)", () => {
  it("dois trechos contíguos no bruto viram um clipe e nenhuma troca de escala", () => {
    const r = assembleClips(IG, [
      { block: "comentario", srcIn: 228.95, srcOut: 234.79 },
      { block: "comentario", srcIn: 234.79, srcOut: 239.94 },
    ], FPS);
    assert.equal(r.clips.length, 1);
    assert.equal(r.clips[0].srcIn, 228.95);
    assert.equal(r.clips[0].srcOut, 239.94);
    assert.equal(r.clips[0].scale, IG.scales[0]);
    assert.equal(r.merges.length, 1);
    assert.equal(r.merges[0].edge, "emenda");
  });

  it("menos de 1 frame entre eles também é contíguo; 1 frame ou mais é corte", () => {
    const near = assembleClips(IG, [{ block: "comentario", srcIn: 10, srcOut: 12 }, { block: "comentario", srcIn: 12.02, srcOut: 14 }], FPS);
    assert.equal(near.clips.length, 1);
    const cut = assembleClips(IG, [{ block: "comentario", srcIn: 10, srcOut: 12 }, { block: "comentario", srcIn: 12.2, srcOut: 14 }], FPS);
    assert.equal(cut.clips.length, 2);
    assertZoomRules(cut.clips);
  });

  it("sobreposição (234,77 depois de um fim em 234,79) funde sem repetir áudio (#11500 item 4)", () => {
    const r = assembleClips(IG, [{ block: "comentario", srcIn: 228.95, srcOut: 234.79 }, { block: "comentario", srcIn: 234.77, srcOut: 239.94 }], FPS);
    assert.equal(r.clips.length, 1);
    assert.equal(r.clips[0].srcOut, 239.94);
    assert.match(r.merges[0].reason, /sobreposição de 20 ms/);
    assert.equal(r.clips[0].frameOut - r.clips[0].frameIn, Math.round(239.94 * FPS) - Math.round(228.95 * FPS));
  });

  it("trecho que volta no bruto é corte, mesmo começando antes do fim do anterior", () => {
    const r = assembleClips(IG, [{ block: "comentario", srcIn: 300, srcOut: 305 }, { block: "comentario", srcIn: 290, srcOut: 300 }], FPS);
    assert.equal(r.clips.length, 2);
    assertZoomRules(r.clips);
  });

  it("contíguos de blocos diferentes: um clipe, com o pedaço de cada bloco", () => {
    const r = assembleClips(IG, [{ block: "cta_ig", srcIn: 680, srcOut: 684 }, { block: "fecho", srcIn: 684, srcOut: 686 }], FPS);
    assert.equal(r.clips.length, 1);
    const c = r.clips[0];
    assert.equal(c.block, "cta_ig");
    assert.ok(Math.abs(clipSecondsOfBlock(c, "cta_ig", FPS) - 4) < 0.05);
    assert.ok(Math.abs(clipSecondsOfBlock(c, "fecho", FPS) - 2) < 0.05);
  });
});

describe("buildSequencePlan: a 261029 (fala contínua escrita frase a frase) (#11503)", () => {
  // Comentário de 228,95 a 252,83 s, contínuo, escrito em 4 itens contíguos; outro trecho depois de um corte.
  const words = [...speech(228.95, 252.83, "c"), ...speech(556.2, 558.2, "d"), ...speech(562.6, 571.7, "e")];
  const file: BlocksFile = {
    edition: "261029",
    blocks: {
      comentario: [
        { start: 228.95, end: 234.79 },
        { start: 234.79, end: 239.94 },
        { start: 239.94, end: 250.24 },
        { start: 250.24, end: 252.83 },
        { start: 556.2, end: 558.2 },
        { start: 562.6, end: 571.7 },
      ],
    },
  };
  const { blocks, errors } = resolveBlocks(file, words, { durationS: SOURCE.durationS });
  const plan = buildSequencePlan({ ...IG, order: ["comentario"] }, blocks, [], SOURCE);

  it("os 4 itens contíguos viram 1 clipe; os cortes reais seguem cortes", () => {
    assert.deepEqual(errors, []);
    assert.equal(plan.clips.length, 3);
    assert.equal(plan.clips[0].srcIn, 228.95);
    assert.equal(plan.clips[0].srcOut, 252.83);
    assert.deepEqual(plan.dropped, []);
  });

  it("toda fronteira troca o zoom e nenhuma troca acontece sem corte", () => {
    assertZoomRules(plan.clips);
    assert.equal(plan.cutAdjustments?.filter((a) => a.edge === "emenda").length, 3);
  });

  it("o XML leva um clipitem por clipe fundido (o Premiere vê o mesmo que a prévia)", () => {
    const xml = buildXmeml([plan], { path: "G:/x/bruto.mp4", fps: FPS, durationS: 700, width: 3840, height: 2160, mirrored: true }, { faceX: 0.5, eyeY: 0.5 });
    assert.equal((xml.match(/<clipitem id="v/g) ?? []).length, 3);
  });

  it("silêncio removido dentro do bloco é corte e troca o zoom", () => {
    const sil: Interval[] = [{ start: 240, end: 242 }];
    const p = buildSequencePlan({ ...YT, order: ["comentario"] }, blocks, sil, SOURCE);
    assert.equal(p.clips.length, 4);
    assertZoomRules(p.clips);
  });

  it("o roteiro (Gate 2) segue somando a duração por bloco", () => {
    const md = roteiroMarkdown("261029", [plan], blocks, FPS);
    const secs = plan.clips.reduce((a, c) => a + (c.frameOut - c.frameIn) / FPS, 0);
    assert.match(md, new RegExp(`Comentário \\(${secs.toFixed(1).replace(".", "\\.")} s\\)`));
  });
});
