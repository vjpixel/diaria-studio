/**
 * scripts/lib/diaria/video-face-incremental.ts (#13588, item B da #13463) —
 * `face` incremental e com 1 frame por item.
 *
 * Até aqui o `face --write` media TODOS os itens do `blocks.json` a cada
 * volta (3 frames por item, ~40 itens) e só gravava nos sem `framing`: trocar
 * 5 tomadas custava as 40 medições de novo.
 *
 * Incremental: a medida de cada item fica em `face-cache.json` (state dir),
 * com a chave = hash do intervalo medido (mais o arquivo do bruto, o
 * `mirrored` efetivo dele, o tamanho e o mtime dele, #13608, e o jeito de medir). Na volta seguinte só o item com intervalo novo (tomada trocada,
 * item novo) vai ao detector; o resto sai do cache. `--all` mede tudo.
 *
 * 1 frame por item (`--um-frame`): o frame do meio da fala; 25%/75% só nos
 * itens em que o do meio não achou rosto. Fica opcional: o `face-compare
 * --um-frame` (#13370) da 261117 e da 261118 (300, 18/11/2026) mostrou o acerto
 * contra o `framing` aprovado PIOR com 1 frame (35 → 32 de 38 e 39 → 34 de 42
 * itens a até 1%), então o padrão segue 3 frames (#13588; tabela em
 * `docs/video-montagem-resolucao-tomadas-13463.md`).
 *
 * Puro: frames e detector entram por parâmetro (`runFaceMeasurement`).
 */

import { createHash } from "node:crypto";
import { EYE_IN_FACE, FACE_SAMPLE_FRACTIONS, MIN_FACE_FRAMES, MOUTH_IN_FACE, itemFramings, pickFace, type FrameDetection, type ItemFaceResult } from "./video-face.ts";

/** Arquivo do cache, no state dir da montagem. */
export const FACE_CACHE_FILE = "face-cache.json";

/** O frame do meio e o reforço quando ele não acha rosto (#13588). */
export const FACE_ONE_FRAME = { middle: 0.5, fallback: [0.25, 0.75] } as const;

/** Sobe à mão só quando o formato do cache muda (campos da entrada); o jeito de medir entra sozinho em `FACE_CACHE_VERSION`. */
const FACE_CACHE_SCHEMA = 1;

/**
 * Impressão do jeito de medir no lado TS (review da PR #13595): constantes e o
 * código de `pickFace`/`itemFramings`. Mudar qualquer um muda a versão do
 * cache e invalida tudo sem bump manual. O `face_detect.py` (parâmetros do
 * Haar) entra pela impressão do detector que o chamador passa em `opts.detector`.
 */
export function faceMeasureFingerprint(): string {
  return createHash("sha256")
    .update(JSON.stringify({ MIN_FACE_FRAMES, FACE_SAMPLE_FRACTIONS, EYE_IN_FACE, MOUTH_IN_FACE, FACE_ONE_FRAME }))
    .update(pickFace.toString())
    .update(itemFramings.toString())
    .digest("hex")
    .slice(0, 12);
}

/** Versão do cache: formato + impressão do jeito de medir. Cache de outra versão = vazio (mede tudo). */
export const FACE_CACHE_VERSION = `${FACE_CACHE_SCHEMA}-${faceMeasureFingerprint()}`;

export type FaceSampling = "tres-frames" | "um-frame";

export interface FaceItem {
  /** `{bloco}#{índice}` do item no blocks.json. */
  key: string;
  interval: { start: number; end: number };
  /** O arquivo do bruto do item (bruto em vários arquivos, #12559); ausente = bruto único. */
  source?: string;
  /**
   * O `mirrored` efetivo do arquivo do item (review da PR #13595): o frame é
   * desespelhado na captura, então trocar o `mirrored` no blocks.json muda o
   * `faceX` medido e precisa invalidar a medida em cache.
   */
  mirrored?: boolean;
  /**
   * #13608: tamanho e mtime do arquivo do bruto do item (`statSync`), como os
   * outros caches da montagem (proxy, quadros dos trechos). O bruto trocado no
   * Drive pelo MESMO nome (reexport, novo upload) muda os dois e invalida a
   * medida; sem eles a chave só via o caminho e reaproveitava o `faceX` do
   * arquivo antigo. Ausente = não lido (a chave fica sem o carimbo).
   */
  sourceStat?: { size: number; mtimeMs: number };
}

export interface FaceCacheEntry {
  interval: { start: number; end: number };
  sampling: FaceSampling;
  result: Omit<ItemFaceResult, "key">;
  at: string;
}

export interface FaceCache {
  version: string;
  entries: Record<string, FaceCacheEntry>;
}

export const emptyFaceCache = (): FaceCache => ({ version: FACE_CACHE_VERSION, entries: {} });

/** Cache lido do disco; ilegível, de outra versão ou ausente = vazio (mede tudo, nunca erra por cache). */
export function parseFaceCache(raw: unknown): FaceCache {
  if (!raw || typeof raw !== "object") return emptyFaceCache();
  const c = raw as Partial<FaceCache>;
  if (c.version !== FACE_CACHE_VERSION || !c.entries || typeof c.entries !== "object" || Array.isArray(c.entries)) return emptyFaceCache();
  return { version: FACE_CACHE_VERSION, entries: { ...c.entries } };
}

/**
 * Chave do item no cache: hash do bruto, do arquivo do item, do `mirrored`
 * efetivo dele, do tamanho e do mtime do arquivo (#13608), do intervalo (ms),
 * do jeito de medir e da impressão do detector. A mesma tomada em outro bloco
 * reaproveita a medida; a tomada trocada (outro intervalo), o espelhamento
 * trocado ou o bruto trocado pelo mesmo nome não.
 */
export function faceCacheKey(bruto: string, item: Pick<FaceItem, "interval" | "source" | "mirrored" | "sourceStat">, sampling: FaceSampling, detector = ""): string {
  const ms = (x: number) => Math.round(x * 1000);
  const mir = item.mirrored === undefined ? "" : item.mirrored ? "1" : "0";
  const stat = item.sourceStat ? `${item.sourceStat.size}|${Math.round(item.sourceStat.mtimeMs)}` : "|";
  return createHash("sha256")
    .update(`${FACE_CACHE_VERSION}|${detector}|${sampling}|${bruto}|${item.source ?? ""}|${mir}|${stat}|${ms(item.interval.start)}|${ms(item.interval.end)}`)
    .digest("hex")
    .slice(0, 24);
}

/** Os itens a medir agora e os que saem do cache. */
export function planFaceRun(items: readonly FaceItem[], cache: FaceCache, opts: { bruto: string; sampling: FaceSampling; all?: boolean; detector?: string }): { measure: FaceItem[]; cached: ItemFaceResult[] } {
  const measure: FaceItem[] = [];
  const cached: ItemFaceResult[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const hit = opts.all ? undefined : cache.entries[faceCacheKey(opts.bruto, it, opts.sampling, opts.detector)];
    if (hit) cached.push({ key: it.key, ...hit.result });
    else if (!seen.has(it.key)) {
      seen.add(it.key);
      measure.push(it);
    }
  }
  return { measure, cached };
}

/** Itens cujo frame do meio não teve rosto (ou saiu ilegível): esses ganham 25%/75%. */
export function middleMisses(dets: readonly FrameDetection[], keys: readonly string[]): string[] {
  return keys.filter((k) => {
    const mine = dets.filter((d) => d.key === k);
    return !mine.some((d) => d.w > 0 && d.h > 0 && pickFace(d.faces, d.h) !== null);
  });
}

export interface FaceFrameRequest {
  key: string;
  /** Instante, no bruto, do frame. */
  t: number;
}

const frameAt = (it: FaceItem, q: number): FaceFrameRequest => ({ key: it.key, t: it.interval.start + (it.interval.end - it.interval.start) * q });

export interface FaceMeasurementIO {
  /** Tira os frames pedidos e roda o detector; devolve uma detecção por frame, com a `key` do item. */
  detect(frames: FaceFrameRequest[]): FrameDetection[];
}

export interface FaceMeasurement {
  /** Uma por item, na ordem de `items` (medida agora ou do cache). */
  results: ItemFaceResult[];
  /** Itens que foram ao detector nesta volta. */
  measured: string[];
  /** Itens que saíram do cache. */
  fromCache: string[];
  /** Frames analisados nesta volta. */
  frames: number;
  /** O cache já com as medidas desta volta (para gravar). */
  cache: FaceCache;
}

/**
 * Uma volta do `face`: o que o cache não tem vai ao detector (3 frames, ou o
 * do meio e o reforço 25%/75% onde ele não achou rosto) e entra no cache.
 */
export function runFaceMeasurement(
  items: readonly FaceItem[],
  cache: FaceCache,
  io: FaceMeasurementIO,
  opts: { bruto: string; sampling: FaceSampling; all?: boolean; now?: string; /** Impressão do detector (ex.: hash do `face_detect.py`): mudar o detector invalida o cache. */ detector?: string },
): FaceMeasurement {
  const { measure, cached } = planFaceRun(items, cache, opts);
  let frames = 0;
  let dets: FrameDetection[] = [];
  if (measure.length) {
    if (opts.sampling === "um-frame") {
      const first = measure.map((it) => frameAt(it, FACE_ONE_FRAME.middle));
      dets = io.detect(first);
      frames += first.length;
      const miss = new Set(middleMisses(dets, measure.map((it) => it.key)));
      const more = measure.filter((it) => miss.has(it.key)).flatMap((it) => FACE_ONE_FRAME.fallback.map((q) => frameAt(it, q)));
      if (more.length) {
        dets = [...dets, ...io.detect(more)];
        frames += more.length;
      }
    } else {
      const all = measure.flatMap((it) => FACE_SAMPLE_FRACTIONS.map((q) => frameAt(it, q)));
      dets = io.detect(all);
      frames += all.length;
    }
  }
  const fresh = itemFramings(dets, measure.map((it) => it.key));
  const byKey = new Map<string, ItemFaceResult>([...cached, ...fresh].map((r) => [r.key, r]));
  const next: FaceCache = { version: FACE_CACHE_VERSION, entries: { ...cache.entries } };
  const at = opts.now ?? new Date().toISOString();
  for (const it of measure) {
    const r = byKey.get(it.key)!;
    const { key: _k, ...result } = r;
    next.entries[faceCacheKey(opts.bruto, it, opts.sampling, opts.detector)] = { interval: { ...it.interval }, sampling: opts.sampling, result, at };
  }
  return {
    results: items.map((it) => ({ ...byKey.get(it.key)!, key: it.key })),
    measured: measure.map((it) => it.key),
    fromCache: cached.map((r) => r.key),
    frames,
    cache: next,
  };
}
