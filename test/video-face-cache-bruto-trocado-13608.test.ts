/**
 * #13608 — a chave do `face-cache.json` não levava o tamanho nem o mtime do
 * bruto. Com o bruto trocado no Drive pelo MESMO nome (reexport, novo upload),
 * o `face` incremental reaproveitava `faceX`/`eyeY`/`mouthY` do arquivo antigo
 * nos intervalos que coincidiam, sem aviso. O proxy e os caches de quadros já
 * invalidavam por tamanho/mtime.
 *
 * Cobre: a chave muda com o tamanho e com o mtime; o plano mede de novo o item
 * do bruto trocado; `faceItemsOf` carimba cada item com o `statSync` do arquivo
 * dele (bruto único e bruto em vários arquivos), e o `statSync` que falha deixa
 * o item sem carimbo, sem lançar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyFaceCache,
  faceCacheKey,
  planFaceRun,
  runFaceMeasurement,
  type FaceFrameRequest,
  type FaceItem,
} from "../scripts/lib/diaria/video-face-incremental.ts";
import type { SourceInfo } from "../scripts/lib/diaria/video-montage.ts";
import { faceItemsOf } from "../scripts/video-montagem.ts";

const BRUTO = "I:/Meu Drive/diaria-studio-video/261118/20261117_181712.mp4";
const FACE = { x: 277, y: 300, w: 144, h: 160 };
const detect = { detect: (frames: FaceFrameRequest[]) => frames.map((f) => ({ key: f.key, w: 720, h: 1280, faces: [FACE] })) };

test("#13608: mesmo caminho, tamanho ou mtime diferente = outra chave", () => {
  const it: FaceItem = { key: "comentario#0", interval: { start: 424.3, end: 434.51 }, mirrored: false, sourceStat: { size: 1_000_000, mtimeMs: 1_763_400_000_000 } };
  const k = faceCacheKey(BRUTO, it, "tres-frames");
  assert.equal(k, faceCacheKey(BRUTO, { ...it, sourceStat: { size: 1_000_000, mtimeMs: 1_763_400_000_000 } }, "tres-frames"), "mesmo arquivo: mesma chave");
  assert.notEqual(k, faceCacheKey(BRUTO, { ...it, sourceStat: { size: 1_000_001, mtimeMs: 1_763_400_000_000 } }, "tres-frames"), "tamanho trocado");
  assert.notEqual(k, faceCacheKey(BRUTO, { ...it, sourceStat: { size: 1_000_000, mtimeMs: 1_763_400_999_000 } }, "tres-frames"), "mtime trocado");
  assert.notEqual(k, faceCacheKey(BRUTO, { interval: it.interval, mirrored: false },"tres-frames"), "sem carimbo não colide com o carimbado");
});

test("#13608 cenário da issue: o bruto trocado pelo mesmo nome mede de novo, o intacto sai do cache", () => {
  const velho: FaceItem = { key: "comentario#0", interval: { start: 424.3, end: 434.51 }, mirrored: false, sourceStat: { size: 5_000, mtimeMs: 100 } };
  const first = runFaceMeasurement([velho], emptyFaceCache(), detect, { bruto: BRUTO, sampling: "tres-frames" });
  const intacto = planFaceRun([velho], first.cache, { bruto: BRUTO, sampling: "tres-frames" });
  assert.deepEqual([intacto.measure.length, intacto.cached.length], [0, 1]);
  const trocado = planFaceRun([{ ...velho, sourceStat: { size: 6_000, mtimeMs: 200 } }], first.cache, { bruto: BRUTO, sampling: "tres-frames" });
  assert.deepEqual(trocado.measure.map((x) => x.key), ["comentario#0"], "bruto novo com o mesmo nome: mede de novo");
  assert.deepEqual(trocado.cached, []);
});

test("#13608: faceItemsOf carimba cada item com o stat do arquivo dele; stat que falha deixa sem carimbo", () => {
  const single: SourceInfo = { path: BRUTO, fps: 30, durationS: 600, width: 1080, height: 1920, mirrored: false };
  const resolved = { comentario: [{ interval: { start: 10, end: 20 } }, { interval: { start: 30, end: 40 } }] } as never;
  const seen: string[] = [];
  const items = faceItemsOf(single, resolved, (p) => {
    seen.push(p);
    return { size: 42, mtimeMs: 7 };
  });
  assert.deepEqual(items.map((x) => x.sourceStat), [{ size: 42, mtimeMs: 7 }, { size: 42, mtimeMs: 7 }]);
  assert.deepEqual(seen, [BRUTO], "um stat por arquivo, não por item");

  const multi: SourceInfo = {
    ...single,
    files: [
      { id: "a", path: "/v/a.mp4", offsetFrames: 0, frames: 30 * 100, width: 1080, height: 1920 },
      { id: "b", path: "/v/b.mp4", offsetFrames: 30 * 100, frames: 30 * 100, width: 1080, height: 1920 },
    ],
  } as SourceInfo;
  const two = faceItemsOf(multi, { comentario: [{ interval: { start: 10, end: 20 } }, { interval: { start: 150, end: 160 } }] } as never, (p) => {
    if (p === "/v/b.mp4") throw new Error("ENOENT");
    return { size: 1, mtimeMs: 2 };
  });
  assert.deepEqual(two[0].sourceStat, { size: 1, mtimeMs: 2 });
  assert.equal(two[1].sourceStat, undefined, "stat que falha: sem carimbo, sem lançar");
});
