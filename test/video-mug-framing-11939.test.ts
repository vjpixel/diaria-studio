import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { framingFor, parseBlocksFile } from "../scripts/lib/diaria/video-montage.ts";

const base = { srcW: 3840, srcH: 2160, seqW: 1080, seqH: 1920, scalePct: 130 };
const face = { faceX: 0.48, eyeY: 0.537 };
const mug = { left: 0.58, right: 0.64, top: 0.65, bottom: 0.8 };
describe("caneca como esforço, rosto prioritário (#11939)", () => {
  it("261103: não seleciona 0.55 para mostrar a caneca inteira; não aborta", () => {
    for (const scalePct of [115, 130]) {
      const centered = framingFor({ ...base, scalePct, framing: face });
      const result = framingFor({ ...base, scalePct, framing: { ...face, mug } });
      assert.deepEqual(result.crop, centered.crop);
      assert.match(result.warning!, /2%.*rosto centrado/);
    }
  });
  it("seleciona o menor deslocamento, aceita exatamente 2% e recusa acima", () => {
    const centered = framingFor({ ...base, framing: face });
    const edge = (face.faceX * base.srcW + centered.crop.w / 2) / base.srcW;
    for (const shift of [0, 0.01, 0.02, 0.02001]) {
      const result = framingFor({ ...base, framing: { ...face, mug: { ...mug, left: edge - 0.01, right: edge + shift } } });
      if (shift > 0.02) {
        assert.deepEqual(result.crop, centered.crop);
        assert.ok(result.warning);
      } else {
        assert.equal(result.warning, undefined);
        assert.ok(Math.abs(result.crop.x + result.crop.w / 2 - face.faceX * base.srcW) <= 0.02 * base.srcW + 1e-8);
        assert.ok(Math.abs(result.crop.x - centered.crop.x - shift * base.srcW) <= 1);
      }
    }
  });
  it("horizontal não muda quando a caneca já cabe; XML/prévia usam o mesmo recorte", () => {
    for (const scalePct of [50, 62]) {
      const input = { ...base, seqW: 1920, seqH: 1080, scalePct };
      assert.deepEqual(framingFor({ ...input, framing: { ...face, mug } }), framingFor({ ...input, framing: face }));
    }
  });
  it("preserva o meio-termo manual aceito 0.50 sem exigir visibilidade integral", () => {
    const result = framingFor({ ...base, framing: { ...face, faceX: 0.50 } });
    assert.equal(result.warning, undefined);
    assert.ok(result.crop.x + result.crop.w > mug.left * base.srcW);
    assert.ok(result.crop.x + result.crop.w < mug.right * base.srcW);
  });
  it("valida caixa opcional sem quebrar blocks antigos", () => {
    const file = { edition: "261103", blocks: {}, framing: face };
    assert.equal(parseBlocksFile(file).ok, true);
    assert.equal(parseBlocksFile({ ...file, framing: { ...face, mug } }).ok, true);
    for (const box of [{ ...mug, left: 2 }, { ...mug, right: mug.left }, { ...mug, top: "0.5" }]) {
      assert.equal(parseBlocksFile({ ...file, framing: { ...face, mug: box } }).ok, false);
    }
  });
  it("caixa maior que recorte ou fora verticalmente apenas avisa", () => {
    for (const box of [{ ...mug, left: 0, right: 1 }, { ...mug, top: 0, bottom: 1 }]) {
      assert.ok(framingFor({ ...base, framing: { ...face, mug: box } }).warning);
    }
  });
});
