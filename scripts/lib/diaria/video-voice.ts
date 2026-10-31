/**
 * scripts/lib/diaria/video-voice.ts (#11507)
 *
 * Voz provável de cada segmento da decupagem, pela altura da voz (F0 mediana
 * do trecho). A 261029 foi gravada como entrevista: a Bruna pergunta, o Pixel
 * responde, e as falas dela saem da montagem. A decupagem não separava as
 * vozes; a atribuição foi lendo o texto, e um resumo da Bruna (5:49–5:56) pareceu
 * fala do Pixel até medir a F0: Pixel ~160–167 Hz, Bruna ~205–232 Hz, o trecho
 * ~205 Hz.
 *
 * Sem dependência nova: F0 por autocorrelação normalizada, em quadros de
 * 40 ms do áudio de 16 kHz do `transcribe` (decimado para 8 kHz), mediana dos
 * quadros com voz do segmento, só dentro das palavras dele (#11675). As vozes
 * saem de um 2-means no log da F0, pesado pelos segundos de FALA (não pela
 * duração do segmento, #11675); com os centros a menos de `VOICE.minRatio` (~3
 * semitons), a outra voz com pouca fala, ou os dois grupos sem vão entre eles
 * (`VOICE.minSeparation`), é uma voz só e nada é marcado (monólogo; a 261030
 * saiu como entrevista, com "cortar" em fala do roteiro). O Pixel é a voz com
 * mais tempo de fala (premissa: na entrevista é ele quem responde), ou a
 * referência `--pixel-f0` quando o editor passa.
 *
 * Puro: o CLI lê o `audio.wav` e passa as amostras.
 */

import type { Segment } from "./video-montage.ts";

export const VOICE = {
  /** Faixa de F0 procurada (voz falada adulta). */
  minHz: 70,
  maxHz: 400,
  /** Quadro e passo da análise. */
  frameS: 0.04,
  hopS: 0.02,
  /** Pico da autocorrelação normalizada acima disto = quadro com voz. */
  minClarity: 0.6,
  /** Quadro abaixo disto (dBFS) é silêncio, não analisado. */
  minDb: -45,
  /** Quadros com voz para a mediana valer (~0,4 s de voz; era 0,2 s até #11675). */
  minVoicedFrames: 20,
  /** Razão mínima entre os centros das duas vozes (~3 semitons). Abaixo, uma voz só. */
  minRatio: 1.18,
  /** Outra voz precisa de pelo menos esta fração do tempo de FALA medido (#11675: era 3% do tempo de segmento). */
  minShare: 0.05,
  /** E de pelo menos estes segundos de fala, somados (#11675). */
  minOtherSpeechS: 3,
  /**
   * Separação mínima entre as duas vozes, em desvios-padrão da F0 dentro de
   * cada uma (#11675). Partir em duas uma voz só dá ~2,6 (uma gaussiana
   * cortada ao meio); a 261030, monólogo, deu 2,6 pesada pela fala. Duas
   * vozes de verdade ficam separadas por um vão, acima disto.
   */
  minSeparation: 3.5,
  /** Faixa ambígua em torno do meio das duas vozes, em fração da distância (log) entre elas. */
  ambiguousBand: 0.15,
} as const;

/** Amostras de 16 bits → float a 8 kHz (média de pares: passa-baixa barato antes de decimar). */
function decimate(samples: Int16Array, sampleRate: number): { x: Float64Array; rate: number } {
  const factor = sampleRate >= 16000 ? Math.floor(sampleRate / 8000) : 1;
  const n = Math.floor(samples.length / factor);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < factor; k++) acc += samples[i * factor + k];
    x[i] = acc / factor / 32768;
  }
  return { x, rate: sampleRate / factor };
}

/**
 * F0 de um quadro por autocorrelação normalizada; null sem voz (quadro baixo
 * ou sem periodicidade). Para evitar o erro de oitava abaixo (o período dobrado
 * também correlaciona), fica com o 1º pico que chega a 90% do maior.
 */
export function frameF0(x: Float64Array, from: number, len: number, rate: number, opts: { minHz?: number; maxHz?: number; minClarity?: number; minDb?: number } = {}): number | null {
  const minLag = Math.max(2, Math.floor(rate / (opts.maxHz ?? VOICE.maxHz)));
  const maxLag = Math.ceil(rate / (opts.minHz ?? VOICE.minHz));
  if (from < 0 || from + len > x.length || len <= maxLag) return null;
  let energy = 0;
  let mean = 0;
  for (let i = 0; i < len; i++) mean += x[from + i];
  mean /= len;
  for (let i = 0; i < len; i++) energy += (x[from + i] - mean) ** 2;
  const rms = Math.sqrt(energy / len);
  if (!(rms > 0) || 20 * Math.log10(rms) < (opts.minDb ?? VOICE.minDb)) return null;
  const n = len - maxLag;
  const r = new Float64Array(maxLag + 1);
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += (x[from + i] - mean) ** 2;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let el = 0;
    for (let i = 0; i < n; i++) {
      const a = x[from + i] - mean;
      const b = x[from + i + lag] - mean;
      num += a * b;
      el += b * b;
    }
    r[lag] = e0 > 0 && el > 0 ? num / Math.sqrt(e0 * el) : 0;
    if (r[lag] > best) best = r[lag];
  }
  if (best < (opts.minClarity ?? VOICE.minClarity)) return null;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (r[lag] >= 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      // Interpolação parabólica do pico, para não quantizar a F0 no lag inteiro.
      const d = r[lag - 1] - 2 * r[lag] + r[lag + 1];
      const shift = d !== 0 ? (0.5 * (r[lag - 1] - r[lag + 1])) / d : 0;
      return rate / (lag + Math.max(-0.5, Math.min(0.5, shift)));
    }
  }
  return null;
}

/** Mediana da F0 dos quadros com voz em `[start, end]` (segundos); null com voz de menos. */
export function medianF0(samples: Int16Array, sampleRate: number, start: number, end: number): number | null {
  const { x, rate } = decimate(samples, sampleRate);
  return medianF0Of(x, rate, start, end);
}

function medianF0Of(x: Float64Array, rate: number, start: number, end: number, spans?: Array<[number, number]>): number | null {
  const len = Math.round(VOICE.frameS * rate);
  const hop = Math.max(1, Math.round(VOICE.hopS * rate));
  const f0s: number[] = [];
  for (let i = Math.max(0, Math.round(start * rate)); i + len <= Math.min(x.length, Math.round(end * rate)); i += hop) {
    if (spans) {
      // Só quadros cujo centro cai numa palavra (#11675).
      const c = (i + len / 2) / rate;
      if (!spans.some(([a, b]) => c >= a && c <= b)) continue;
    }
    const f = frameF0(x, i, len, rate);
    if (f !== null) f0s.push(f);
  }
  if (f0s.length < VOICE.minVoicedFrames) return null;
  f0s.sort((a, b) => a - b);
  const m = f0s.length >> 1;
  return f0s.length % 2 ? f0s[m] : (f0s[m - 1] + f0s[m]) / 2;
}

/**
 * Os intervalos de fala do segmento (#11675): as palavras do transcript,
 * recortadas ao segmento e fundidas onde se sobrepõem. Sem palavras com tempo,
 * o segmento inteiro. O Whisper estica o segmento sobre o silêncio antes da
 * frase (na 261030, 20–30 s para uma frase de 3 s), e a F0 desse trecho sem
 * fala (ruído, respiro) puxava a mediana para ~90–120 Hz.
 */
export function speechSpans(s: Pick<Segment, "start" | "end" | "words">): Array<[number, number]> {
  const ws = (s.words ?? [])
    .map((w): [number, number] => [Math.max(s.start, w.start), Math.min(s.end, w.end)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((p, q) => p[0] - q[0]);
  if (ws.length === 0) return s.end > s.start ? [[s.start, s.end]] : [];
  const out: Array<[number, number]> = [ws[0]];
  for (const [a, b] of ws.slice(1)) {
    const last = out[out.length - 1];
    if (a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Segundos de fala do segmento (soma de `speechSpans`), o peso de cada um na separação das vozes (#11675). */
export function speechSeconds(s: Pick<Segment, "start" | "end" | "words">): number {
  return speechSpans(s).reduce((n, [a, b]) => n + (b - a), 0);
}

/** F0 mediana de cada segmento, só nas palavras dele quando têm tempo (#11675); decima o áudio uma vez só. */
export function segmentF0s(samples: Int16Array, sampleRate: number, segments: Array<Pick<Segment, "start" | "end" | "words">>): Array<number | null> {
  const { x, rate } = decimate(samples, sampleRate);
  return segments.map((s) => medianF0Of(x, rate, s.start, s.end, speechSpans(s)));
}

export type VoiceLabel = "pixel" | "outra" | "ouvir";

export interface VoiceMark {
  label: VoiceLabel;
  /** F0 mediana do segmento; null = não medida (segmento curto ou sem voz). */
  f0: number | null;
}

export interface VoiceAnalysis {
  /** Duas vozes separadas o bastante para marcar. false = monólogo: `marks` todo null. */
  twoVoices: boolean;
  /** F0 de referência do Pixel e da outra voz (centros), quando medidas. */
  pixelHz: number | null;
  otherHz: number | null;
  /** De onde veio a referência do Pixel. */
  pixelFrom: "maior-tempo" | "referencia" | null;
  /** Por segmento; null quando não há o que marcar (uma voz só). */
  marks: Array<VoiceMark | null>;
}

/**
 * As vozes a partir das F0 por segmento. `pixelHz` (o `--pixel-f0` do editor)
 * fixa o Pixel; a outra voz é o centro do 2-means mais longe dele. Segmento
 * na faixa ambígua entre as duas, ou sem F0 medida, é "ouvir".
 */
export function classifyVoices(f0s: Array<number | null>, durations: number[], opts: { pixelHz?: number } = {}): VoiceAnalysis {
  const pts = f0s.map((f, i) => ({ l: f !== null && f > 0 ? Math.log(f) : null, w: Math.max(0, durations[i] ?? 0) })).filter((p): p is { l: number; w: number } => p.l !== null && p.w > 0);
  const none: VoiceAnalysis = { twoVoices: false, pixelHz: null, otherHz: null, pixelFrom: null, marks: f0s.map(() => null) };
  if (pts.length < 2) return none;
  const ls = pts.map((p) => p.l).sort((a, b) => a - b);
  let c1 = ls[0];
  let c2 = ls[ls.length - 1];
  if (c2 - c1 < Math.log(VOICE.minRatio) && opts.pixelHz === undefined) return { ...none, pixelHz: Math.exp(weightedMean(pts)) };
  let w1 = 0;
  let w2 = 0;
  for (let it = 0; it < 50; it++) {
    let s1 = 0;
    let s2 = 0;
    w1 = 0;
    w2 = 0;
    for (const p of pts) {
      if (Math.abs(p.l - c1) <= Math.abs(p.l - c2)) {
        s1 += p.l * p.w;
        w1 += p.w;
      } else {
        s2 += p.l * p.w;
        w2 += p.w;
      }
    }
    const n1 = w1 ? s1 / w1 : c1;
    const n2 = w2 ? s2 / w2 : c2;
    if (n1 === c1 && n2 === c2) break;
    c1 = n1;
    c2 = n2;
  }
  let pixel: number;
  let other: number;
  let from: VoiceAnalysis["pixelFrom"];
  if (opts.pixelHz !== undefined) {
    pixel = Math.log(opts.pixelHz);
    other = Math.abs(c1 - pixel) >= Math.abs(c2 - pixel) ? c1 : c2;
    from = "referencia";
  } else {
    [pixel, other] = w1 >= w2 ? [c1, c2] : [c2, c1];
    from = "maior-tempo";
  }
  const total = w1 + w2;
  // Sem a referência do editor, só é entrevista com a outra voz falando de
  // verdade (fração e segundos de fala) e separada da do Pixel por um vão, não
  // a cauda de uma voz só cortada pelo 2-means (#11675).
  const weak =
    opts.pixelHz === undefined &&
    (Math.min(w1, w2) / total < VOICE.minShare || Math.min(w1, w2) < VOICE.minOtherSpeechS || clusterSeparation(pts, c1, c2) < VOICE.minSeparation);
  if (Math.abs(other - pixel) < Math.log(VOICE.minRatio) || weak) {
    return { ...none, pixelHz: Math.exp(pixel), pixelFrom: from };
  }
  const mid = (pixel + other) / 2;
  const band = VOICE.ambiguousBand * Math.abs(other - pixel);
  const marks = f0s.map((f): VoiceMark => {
    if (f === null || !(f > 0)) return { label: "ouvir", f0: null };
    const l = Math.log(f);
    if (Math.abs(l - mid) < band) return { label: "ouvir", f0: f };
    return { label: Math.abs(l - pixel) < Math.abs(l - other) ? "pixel" : "outra", f0: f };
  });
  return { twoVoices: true, pixelHz: Math.exp(pixel), otherHz: Math.exp(other), pixelFrom: from, marks };
}

/**
 * Distância entre os dois centros (log da F0) em desvios-padrão da F0 dentro
 * dos grupos, pesada pela fala (#11675). Infinito quando os grupos não variam.
 */
export function clusterSeparation(pts: Array<{ l: number; w: number }>, c1: number, c2: number): number {
  let v = 0;
  let w = 0;
  for (const p of pts) {
    const c = Math.abs(p.l - c1) <= Math.abs(p.l - c2) ? c1 : c2;
    v += p.w * (p.l - c) ** 2;
    w += p.w;
  }
  const sd = w > 0 ? Math.sqrt(v / w) : 0;
  return sd > 0 ? Math.abs(c2 - c1) / sd : Number.POSITIVE_INFINITY;
}

function weightedMean(pts: Array<{ l: number; w: number }>): number {
  const w = pts.reduce((n, p) => n + p.w, 0);
  return pts.reduce((n, p) => n + p.l * p.w, 0) / w;
}

/** O texto da marca na listagem da decupagem. */
export function voiceHint(m: VoiceMark | null): string {
  if (!m) return "";
  const hz = m.f0 !== null ? `${Math.round(m.f0)} Hz` : "F0 não medida";
  if (m.label === "pixel") return `voz: Pixel, ${hz}`;
  if (m.label === "outra") return `voz: entrevistadora, ${hz}: cortar (fala da entrevistadora)`;
  return `voz: ouvir, ${hz}`;
}
