/**
 * #12560 — rosto automático por tomada e folha de olhar. Fixture: as detecções
 * que o `face_detect.py` devolve (todos os rostos do cascade por frame); a
 * escolha e a mediana são do TS, testáveis sem OpenCV.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { applyItemFramings, gazeMarks, itemFramings, pickFace, type FrameDetection } from "../scripts/lib/diaria/video-face.ts";

describe("#12560 pickFace", () => {
  it("falso rosto no peito (botão do microfone) é descartado mesmo sendo maior", () => {
    const face = { x: 300, y: 200, w: 120, h: 120 };
    const chest = { x: 320, y: 900, w: 160, h: 160 };
    assert.deepEqual(pickFace([chest, face], 1280), face);
  });
  it("sem nada nos 2/3 de cima, o maior de todos; sem rosto, null", () => {
    const low = { x: 0, y: 1000, w: 50, h: 50 };
    assert.deepEqual(pickFace([low], 1280), low);
    assert.equal(pickFace([], 1280), null);
  });
});

describe("#12560 itemFramings", () => {
  const det = (key: string, faces: FrameDetection["faces"], w = 720, h = 1280): FrameDetection => ({ key, w, h, faces });
  it("mediana dos 3 frames: um frame errado não move o rosto; peito descartado", () => {
    const f = (x: number) => ({ x, y: 300, w: 144, h: 160 });
    const res = itemFramings(
      [det("comentario#0", [f(288)]), det("comentario#0", [f(290), { x: 300, y: 1000, w: 200, h: 200 }]), det("comentario#0", [f(500)])],
      ["comentario#0"],
    );
    assert.equal(res[0].found, 3);
    // centro = (290 + 72) / 720
    assert.deepEqual(res[0].framing, { faceX: Math.round(((290 + 72) / 720) * 1000) / 1000, eyeY: Math.round(((300 + 160 * 0.4) / 1280) * 1000) / 1000 });
  });
  it("sem rosto em nenhum frame (ou frame ilegível) = sem framing", () => {
    const res = itemFramings([det("fecho#0", []), det("fecho#0", [{ x: 1, y: 1, w: 9, h: 9 }], 0, 0)], ["fecho#0"]);
    assert.deepEqual(res[0], { key: "fecho#0", found: 0, total: 2, framing: null, faceH: null });
  });
});

describe("#12560 face --write", () => {
  it("grava só nos itens com rosto; item sem rosto mantém o framing medido à mão", () => {
    const raw = JSON.parse(readFileSync(new URL("./fixtures/video-montage-12559/blocks-face.json", import.meta.url), "utf8"));
    const before = JSON.parse(JSON.stringify(raw));
    const n = applyItemFramings(raw, [
      { key: "comentario#0", found: 3, total: 3, framing: { faceX: 0.51, eyeY: 0.33 }, faceH: 0.12 },
      { key: "comentario#1", found: 0, total: 3, framing: null, faceH: null },
      { key: "fecho#0", found: 2, total: 3, framing: { faceX: 0.49, eyeY: 0.34 }, faceH: 0.12 },
    ]);
    assert.equal(n, 2);
    assert.deepEqual(raw.blocks.comentario[0].framing, { faceX: 0.51, eyeY: 0.33 });
    assert.deepEqual(raw.blocks.comentario[1], before.blocks.comentario[1]);
    assert.deepEqual(raw.blocks.fecho[0].framing, { faceX: 0.49, eyeY: 0.34 });
    // o resto do arquivo não muda
    assert.deepEqual({ ...raw, blocks: undefined }, { ...before, blocks: undefined });
    assert.equal(raw.blocks.comentario[0].text, before.blocks.comentario[0].text);
    // rodar de novo com o mesmo resultado não muda nada
    assert.equal(applyItemFramings(raw, [{ key: "comentario#0", found: 3, total: 3, framing: { faceX: 0.51, eyeY: 0.33 }, faceH: 0.12 }]), 0);
  });
});

describe("#12560 gazeMarks", () => {
  it("início, meio e fim; no último, depois e depois+1s sem passar do fim do arquivo", () => {
    assert.deepEqual(gazeMarks(10, 12, false).map((m) => [m.label, m.t]), [["início", 10.12], ["meio", 11], ["fim", 11.88]]);
    const last = gazeMarks(10, 12, true, 12.5);
    assert.deepEqual(last.slice(3).map((m) => [m.label, m.t]), [["depois", 12.3], ["depois+1s", 12.45]]);
  });
});
