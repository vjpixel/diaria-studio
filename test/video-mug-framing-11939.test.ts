/**
 * #11939: a caneca diar.ia.br no enquadramento, como esforço. O rosto é a
 * prioridade (comentário do editor de 03/11/2026): o recorte sai do centro do
 * rosto no máximo `MUG_MAX_FACE_SHIFT` (2%) da largura do bruto para mostrar a
 * caneca; passou disso, mostra em parte no limite ou fica centrado, com aviso,
 * sem abortar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  frameCropOverlays,
  framingFor,
  mugFramingWarnings,
  MUG_MAX_FACE_SHIFT,
  parseBlocksFile,
} from "../scripts/lib/diaria/video-montage.ts";

const SRC = { srcW: 3840, srcH: 2160 };
const VERT = { ...SRC, seqW: 1080, seqH: 1920 };
const HORIZ = { ...SRC, seqW: 1920, seqH: 1080 };
const face = { faceX: 0.48, eyeY: 0.537 };
// 261103: caneca entre 58% e 64% da largura, rosto em 48%.
const mug261103 = { left: 0.58, right: 0.64, top: 0.6, bottom: 0.8 };

const centerOf = (fr: ReturnType<typeof framingFor>) => (fr.crop.x + fr.crop.w / 2) / SRC.srcW;

describe("framingFor com caneca (#11939)", () => {
  it("sem framing.mug o recorte é o de sempre (retrocompatível)", () => {
    for (const scalePct of [115, 130]) {
      const fr = framingFor({ ...VERT, scalePct, framing: face });
      assert.equal(fr.mug, undefined);
      assert.equal(fr.warning, undefined);
      assert.equal(fr.crop.x, Math.round(face.faceX * SRC.srcW - fr.crop.w / 2));
    }
  });

  it("261103 nas verticais: desloca só até 2% (o meio-termo 0,50 aceito), caneca em parte, aviso sem abortar", () => {
    for (const scalePct of [115, 130]) {
      const centered = framingFor({ ...VERT, scalePct, framing: face });
      const fr = framingFor({ ...VERT, scalePct, framing: { ...face, mug: mug261103 } });
      assert.equal(fr.mug, "parcial");
      assert.match(fr.warning!, /em parte/);
      const shift = fr.crop.x - centered.crop.x;
      assert.ok(shift > 0, "desloca para o lado da caneca");
      assert.ok(shift <= MUG_MAX_FACE_SHIFT * SRC.srcW, "nunca passa do limite");
      assert.ok(shift >= MUG_MAX_FACE_SHIFT * SRC.srcW - 1, "vai até o limite");
      // Mesmo recorte que o faceX 0,50 posto à mão na 261103.
      const manual = framingFor({ ...VERT, scalePct, framing: { ...face, faceX: 0.5 } });
      assert.ok(Math.abs(fr.crop.x - manual.crop.x) <= 1);
      // Nunca o 0,55 recusado pelo editor.
      assert.ok(Math.abs(centerOf(fr) - 0.55) > 0.04);
      assert.ok(fr.crop.x + fr.crop.w > mug261103.left * SRC.srcW, "parte da caneca dentro do recorte");
    }
  });

  it("caneca que cabe com deslocamento ≤ 2% sai inteira, com o MENOR deslocamento", () => {
    const centered = framingFor({ ...VERT, scalePct: 130, framing: face });
    const rightEdge = (centered.crop.x + centered.crop.w) / SRC.srcW;
    for (const over of [0, 0.005, 0.0199]) {
      const mug = { left: rightEdge - 0.03, right: rightEdge + over, top: 0.6, bottom: 0.7 };
      const fr = framingFor({ ...VERT, scalePct: 130, framing: { ...face, mug } });
      assert.equal(fr.mug, "inteira", `over=${over}`);
      assert.equal(fr.warning, undefined);
      const shift = fr.crop.x - centered.crop.x;
      assert.ok(Math.abs(shift - over * SRC.srcW) <= 1, `menor deslocamento (over=${over}, shift=${shift})`);
    }
  });

  it("caneca do lado esquerdo desloca para a esquerda", () => {
    const centered = framingFor({ ...VERT, scalePct: 130, framing: face });
    const leftEdge = centered.crop.x / SRC.srcW;
    const mug = { left: leftEdge - 0.01, right: leftEdge + 0.02, top: 0.6, bottom: 0.7 };
    const fr = framingFor({ ...VERT, scalePct: 130, framing: { ...face, mug } });
    assert.equal(fr.mug, "inteira");
    assert.ok(fr.crop.x < centered.crop.x);
    // Arredonda em direção ao rosto: até 1 px da caixa pode ficar fora.
    assert.ok(fr.crop.x <= mug.left * SRC.srcW + 1);
  });

  it("caneca longe demais: recorte centrado no rosto, caneca fora, aviso", () => {
    const centered = framingFor({ ...VERT, scalePct: 130, framing: face });
    const fr = framingFor({ ...VERT, scalePct: 130, framing: { ...face, mug: { left: 0.85, right: 0.9, top: 0.6, bottom: 0.8 } } });
    assert.equal(fr.mug, "fora");
    assert.deepEqual(fr.crop, centered.crop);
    assert.match(fr.warning!, /fora do recorte/);
  });

  it("caneca fora da faixa vertical do recorte: centrado, aviso", () => {
    const centered = framingFor({ ...HORIZ, scalePct: 62, framing: face });
    const fr = framingFor({ ...HORIZ, scalePct: 62, framing: { ...face, mug: { ...mug261103, top: 0.98, bottom: 0.999 } } });
    if (centered.crop.y + centered.crop.h <= 0.98 * SRC.srcH) {
      assert.equal(fr.mug, "fora");
      assert.deepEqual(fr.crop, centered.crop);
    }
  });

  it("horizontal (50/62%) com a caneca da 261103: já cabe, recorte não muda", () => {
    for (const scalePct of [50, 62]) {
      const plain = framingFor({ ...HORIZ, scalePct, framing: face });
      const fr = framingFor({ ...HORIZ, scalePct, framing: { ...face, mug: mug261103 } });
      assert.deepEqual(fr.crop, plain.crop);
      assert.deepEqual(fr.center, plain.center);
      assert.equal(fr.mug, "inteira");
      assert.equal(fr.warning, undefined);
    }
  });
});

describe("mugFramingWarnings / frameCropOverlays (#11939)", () => {
  const plans = [
    { spec: { name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080 }, clips: [{ scale: 50 }, { scale: 62 }, { scale: 50 }] },
    { spec: { name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920 }, clips: [{ scale: 130 }, { scale: 115 }] },
  ];
  const source = { width: SRC.srcW, height: SRC.srcH };

  it("aviso só nas escalas em que a caneca não sai inteira, uma vez por escala", () => {
    const w = mugFramingWarnings(plans, source, { ...face, mug: mug261103 });
    assert.equal(w.length, 2);
    assert.match(w[0], /Vertical_V1 \(115%\)/);
    assert.match(w[1], /Vertical_V1 \(130%\)/);
  });

  it("sem framing.mug: uma linha pedindo a caixa", () => {
    const w = mugFramingWarnings(plans, source, face);
    assert.equal(w.length, 1);
    assert.match(w[0], /framing\.mug/);
  });

  it("frame desenha os 4 recortes e a caixa da caneca", () => {
    const o = frameCropOverlays(source, { ...face, mug: mug261103 });
    assert.equal(o.filters.length, 5);
    assert.ok(o.filters.every((x) => /^drawbox=x=\d+:y=\d+:w=\d+:h=\d+:color=\w+@[\d.]+:t=\d+$/.test(x)), o.filters.join("\n"));
    assert.equal(o.filters.filter((x) => x.includes("yellow")).length, 2);
    assert.equal(o.filters.filter((x) => x.includes("cyan")).length, 2);
    assert.ok(o.filters[4].includes("magenta"));
    assert.equal(o.warnings.length, 2);
    assert.equal(frameCropOverlays(source, face).filters.length, 4);
  });
});

describe("parseBlocksFile: framing.mug (#11939)", () => {
  const file = { edition: "261103", blocks: {}, framing: face };
  it("aceita blocks sem mug e com mug válido", () => {
    assert.equal(parseBlocksFile(file).ok, true);
    const r = parseBlocksFile({ ...file, framing: { ...face, mug: mug261103 } });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.file.framing?.mug, mug261103);
  });
  it("recusa caixa fora de 0..1, invertida ou não numérica", () => {
    for (const mug of [{ ...mug261103, left: 2 }, { ...mug261103, right: 0.58 }, { ...mug261103, top: 0.9 }, { ...mug261103, top: "0.6" }, [0.5]]) {
      const r = parseBlocksFile({ ...file, framing: { ...face, mug } });
      assert.equal(r.ok, false, JSON.stringify(mug));
      if (!r.ok) assert.ok(r.errors.some((e) => e.includes("framing.mug")));
    }
  });
});
