/**
 * #13588 (item B da #13463): `face` incremental e com 1 frame por item. O
 * detector entra mockado (`detect`), contando os frames; nada roda OpenCV nem
 * ffmpeg.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACE_CACHE_VERSION,
  FACE_ONE_FRAME,
  faceMeasureFingerprint,
  emptyFaceCache,
  faceCacheKey,
  middleMisses,
  parseFaceCache,
  planFaceRun,
  runFaceMeasurement,
  type FaceFrameRequest,
  type FaceItem,
} from "../scripts/lib/diaria/video-face-incremental.ts";
import type { FrameDetection } from "../scripts/lib/diaria/video-face.ts";

const BRUTO = "I:/Meu Drive/diaria-studio-video/261118/20261117_181712.mp4";
/** Rosto do editor no 1/3 de cima de um frame 720x1280 (faceX ~0,485, como na 261118). */
const FACE = { x: 277, y: 300, w: 144, h: 160 };

/** 40 itens, como o blocks.json da 261117/261118. */
function items(n = 40): FaceItem[] {
  return Array.from({ length: n }, (_, i) => ({ key: `comentario#${i}`, interval: { start: 100 + i * 10, end: 105 + i * 10 } }));
}

/** Detector mockado: rosto em todo frame, menos nos instantes de `blink` (piscada/cabeça virada). */
function detector(blink: (f: FaceFrameRequest) => boolean = () => false) {
  const calls: FaceFrameRequest[][] = [];
  return {
    calls,
    detect(frames: FaceFrameRequest[]): FrameDetection[] {
      calls.push(frames);
      return frames.map((f) => ({ key: f.key, w: 720, h: 1280, faces: blink(f) ? [] : [FACE] }));
    },
  };
}

test("#13588 aceite: depois de trocar 5 tomadas, o face mede 5 itens, não 40; --all mede tudo", () => {
  const its = items();
  const d1 = detector();
  const first = runFaceMeasurement(its, emptyFaceCache(), d1, { bruto: BRUTO, sampling: "tres-frames", now: "2026-11-18T00:00:00Z" });
  assert.equal(first.measured.length, 40);
  assert.equal(first.frames, 120);
  // A volta seguinte com 5 tomadas trocadas (outro intervalo).
  const swapped = its.map((it, i) => (i % 8 === 0 ? { ...it, interval: { start: it.interval.start + 2, end: it.interval.end + 2 } } : it));
  const d2 = detector();
  const second = runFaceMeasurement(swapped, parseFaceCache(JSON.parse(JSON.stringify(first.cache))), d2, { bruto: BRUTO, sampling: "tres-frames" });
  assert.equal(second.measured.length, 5);
  assert.deepEqual(second.measured, ["comentario#0", "comentario#8", "comentario#16", "comentario#24", "comentario#32"]);
  assert.equal(second.fromCache.length, 35);
  assert.equal(second.frames, 15);
  assert.equal(second.results.length, 40);
  assert.ok(second.results.every((r) => r.framing !== null));
  // --all ignora o cache.
  const d3 = detector();
  assert.equal(runFaceMeasurement(swapped, second.cache, d3, { bruto: BRUTO, sampling: "tres-frames", all: true }).measured.length, 40);
  // Nada trocado: zero frames.
  const d4 = detector();
  const idle = runFaceMeasurement(swapped, second.cache, d4, { bruto: BRUTO, sampling: "tres-frames" });
  assert.equal(idle.frames, 0);
  assert.equal(d4.calls.length, 0);
});

test("#13588: a chave do cache muda com o intervalo, o arquivo do bruto e o jeito de medir; não com o bloco", () => {
  const it = { interval: { start: 424.3, end: 434.51 } };
  const k = faceCacheKey(BRUTO, it, "tres-frames");
  assert.equal(k, faceCacheKey(BRUTO, { interval: { start: 424.3004, end: 434.5104 } }, "tres-frames"), "mesmo intervalo em ms");
  assert.notEqual(k, faceCacheKey(BRUTO, { interval: { start: 424.4, end: 434.51 } }, "tres-frames"));
  assert.notEqual(k, faceCacheKey(BRUTO, { ...it, source: "20261117_183905" }, "tres-frames"));
  assert.notEqual(k, faceCacheKey("outro.mp4", it, "tres-frames"));
  assert.notEqual(k, faceCacheKey(BRUTO, it, "um-frame"));
  assert.notEqual(k, faceCacheKey(BRUTO, it, "tres-frames", "outro-detector"));
  // O mesmo intervalo em outro bloco (resumo e resumo_curto) sai do cache.
  const cache = runFaceMeasurement([{ key: "resumo#0", ...it }], emptyFaceCache(), detector(), { bruto: BRUTO, sampling: "tres-frames" }).cache;
  assert.deepEqual(planFaceRun([{ key: "resumo_curto#0", ...it }], cache, { bruto: BRUTO, sampling: "tres-frames" }).measure, []);
});

test("#13588: cache ilegível ou de outra versão vale como vazio (mede tudo, nunca erra por cache)", () => {
  for (const raw of [null, "x", [], { version: `${FACE_CACHE_VERSION}x`, entries: {} }, { version: 1, entries: {} }, { version: FACE_CACHE_VERSION, entries: [] }]) {
    assert.deepEqual(parseFaceCache(raw), emptyFaceCache());
  }
});

test("#13588: 1 frame por item, no meio da fala; 25/75% só onde o do meio não achou rosto", () => {
  const its = items(10);
  // Piscada no meio dos itens 3 e 7.
  const blinkAt = new Set([3, 7].map((i) => its[i].interval.start + (its[i].interval.end - its[i].interval.start) * FACE_ONE_FRAME.middle));
  const d = detector((f) => blinkAt.has(f.t));
  const m = runFaceMeasurement(its, emptyFaceCache(), d, { bruto: BRUTO, sampling: "um-frame" });
  assert.equal(d.calls.length, 2);
  assert.equal(d.calls[0].length, 10, "1 frame por item");
  assert.deepEqual(d.calls[1].map((f) => f.key), ["comentario#3", "comentario#3", "comentario#7", "comentario#7"]);
  assert.equal(m.frames, 14, "contra 30 com 3 frames por item");
  // Item com 1 frame achado: framing; item com reforço: framing pelos 2 frames de 25/75%.
  assert.ok(m.results.every((r) => r.framing !== null));
  assert.equal(m.results[0].total, 1);
  assert.deepEqual([m.results[3].found, m.results[3].total], [2, 3]);
  // O mesmo rosto que os 3 frames dariam (detector estável).
  const three = runFaceMeasurement(its, emptyFaceCache(), detector(), { bruto: BRUTO, sampling: "tres-frames" });
  assert.deepEqual(m.results.map((r) => r.framing), three.results.map((r) => r.framing));
});

test("#13588: frame do meio ilegível ou só com falso rosto no peito conta como sem rosto (vai ao reforço)", () => {
  const dets: FrameDetection[] = [
    { key: "a#0", w: 0, h: 0, faces: [] },
    { key: "b#0", w: 720, h: 1280, faces: [{ x: 300, y: 1000, w: 200, h: 200 }] },
    { key: "c#0", w: 720, h: 1280, faces: [FACE] },
  ];
  assert.deepEqual(middleMisses(dets, ["a#0", "b#0", "c#0"]), ["a#0", "b#0"]);
});

test("review da PR #13595: trocar só o mirrored do arquivo do item invalida a medida em cache", () => {
  const it: FaceItem = { key: "comentario#0", interval: { start: 424.3, end: 434.51 }, mirrored: false };
  assert.notEqual(faceCacheKey(BRUTO, it, "tres-frames"), faceCacheKey(BRUTO, { ...it, mirrored: true }, "tres-frames"));
  const first = runFaceMeasurement([it], emptyFaceCache(), detector(), { bruto: BRUTO, sampling: "tres-frames" });
  const same = planFaceRun([it], first.cache, { bruto: BRUTO, sampling: "tres-frames" });
  assert.deepEqual([same.measure.length, same.cached.length], [0, 1], "nada trocado: sai do cache");
  const flipped = planFaceRun([{ ...it, mirrored: true }], first.cache, { bruto: BRUTO, sampling: "tres-frames" });
  assert.deepEqual(flipped.measure.map((x) => x.key), ["comentario#0"], "mirrored trocado: mede de novo");
  assert.deepEqual(flipped.cached, []);
});

test("review da PR #13595: a versão do cache deriva das constantes e do código de medir (sem bump manual)", () => {
  assert.match(FACE_CACHE_VERSION, /^\d+-[0-9a-f]{12}$/);
  assert.ok(FACE_CACHE_VERSION.endsWith(faceMeasureFingerprint()));
  // Trocar o detector (o hash do face_detect.py que o chamador passa) também invalida.
  const it: FaceItem = { key: "a#0", interval: { start: 1, end: 2 } };
  const cache = runFaceMeasurement([it], emptyFaceCache(), detector(), { bruto: BRUTO, sampling: "tres-frames", detector: "py-v1" }).cache;
  assert.equal(planFaceRun([it], cache, { bruto: BRUTO, sampling: "tres-frames", detector: "py-v1" }).measure.length, 0);
  assert.equal(planFaceRun([it], cache, { bruto: BRUTO, sampling: "tres-frames", detector: "py-v2" }).measure.length, 1);
});
