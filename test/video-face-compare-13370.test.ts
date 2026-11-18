/**
 * #13370 (R3 da #13199) — medição do Haar contra o MediaPipe na detecção de
 * rosto, antes de trocar o detector. Fixture: a saída REAL do
 * `face_detect.py` (Haar, venv da montagem) e do `face_detect.py --detector
 * mediapipe` (mediapipe 0.10.21, CPU, no 300) em 3 frames do bruto da 261117
 * mais um frame ilegível, em 17/11/2026. No frame aos 90 s o Haar não achou o
 * rosto e o MediaPipe achou (score 0,88).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  aggregateFaceCompare,
  compareFaceDetectors,
  FACE_COMPARE_MIN_EDITIONS,
  FACE_COMPARE_TOL,
  type FaceCompareReport,
  type FaceReference,
} from "../scripts/lib/diaria/video-face-compare.ts";
import type { FrameDetection } from "../scripts/lib/diaria/video-face.ts";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/video-medicoes-13369-13370/${name}`, import.meta.url), "utf8")) as FrameDetection[];
const HAAR = fx("face-haar-261117.json");
const MP = fx("face-mediapipe-261117.json");

describe("#13370 compareFaceDetectors (fixture real da 261117)", () => {
  const refs: FaceReference[] = [
    { key: "c#0", faceX: 0.53, eyeY: 0.42, fonte: "arquivo" },
    { key: "c#1", faceX: 0.52, eyeY: 0.39, fonte: "item" },
  ];
  const r = compareFaceDetectors({ edition: "261117", haar: HAAR, mediapipe: MP, refs, skipped: [{ key: "fecho#0", reason: "sem referência" }] });

  it("o Haar perde o rosto no frame dos 90 s e fica sem framing no item; o MediaPipe acha nos dois", () => {
    const c0 = r.items.find((i) => i.key === "c#0")!;
    assert.equal(c0.detectors.haar.found, 1);
    assert.equal(c0.detectors.haar.framing, null);
    assert.equal(c0.detectors.haar.errFaceX, null);
    assert.equal(c0.detectors.mediapipe.found, 2);
    assert.ok(c0.detectors.mediapipe.framing);
    // Olhos e boca do MediaPipe vêm dos pontos do rosto, não da fração da caixa.
    assert.equal(c0.detectors.mediapipe.framing!.eyeY, Math.round((921.8 / 2160) * 1000) / 1000);
    assert.equal(c0.detectors.mediapipe.errFaceX, Math.round(Math.abs(c0.detectors.mediapipe.framing!.faceX - 0.53) * 10000) / 10000);
  });

  it("frame ilegível não conta nos frames; resumo separado por fonte da referência", () => {
    assert.deepEqual(
      { hits: r.summary.total.haar.frameHits, frames: r.summary.total.haar.frames },
      { hits: 2, frames: 3 },
    );
    assert.deepEqual({ hits: r.summary.total.mediapipe.frameHits, frames: r.summary.total.mediapipe.frames }, { hits: 3, frames: 3 });
    assert.equal(r.summary.arquivo.haar.items, 1);
    assert.equal(r.summary.item.mediapipe.items, 1);
    assert.equal(r.summary.arquivo.mediapipe.itemsWithFace, 1);
    assert.equal(r.summary.arquivo.haar.itemsWithFace, 0);
    assert.deepEqual(r.skipped, [{ key: "fecho#0", reason: "sem referência" }]);
  });
});

describe("#13370 aggregateFaceCompare", () => {
  const det = (key: string, faceX: number, eyeY: number): FrameDetection[] => {
    const box = { x: Math.round(faceX * 720) - 40, y: Math.round(eyeY * 405) - 32, w: 80, h: 80 };
    return [0, 1, 2].map(() => ({ key, w: 720, h: 405, faces: [box] }));
  };
  const report = (edition: string, haarOff: number, mpOff: number): FaceCompareReport =>
    compareFaceDetectors({
      edition,
      haar: det("c#0", 0.5 + haarOff, 0.4),
      mediapipe: det("c#0", 0.5 + mpOff, 0.4),
      refs: [{ key: "c#0", faceX: 0.5, eyeY: 0.4, fonte: "arquivo" }],
    });

  it("menos de 5 edições = insuficiente, nunca uma leitura", () => {
    const a = aggregateFaceCompare([report("261101", 0.03, 0)]);
    assert.equal(a.reading, "insuficiente");
    assert.match(a.notes[0], new RegExp(`pelo menos ${FACE_COMPARE_MIN_EDITIONS} edições`));
  });

  it("MediaPipe com erro menor em 5 edições sustenta a troca; maior, não", () => {
    const eds = ["261101", "261102", "261103", "261104", "261105"];
    const melhor = aggregateFaceCompare(eds.map((e) => report(e, 0.03, 0)));
    assert.equal(melhor.reading, "sustenta-troca");
    assert.equal(melhor.arquivo.mediapipe.withinTol, 5);
    assert.ok((melhor.arquivo.haar.medianErrFaceX ?? 0) > FACE_COMPARE_TOL);
    const pior = aggregateFaceCompare(eds.map((e) => report(e, 0, 0.03)));
    assert.equal(pior.reading, "nao-sustenta");
  });

  it("referência do item (pode ter vindo do Haar) fica fora da leitura, com nota", () => {
    const r = compareFaceDetectors({ edition: "261101", haar: det("c#0", 0.5, 0.4), mediapipe: det("c#0", 0.5, 0.4), refs: [{ key: "c#0", faceX: 0.5, eyeY: 0.4, fonte: "item" }] });
    const a = aggregateFaceCompare([r, r, r, r, r]);
    assert.equal(a.arquivo.haar.items, 0);
    assert.equal(a.reading, "insuficiente");
    assert.ok(a.notes.some((n) => n.includes("framing próprio")));
  });
});
