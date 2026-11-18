/**
 * scripts/lib/diaria/video-face-incremental.ts (#13588, item B da #13463) —
 * `face` incremental e com 1 frame por item.
 *
 * Até aqui o `face --write` media TODOS os itens do `blocks.json` a cada
 * volta (3 frames por item, ~40 itens) e só gravava nos sem `framing`: trocar
 * 5 tomadas custava as 40 medições de novo.
 *
 * Incremental: a medida de cada item fica em `face-cache.json` (state dir),
 * com a chave = hash do intervalo medido (mais o arquivo do bruto e o jeito de
 * medir). Na volta seguinte só o item com intervalo novo (tomada trocada,
 * item novo) vai ao detector; o resto sai do cache. `--all` mede tudo.
 *
 * 1 frame por item (`--um-frame`): o frame do meio da fala; 25%/75% só nos
 * itens em que o do meio não achou rosto. Opcional até o `face-compare
 * --um-frame` (#13370) da 261117 e da 261118 mostrar que não piora o acerto
 * contra o `framing` aprovado; aí vira o padrão.
 *
 * Puro: frames e detector entram por parâmetro (`runFaceMeasurement`).
 */

import { createHash } from "node:crypto";
import { FACE_SAMPLE_FRACTIONS, itemFramings, pickFace, type FrameDetection, type ItemFaceResult } from "./video-face.ts";

/** Arquivo do cache, no state dir da montagem. */
export const FACE_CACHE_FILE = "face-cache.json";
/** Sobe quando o jeito de medir muda (detector, frações): invalida o cache inteiro. */
export const FACE_CACHE_VERSION = 1;

/** O frame do meio e o reforço quando ele não acha rosto (#13588). */
export const FACE_ONE_FRAME = { middle: 0.5, fallback: [0.25, 0.75] } as const;

export type FaceSampling = "tres-frames" | "um-frame";

export interface FaceItem {
  /** `{bloco}#{índice}` do item no blocks.json. */
  key: string;
  interval: { start: number; end: number };
  /** O arquivo do bruto do item (bruto em vários arquivos, #12559); ausente = bruto único. */
  source?: string;
}

export interface FaceCacheEntry {
  interval: { start: number; end: number };
  sampling: FaceSampling;
  result: Omit<ItemFaceResult, "key">;
  at: string;
}

export interface FaceCache {
  version: number;
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
 * Chave do item no cache: hash do bruto, do arquivo do item, do intervalo (ms)
 * e do jeito de medir. A mesma tomada em outro bloco reaproveita a medida; a
 * tomada trocada (outro intervalo) não.
 */
export function faceCacheKey(bruto: string, item: Pick<FaceItem, "interval" | "source">, sampling: FaceSampling): string {
  const ms = (x: number) => Math.round(x * 1000);
  return createHash("sha256")
    .update(`${FACE_CACHE_VERSION}|${sampling}|${bruto}|${item.source ?? ""}|${ms(item.interval.start)}|${ms(item.interval.end)}`)
    .digest("hex")
    .slice(0, 24);
}

/** Os itens a medir agora e os que saem do cache. */
export function planFaceRun(items: readonly FaceItem[], cache: FaceCache, opts: { bruto: string; sampling: FaceSampling; all?: boolean }): { measure: FaceItem[]; cached: ItemFaceResult[] } {
  const measure: FaceItem[] = [];
  const cached: ItemFaceResult[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const hit = opts.all ? undefined : cache.entries[faceCacheKey(opts.bruto, it, opts.sampling)];
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
  opts: { bruto: string; sampling: FaceSampling; all?: boolean; now?: string },
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
    next.entries[faceCacheKey(opts.bruto, it, opts.sampling)] = { interval: { ...it.interval }, sampling: opts.sampling, result, at };
  }
  return {
    results: items.map((it) => ({ ...byKey.get(it.key)!, key: it.key })),
    measured: measure.map((it) => it.key),
    fromCache: cached.map((r) => r.key),
    frames,
    cache: next,
  };
}
