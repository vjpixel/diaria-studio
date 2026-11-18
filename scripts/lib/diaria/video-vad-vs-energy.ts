/**
 * scripts/lib/diaria/video-vad-vs-energy.ts (#13598, filha da #13463)
 *
 * MEDIÇÃO: ilhas de fala do Silero VAD contra as do detector de energia + F0
 * do `build` (`speechIslands`, #12089), ambas contra o que o editor fez com o
 * corte no Premiere (registro do `video-xml-vs-final`, #13196). Não troca o
 * detector. Puro: o CLI (`scripts/video-vad-vs-energia.ts`) lê os arquivos.
 *
 * Referência do editor, por sequência do registro (linha do tempo do bruto):
 *   - fala = clipes mantidos [srcIn − headMs, srcOut + tailMs] menos as
 *     pausas internas que ele pulou;
 *   - pausa cortada = essas pausas internas (o editor decidiu que ali não é fala).
 * Os dois tipos de intervalo são encolhidos de `erodeS` em cada ponta: o editor
 * deixa ~80 ms de folga na entrada e ~120 ms na saída, que não são fala.
 *
 * Métricas:
 *   - `speechRecall`: fração da fala do editor coberta por ilhas (o resto seria fala cortada);
 *   - `pauseFalsePositive`: fração do tempo das pausas cortadas que o detector chama de fala
 *     (respiração/ruído que sobraria como fala);
 *   - `pausesWithIsland`: pausas cortadas em que sobra ilha de pelo menos `minHitS`.
 */

import type { Interval } from "./video-montage.ts";
import type { ClipComparison, EditionRecord } from "./video-xml-vs-final.ts";

export const VAD_VS_ENERGY_SCHEMA = 1;

export const VAD_ISLANDS = {
  threshold: 0.5,
  /** Os mesmos do detector de energia (`SPEECH_DETECT.minGapS` / `minIslandS`), para a comparação ser justa. */
  minGapS: 0.32,
  minIslandS: 0.06,
  erodeS: 0.12,
  minHitS: 0.064,
} as const;

export interface VadProbs {
  hopS: number;
  probs: number[];
}

/** Ilhas do Silero: janelas ≥ limiar, ilhas a menos de `minGapS` unidas, depois as menores que `minIslandS` descartadas. */
export function vadIslands(v: VadProbs, o: { threshold?: number; minGapS?: number; minIslandS?: number } = {}): Interval[] {
  const th = o.threshold ?? VAD_ISLANDS.threshold;
  const gap = o.minGapS ?? VAD_ISLANDS.minGapS;
  const min = o.minIslandS ?? VAD_ISLANDS.minIslandS;
  const raw: Interval[] = [];
  let open = -1;
  for (let i = 0; i <= v.probs.length; i++) {
    const on = i < v.probs.length && v.probs[i] >= th;
    if (on && open < 0) open = i;
    else if (!on && open >= 0) {
      raw.push({ start: open * v.hopS, end: i * v.hopS });
      open = -1;
    }
  }
  const merged: Interval[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < gap - 1e-9) last.end = r.end;
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.end - r.start >= min - 1e-9);
}

const total = (xs: Interval[]) => xs.reduce((a, x) => a + (x.end - x.start), 0);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Interseção de duas listas ordenadas e disjuntas. */
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i].start, b[j].start);
    const e = Math.min(a[i].end, b[j].end);
    if (e > s) out.push({ start: s, end: e });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

/** a − b, ambas ordenadas e disjuntas. */
export function subtract(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    let cur = x.start;
    for (const y of b) {
      if (y.end <= cur || y.start >= x.end) continue;
      if (y.start > cur) out.push({ start: cur, end: y.start });
      cur = Math.max(cur, y.end);
    }
    if (cur < x.end) out.push({ start: cur, end: x.end });
  }
  return out;
}

function union(xs: Interval[]): Interval[] {
  const s = [...xs].sort((p, q) => p.start - q.start);
  const out: Interval[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

function erode(xs: Interval[], by: number): Interval[] {
  return xs.map((x) => ({ start: x.start + by, end: x.end - by })).filter((x) => x.end > x.start);
}

export interface EditorReference {
  speech: Interval[];
  pauses: Interval[];
}

/** Fala e pausas cortadas do editor, na linha do tempo do bruto, já encolhidas de `erodeS`. */
export function editorReference(clips: ClipComparison[], erodeS: number = VAD_ISLANDS.erodeS): EditorReference {
  const speech: Interval[] = [];
  const pauses: Interval[] = [];
  for (const c of clips) {
    if (c.status !== "kept") continue;
    const start = c.srcIn - (c.headMs ?? 0) / 1000;
    const end = c.srcOut + (c.tailMs ?? 0) / 1000;
    const holes = union(c.internalPauses.map((p) => ({ start: p.start, end: p.end })));
    speech.push(...subtract([{ start, end }], holes));
    pauses.push(...holes);
  }
  return { speech: erode(union(speech), erodeS), pauses: erode(union(pauses), erodeS) };
}

export interface DetectorScore {
  islands: number;
  islandSeconds: number;
  speechRecall: number;
  pauseFalsePositive: number;
  pauses: number;
  pausesWithIsland: number;
}

export function scoreDetector(islands: Interval[], ref: EditorReference, minHitS: number = VAD_ISLANDS.minHitS): DetectorScore {
  const speechT = total(ref.speech);
  const pauseT = total(ref.pauses);
  const sorted = union(islands);
  return {
    islands: islands.length,
    islandSeconds: r3(total(islands)),
    speechRecall: speechT > 0 ? r3(total(intersect(ref.speech, sorted)) / speechT) : 0,
    pauseFalsePositive: pauseT > 0 ? r3(total(intersect(ref.pauses, sorted)) / pauseT) : 0,
    pauses: ref.pauses.length,
    pausesWithIsland: ref.pauses.filter((p) => total(intersect([p], sorted)) >= minHitS - 1e-9).length,
  };
}

export interface SeqScore {
  seq: string;
  editorSpeechS: number;
  editorPauseS: number;
  energia: DetectorScore;
  silero: DetectorScore;
}

export interface CompareReport {
  schema: typeof VAD_VS_ENERGY_SCHEMA;
  edition: string;
  durationS: number;
  cpuS: { energia: number | null; silero: number | null };
  sequences: SeqScore[];
}

export function compareDetectors(input: {
  record: EditionRecord;
  energyIslands: Interval[];
  sileroIslands: Interval[];
  durationS: number;
  cpuS: CompareReport["cpuS"];
}): CompareReport {
  const sequences: SeqScore[] = input.record.sequences.map((s) => {
    const ref = editorReference(s.detail?.clips ?? []);
    return {
      seq: s.key,
      editorSpeechS: r3(total(ref.speech)),
      editorPauseS: r3(total(ref.pauses)),
      energia: scoreDetector(input.energyIslands, ref),
      silero: scoreDetector(input.sileroIslands, ref),
    };
  });
  return { schema: VAD_VS_ENERGY_SCHEMA, edition: input.record.edition, durationS: input.durationS, cpuS: input.cpuS, sequences };
}
