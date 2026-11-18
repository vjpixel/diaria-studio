/**
 * #13414 — nas verticais (1080x1920: a vertical da edição, os cortes, o guia)
 * a BOCA fica no centro do quadro, nas duas escalas (115/130). Antes o
 * `framingFor` ancorava pelos olhos a 40% da altura e a boca caía entre 53% e
 * 55% do quadro, variando com a escala (medida da 261116, bruto 4K: olhos em
 * 0,376, boca em 0,476).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clipFraming,
  clipGeometry,
  defaultSequences,
  EYE_LINE_FRACTION,
  framingFor,
  mouthCenterWarnings,
  mouthLineOf,
  MOUTH_BELOW_EYES,
  MOUTH_CENTER_TOL,
  MOUTH_LINE_FRACTION,
  parseBlocksFile,
  previewCropFor,
  sequenceAnchor,
  type Framing,
  type SequenceSpec,
} from "../scripts/lib/diaria/video-montage.ts";
import { applyItemFramings, itemFramings, MOUTH_IN_FACE, type FrameDetection } from "../scripts/lib/diaria/video-face.ts";

const SRC = { srcW: 3840, srcH: 2160 };
const VERT = { ...SRC, seqW: 1080, seqH: 1920 };
/** 261116, bruto 4K (medição da issue). */
const F261116: Framing = { faceX: 0.48, eyeY: 0.376, mouthY: 0.476 };
const mouthAt = (fr: ReturnType<typeof framingFor>, mouthY: number) => (mouthY * SRC.srcH - fr.crop.y) / fr.crop.h;

describe("#13414 framingFor ancorado pela boca", () => {
  it("261116 nas duas escalas: boca no centro vertical (±1 px); ancorado pelos olhos ela caía em 53-55%", () => {
    for (const scalePct of [115, 130]) {
      const fr = framingFor({ ...VERT, scalePct, framing: F261116, mouthFraction: MOUTH_LINE_FRACTION });
      assert.ok(Math.abs(mouthAt(fr, 0.476) - 0.5) <= 1 / fr.crop.h, `${scalePct}%: boca em ${mouthAt(fr, 0.476)}`);
      // Regressão: o recorte antigo (olhos a 40%) deixa a boca bem abaixo do centro e diferente por escala.
      const old = framingFor({ ...VERT, scalePct, framing: F261116 });
      assert.ok(mouthAt(old, 0.476) > 0.52, `${scalePct}% pelos olhos: ${mouthAt(old, 0.476)}`);
    }
    const o115 = mouthAt(framingFor({ ...VERT, scalePct: 115, framing: F261116 }), 0.476);
    const o130 = mouthAt(framingFor({ ...VERT, scalePct: 130, framing: F261116 }), 0.476);
    assert.ok(Math.abs(o115 - o130) > 0.01, "pelos olhos a posição da boca variava com a escala");
  });

  it("sem mouthY: estimativa olhos + 0,10, com assumed para o [premissa]", () => {
    assert.deepEqual(mouthLineOf({ eyeY: 0.376 }), { mouthY: 0.376 + MOUTH_BELOW_EYES, assumed: true });
    assert.deepEqual(mouthLineOf({ eyeY: 0.376, mouthY: 0.47 }), { mouthY: 0.47, assumed: false });
    const est = framingFor({ ...VERT, scalePct: 115, framing: { faceX: 0.48, eyeY: 0.376 }, mouthFraction: 0.5 });
    assert.ok(Math.abs(mouthAt(est, 0.476) - 0.5) <= 1 / est.crop.h);
  });

  it("sem mouthFraction o recorte é o de sempre (horizontal e chamadas antigas)", () => {
    const a = framingFor({ ...VERT, scalePct: 115, framing: F261116 });
    const b = framingFor({ ...VERT, scalePct: 115, framing: { faceX: 0.48, eyeY: 0.376 }, eyeFraction: EYE_LINE_FRACTION });
    assert.deepEqual(a.crop, b.crop);
  });

  it("clamp: boca perto do pé do bruto não sai do quadro (o recorte encosta na borda)", () => {
    const fr = framingFor({ ...VERT, scalePct: 115, framing: { faceX: 0.5, eyeY: 0.85, mouthY: 0.95 }, mouthFraction: 0.5 });
    assert.equal(fr.crop.y + fr.crop.h, 2160);
  });
});

describe("#13414 sequenceAnchor", () => {
  const [yt, vert] = defaultSequences("V1");
  it("horizontal: olhos a 1/3; vertical default: boca no centro", () => {
    assert.deepEqual(sequenceAnchor(yt), { eyeFraction: yt.eyeFraction });
    assert.deepEqual(sequenceAnchor(vert), { mouthFraction: MOUTH_LINE_FRACTION });
  });
  it("vertical com eyeFraction posto à mão (o guia da 261116) segue pelos olhos; mouthFraction explícito vale", () => {
    assert.deepEqual(sequenceAnchor({ ...vert, eyeFraction: 0.37 }), { eyeFraction: 0.37 });
    assert.deepEqual(sequenceAnchor({ ...vert, mouthFraction: 0.55 }), { mouthFraction: 0.55 });
    assert.deepEqual(sequenceAnchor({ width: 1080, height: 1080 }), {});
  });

  it("XML e prévia da vertical default: boca no centro do recorte nas duas escalas", () => {
    const source = { path: "x.mp4", fps: 30, durationS: 60, width: 3840, height: 2160, mirrored: false };
    for (const scale of vert.scales) {
      const g = clipGeometry({ source, spec: vert, framing: F261116, clip: { scale } });
      const crop = g.main.crop!;
      assert.ok(Math.abs((0.476 * 2160 - crop.y) / crop.h - 0.5) <= 1 / crop.h, `${scale}%`);
      assert.deepEqual(previewCropFor(source, vert, F261116, scale), crop);
    }
  });
});

describe("#13414 clipFraming: a boca vem do item junto do rosto", () => {
  it("item sem mouthY não herda a boca do arquivo (o rosto mudou de lugar)", () => {
    const base: Framing = { faceX: 0.48, eyeY: 0.376, mouthY: 0.476, mug: { left: 0.6, right: 0.65, top: 0.7, bottom: 0.8 } };
    const own = clipFraming(base, { framing: { faceX: 0.4, eyeY: 0.3 } });
    assert.equal(own.mouthY, undefined);
    assert.deepEqual(own.mug, base.mug);
    assert.equal(clipFraming(base, { framing: { faceX: 0.4, eyeY: 0.3, mouthY: 0.39 } }).mouthY, 0.39);
    assert.equal(clipFraming(base, {}).mouthY, 0.476);
  });
});

describe("#13414 mouthCenterWarnings (build e review)", () => {
  const vert: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["comentario"], scales: [115, 130] };
  const yt = defaultSequences("V1")[0];
  const size = { width: 3840, height: 2160 };
  it("boca centrada: nenhum aviso; mouthY medido: nenhuma premissa", () => {
    assert.deepEqual(mouthCenterWarnings([{ spec: vert, clips: [{ scale: 115 }, { scale: 130 }] }], size, F261116), { warnings: [], assumed: [] });
  });
  it("recorte batendo na borda: aviso por escala com a distância do centro", () => {
    const low: Framing = { faceX: 0.5, eyeY: 0.85, mouthY: 0.95 };
    const r = mouthCenterWarnings([{ spec: vert, clips: [{ scale: 115 }, { scale: 130 }] }], size, low);
    assert.equal(r.warnings.length, 2);
    assert.match(r.warnings[0], /Diaria comentada_Vertical_V1 \(115%\): boca a \d+,\d% abaixo do centro vertical/);
    assert.ok(MOUTH_CENTER_TOL === 0.02);
  });
  it("boca estimada: uma premissa por sequência; horizontal (olhos) não entra", () => {
    const r = mouthCenterWarnings([{ spec: vert, clips: [{ scale: 115 }] }, { spec: yt, clips: [{ scale: 60 }] }], size, { faceX: 0.48, eyeY: 0.376 });
    assert.equal(r.warnings.length, 0);
    assert.equal(r.assumed.length, 1);
    assert.match(r.assumed[0], /^Diaria comentada_Vertical_V1: boca estimada em olhos \+ 0,10/);
  });
  it("item com boca própria fora do centro avisa com o rótulo do item", () => {
    const r = mouthCenterWarnings([{ spec: vert, clips: [{ scale: 115, framing: { faceX: 0.5, eyeY: 0.86, mouthY: 0.96 } }] }], size, F261116);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /item com rosto em 0\.5\/0\.86/);
  });
});

describe("#13414 blocks.json: mouthY e mouthFraction", () => {
  const base = { edition: "261116", blocks: {} };
  it("framing do arquivo e do item aceitam mouthY entre 0 e 1", () => {
    assert.equal(parseBlocksFile({ ...base, framing: F261116 }).ok, true);
    assert.equal(parseBlocksFile({ ...base, blocks: { comentario: [{ text: "x", framing: { faceX: 0.5, eyeY: 0.4, mouthY: 0.5 } }] } }).ok, true);
    const bad = parseBlocksFile({ ...base, framing: { ...F261116, mouthY: 1.2 } });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.ok(bad.errors.some((e) => e.includes("mouthY")));
    assert.equal(parseBlocksFile({ ...base, blocks: { comentario: [{ text: "x", framing: { faceX: 0.5, eyeY: 0.4, mouthY: -1 } }] } }).ok, false);
  });
  it("sequência com eyeFraction e mouthFraction juntos é erro; mouthFraction fora de 0-1 também", () => {
    const vert = defaultSequences("V1")[1];
    const both = parseBlocksFile({ ...base, sequences: [{ ...vert, eyeFraction: 0.4, mouthFraction: 0.5 }] });
    assert.equal(both.ok, false);
    if (!both.ok) assert.ok(both.errors.some((e) => e.includes("eyeFraction e mouthFraction juntos")), JSON.stringify(both.errors));
    const out = parseBlocksFile({ ...base, sequences: [{ ...vert, mouthFraction: 1.5 }] });
    assert.equal(out.ok, false);
    assert.equal(parseBlocksFile({ ...base, sequences: [{ ...vert, mouthFraction: 0.5 }] }).ok, true);
  });
});

describe("#13414 face: mede a boca por item", () => {
  const det = (key: string, faces: FrameDetection["faces"]): FrameDetection => ({ key, w: 720, h: 405, faces });
  it("caixa do Haar: boca a MOUTH_IN_FACE da altura da caixa", () => {
    const f = { x: 312, y: 129, w: 81, h: 81 };
    const [r] = itemFramings([det("c#0", [f]), det("c#0", [f]), det("c#0", [f])], ["c#0"]);
    assert.equal(r.framing?.mouthY, Math.round(((129 + 81 * MOUTH_IN_FACE) / 405) * 1000) / 1000);
  });
  it("detector com pontos do rosto (MediaPipe, #13370): olhos e boca dos pontos", () => {
    const f = { x: 296, y: 135, w: 91, h: 91, eyeY: 161.2, mouthY: 188.7 };
    const [r] = itemFramings([det("c#0", [f]), det("c#0", [f])], ["c#0"]);
    assert.deepEqual(r.framing, { faceX: Math.round(((296 + 45.5) / 720) * 1000) / 1000, eyeY: Math.round((161.2 / 405) * 1000) / 1000, mouthY: Math.round((188.7 / 405) * 1000) / 1000 });
  });
  it("face --write acrescenta a boca no framing do mesmo rosto; framing diferente medido à mão fica", () => {
    const raw = { blocks: { comentario: [{ text: "a", framing: { faceX: 0.5, eyeY: 0.4 } }, { text: "b", framing: { faceX: 0.3, eyeY: 0.3 } }] } } as { blocks: Record<string, Array<Record<string, unknown>>> };
    const r = applyItemFramings(raw, [
      { key: "comentario#0", found: 3, total: 3, framing: { faceX: 0.5, eyeY: 0.4, mouthY: 0.48 }, faceH: 0.2 },
      { key: "comentario#1", found: 3, total: 3, framing: { faceX: 0.5, eyeY: 0.4, mouthY: 0.48 }, faceH: 0.2 },
    ]);
    assert.equal(r.changed, 1);
    assert.deepEqual(raw.blocks.comentario[0].framing, { faceX: 0.5, eyeY: 0.4, mouthY: 0.48 });
    assert.deepEqual(raw.blocks.comentario[1].framing, { faceX: 0.3, eyeY: 0.3 });
    assert.equal(r.kept.length, 1);
  });
});
