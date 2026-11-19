/**
 * Janela do A/B de redução de ruído escolhida pela densidade de fala (#13611).
 *
 * O A/B cego de 16/11 (`261116/ab-denoise/`) saiu com a janela fixa
 * `--start 120 --dur 60`, quase toda silêncio (voz só no fim do clip): dava para
 * ouvir as cigarras, não para julgar a voz. O refeito à mão escolheu a janela
 * pelas palavras do `transcript.json` (690 a 735 s, 33 s de fala em 45 s).
 *
 * Aqui: a fala é a soma da duração das palavras do `transcript.json` (o tempo
 * entre palavras não conta). Quando a decupagem já marcou o que vai ao ar
 * (itens com intervalo no `blocks.json`/`blocks.template.json`, as falas
 * "usar"), só as palavras dentro desses trechos contam, e a conversa de
 * bastidor fica de fora. Sem decupagem, os primeiros `minStartS` segundos ficam
 * de fora (o bastidor vem no começo do bruto).
 *
 * Funções puras: não leem arquivo nem rodam ffmpeg.
 */
import type { Interval, Word } from "./video-montage.ts";

/** Fala abaixo desta fração da janela: A/B recusado (sem `--force`). */
export const MIN_SPEECH_COVERAGE = 0.5;

/** Sem decupagem, o começo do bruto que fica de fora (bastidor): o `--start` fixo de antes. */
export const DEFAULT_SKIP_START_S = 120;

/** Junta intervalos que se tocam ou se sobrepõem, em ordem. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start).map((i) => ({ start: i.start, end: i.end })).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push(i);
  }
  return out;
}

/** Intersecção de duas listas de intervalos já juntados (`mergeIntervals`). */
function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (end > start) out.push({ start, end });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

/**
 * Os trechos de fala que contam: as palavras, juntadas, e (com `allowed`) só a
 * parte delas dentro dos trechos "usar" da decupagem.
 */
export function speechIntervals(words: readonly Word[], allowed?: readonly Interval[] | null): Interval[] {
  const speech = mergeIntervals(words);
  return allowed && allowed.length ? intersect(speech, mergeIntervals(allowed)) : speech;
}

/** Segundos de fala dentro de [start, end). */
export function speechSecondsIn(speech: readonly Interval[], start: number, end: number): number {
  let s = 0;
  for (const i of speech) {
    if (i.start >= end) break;
    s += Math.max(0, Math.min(end, i.end) - Math.max(start, i.start));
  }
  return s;
}

export interface SpeechWindow {
  start: number;
  end: number;
  /** Segundos de fala na janela. */
  speechS: number;
  /** `speechS / dur`. */
  coverage: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Fala de uma janela dada (para o `--start` explícito). */
export function windowSpeech(speech: readonly Interval[], start: number, dur: number): SpeechWindow {
  const speechS = speechSecondsIn(speech, start, start + dur);
  return { start, end: start + dur, speechS: round1(speechS), coverage: dur > 0 ? speechS / dur : 0 };
}

/**
 * A janela de `dur` segundos com mais fala, começando em `minStartS` ou depois
 * e terminando até o fim da última fala. A soma de fala é linear por partes no
 * início da janela, então o máximo cai num início alinhado a uma borda de
 * trecho (início do trecho, ou fim do trecho menos `dur`): só esses candidatos
 * são medidos. Empate: a que começa no início de uma fala, e depois a mais
 * cedo. `null` = nenhuma fala depois de `minStartS`.
 */
export function bestSpeechWindow(speech: readonly Interval[], dur: number, minStartS = 0): SpeechWindow | null {
  if (!(dur > 0)) throw new Error(`--dur deve ser positivo (veio ${dur})`);
  const usable = speech.filter((i) => i.end > minStartS);
  if (!usable.length) return null;
  const lastEnd = usable[usable.length - 1].end;
  const lo = minStartS;
  const hi = Math.max(lo, lastEnd - dur);
  const clamp = (x: number) => Math.min(hi, Math.max(lo, x));
  // Empate: a janela que começa no início de uma fala (para não abrir no meio de uma palavra), e depois a mais cedo.
  const byTime = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
  const candidates = [...new Set([...byTime(usable.map((i) => clamp(i.start))), ...byTime([lo, ...usable.map((i) => clamp(i.end - dur))])])];
  let best: SpeechWindow | null = null;
  for (const c of candidates) {
    const start = round1(c);
    const w = windowSpeech(speech, start, dur);
    if (!best || w.speechS > best.speechS) best = w;
  }
  return best;
}

/** Os trechos "usar" do `blocks.json`/`blocks.template.json`: itens com `start`/`end` no bruto. */
export function usarIntervalsFromBlocks(blocks: unknown): Interval[] {
  const b = (blocks as { blocks?: Record<string, unknown> } | null)?.blocks;
  if (!b || typeof b !== "object") return [];
  const out: Interval[] = [];
  for (const items of Object.values(b)) {
    if (!Array.isArray(items)) continue;
    for (const it of items as Array<{ start?: unknown; end?: unknown }>) {
      if (typeof it?.start === "number" && typeof it?.end === "number" && it.end > it.start) out.push({ start: it.start, end: it.end });
    }
  }
  return mergeIntervals(out);
}

/** Linha do terminal com a janela e a fala dela. */
export function formatWindowLine(w: SpeechWindow, how: string): string {
  return `Janela: ${w.start}s a ${round1(w.end)}s (${w.speechS}s de fala em ${round1(w.end - w.start)}s, ${Math.round(w.coverage * 100)}%) — ${how}`;
}
