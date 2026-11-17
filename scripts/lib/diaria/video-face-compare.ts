/**
 * scripts/lib/diaria/video-face-compare.ts (#13370, R3 da #13199)
 *
 * MEDIÇÃO, não troca de detector: o Haar cascade (`face_detect.py`, #12560)
 * contra o MediaPipe (BlazeFace, `face_detect.py --detector mediapipe`) nos
 * MESMOS frames de cada item (25/50/75% da fala, os do `face`), comparados com
 * o `framing` já aprovado no `blocks.json`. O CLI é `video-montagem.ts
 * face-compare AAMMDD` (uma edição, relatório em `face-compare.json` no work
 * dir) e `video-medicoes.ts rosto-agrega` (5 a 10 edições). A troca no
 * `face_detect.py` só vem depois, se a medição sustentar, por decisão do
 * editor.
 *
 * A referência de cada item: o `framing` do próprio item (`fonte: "item"`)
 * ou o do arquivo (`fonte: "arquivo"`). O do item pode ter vindo de um
 * `face --write` (Haar), o que favorece o Haar; por isso o resumo sai
 * separado por fonte, e o do arquivo (medido à mão pelo editor no `frame`) é
 * o que decide. Edição sem `framing` no `blocks.json` (o default da 261027)
 * não tem referência e fica de fora.
 *
 * Puro: recebe as detecções (`FrameDetection[]` dos dois detectores) e as
 * referências; quem extrai frame e roda Python é o CLI.
 */

import { itemFramings, type FrameDetection, type ItemFaceResult } from "./video-face.ts";

export const FACE_COMPARE_SCHEMA = 1;

/** Erro (fração do quadro) até o qual a medida conta como "bate com o aprovado": 1%, o `FACE_CENTER_TOL` do recorte. */
export const FACE_COMPARE_TOL = 0.01;

export type FaceDetectorName = "haar" | "mediapipe";
export const FACE_DETECTORS: readonly FaceDetectorName[] = ["haar", "mediapipe"];

export interface FaceReference {
  key: string;
  faceX: number;
  eyeY: number;
  fonte: "item" | "arquivo";
}

export interface DetectorItemMeasure {
  found: number;
  total: number;
  framing: ItemFaceResult["framing"];
  /** |medido − aprovado|, em fração do quadro; null sem rosto. */
  errFaceX: number | null;
  errEyeY: number | null;
}

export interface FaceCompareItem {
  key: string;
  reference: FaceReference;
  detectors: Record<FaceDetectorName, DetectorItemMeasure>;
}

export interface DetectorSummary {
  items: number;
  /** Itens com framing proposto (rosto em 2 de 3 frames). */
  itemsWithFace: number;
  /** Frames com rosto escolhido (`pickFace`) / frames legíveis. */
  frameHits: number;
  frames: number;
  medianErrFaceX: number | null;
  medianErrEyeY: number | null;
  /** Itens com os dois erros até `FACE_COMPARE_TOL`. */
  withinTol: number;
}

export interface FaceCompareReport {
  schema: typeof FACE_COMPARE_SCHEMA;
  edition: string;
  method: "face-compare-v1";
  items: FaceCompareItem[];
  /** Resumo por fonte da referência e no total. */
  summary: Record<"total" | "arquivo" | "item", Record<FaceDetectorName, DetectorSummary>>;
  /** Itens sem referência (edição sem framing gravado) ou sem frame. */
  skipped: Array<{ key: string; reason: string }>;
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function frameHits(dets: readonly FrameDetection[], keys: ReadonlySet<string>): { hits: number; frames: number } {
  let hits = 0;
  let frames = 0;
  for (const d of dets) {
    if (!keys.has(d.key) || !(d.w > 0 && d.h > 0)) continue;
    frames++;
    // Mesma escolha do `pickFace`: rosto com centro nos 2/3 de cima.
    if (d.faces.some((f) => f.y + f.h / 2 < d.h * 0.66)) hits++;
  }
  return { hits, frames };
}

function summarize(items: readonly FaceCompareItem[], det: FaceDetectorName, dets: readonly FrameDetection[]): DetectorSummary {
  const ms = items.map((i) => i.detectors[det]);
  const withFace = ms.filter((m) => m.framing);
  const { hits, frames } = frameHits(dets, new Set(items.map((i) => i.key)));
  const mx = median(withFace.map((m) => m.errFaceX as number));
  const my = median(withFace.map((m) => m.errEyeY as number));
  return {
    items: items.length,
    itemsWithFace: withFace.length,
    frameHits: hits,
    frames,
    medianErrFaceX: mx === null ? null : r4(mx),
    medianErrEyeY: my === null ? null : r4(my),
    withinTol: withFace.filter((m) => (m.errFaceX as number) <= FACE_COMPARE_TOL + 1e-9 && (m.errEyeY as number) <= FACE_COMPARE_TOL + 1e-9).length,
  };
}

/**
 * Compara os dois detectores numa edição. `refs` traz a referência de cada
 * item que tem uma; item das detecções sem referência vai para `skipped`.
 */
export function compareFaceDetectors(input: {
  edition: string;
  haar: readonly FrameDetection[];
  mediapipe: readonly FrameDetection[];
  refs: readonly FaceReference[];
  /** Itens sem referência, com o motivo (o CLI sabe por quê). */
  skipped?: Array<{ key: string; reason: string }>;
}): FaceCompareReport {
  const keys = input.refs.map((r) => r.key);
  const per: Record<FaceDetectorName, ItemFaceResult[]> = {
    haar: itemFramings(input.haar, keys),
    mediapipe: itemFramings(input.mediapipe, keys),
  };
  const items: FaceCompareItem[] = input.refs.map((ref, i) => {
    const m = (det: FaceDetectorName): DetectorItemMeasure => {
      const r = per[det][i];
      return {
        found: r.found,
        total: r.total,
        framing: r.framing,
        errFaceX: r.framing ? r4(Math.abs(r.framing.faceX - ref.faceX)) : null,
        errEyeY: r.framing ? r4(Math.abs(r.framing.eyeY - ref.eyeY)) : null,
      };
    };
    return { key: ref.key, reference: ref, detectors: { haar: m("haar"), mediapipe: m("mediapipe") } };
  });
  const by = (fonte?: FaceReference["fonte"]) => {
    const sub = fonte ? items.filter((i) => i.reference.fonte === fonte) : items;
    return { haar: summarize(sub, "haar", input.haar), mediapipe: summarize(sub, "mediapipe", input.mediapipe) };
  };
  return {
    schema: FACE_COMPARE_SCHEMA,
    edition: input.edition,
    method: "face-compare-v1",
    items,
    summary: { total: by(), arquivo: by("arquivo"), item: by("item") },
    skipped: input.skipped ?? [],
  };
}

export interface FaceCompareAggregate {
  editions: string[];
  /** Soma por detector, só referências do ARQUIVO (medidas à mão; as do item podem ter vindo do Haar). */
  arquivo: Record<FaceDetectorName, { items: number; itemsWithFace: number; frameHits: number; frames: number; withinTol: number; medianErrFaceX: number | null; medianErrEyeY: number | null }>;
  /**
   * Leitura mecânica, não decisão: `sustenta-troca` quando o MediaPipe acha
   * rosto em pelo menos tantos itens quanto o Haar e tem erro mediano menor
   * ou igual nos dois eixos, com pelo menos `minEditions` edições;
   * `insuficiente` com menos edições ou sem item com referência do arquivo.
   */
  reading: "sustenta-troca" | "nao-sustenta" | "insuficiente";
  notes: string[];
}

/** Mínimo de edições da medição (a issue pede 5 a 10). */
export const FACE_COMPARE_MIN_EDITIONS = 5;

export function aggregateFaceCompare(reports: readonly FaceCompareReport[], minEditions = FACE_COMPARE_MIN_EDITIONS): FaceCompareAggregate {
  const notes: string[] = [];
  const arquivo = {} as FaceCompareAggregate["arquivo"];
  for (const det of FACE_DETECTORS) {
    const ms = reports.flatMap((r) => r.items.filter((i) => i.reference.fonte === "arquivo").map((i) => i.detectors[det]));
    const withFace = ms.filter((m) => m.framing);
    const sum = (k: "frameHits" | "frames") => reports.reduce((n, r) => n + r.summary.arquivo[det][k], 0);
    const mx = median(withFace.map((m) => m.errFaceX as number));
    const my = median(withFace.map((m) => m.errEyeY as number));
    arquivo[det] = {
      items: ms.length,
      itemsWithFace: withFace.length,
      frameHits: sum("frameHits"),
      frames: sum("frames"),
      withinTol: withFace.filter((m) => (m.errFaceX as number) <= FACE_COMPARE_TOL + 1e-9 && (m.errEyeY as number) <= FACE_COMPARE_TOL + 1e-9).length,
      medianErrFaceX: mx === null ? null : r4(mx),
      medianErrEyeY: my === null ? null : r4(my),
    };
  }
  const editions = [...new Set(reports.map((r) => r.edition))].sort();
  let reading: FaceCompareAggregate["reading"];
  const h = arquivo.haar;
  const m = arquivo.mediapipe;
  if (editions.length < minEditions || h.items === 0) {
    reading = "insuficiente";
    notes.push(`${editions.length} edição(ões) com ${h.items} item(ns) de referência do arquivo; a medição pede pelo menos ${minEditions} edições`);
  } else {
    const leq = (a: number | null, b: number | null) => a !== null && (b === null || a <= b + 1e-9);
    reading = m.itemsWithFace >= h.itemsWithFace && leq(m.medianErrFaceX, h.medianErrFaceX) && leq(m.medianErrEyeY, h.medianErrEyeY) ? "sustenta-troca" : "nao-sustenta";
  }
  const itemRefs = reports.reduce((n, r) => n + r.items.filter((i) => i.reference.fonte === "item").length, 0);
  if (itemRefs) notes.push(`${itemRefs} item(ns) com framing próprio ficaram fora da leitura (podem ter vindo de um face --write com o Haar)`);
  return { editions, arquivo, reading, notes };
}
