/**
 * scripts/lib/diaria/video-audio-align.ts (#11504)
 *
 * Aproveita uma transcrição feita num ÁUDIO separado que é o mesmo som do
 * bruto de vídeo, só com pausas cortadas. Na 261029 o editor transcreveu o
 * `Diaria comentada_Youtube.wav` (10:44) antes de o vídeo (11:41) chegar; o
 * deslocamento vídeo − áudio mudava em 4 trechos (+47,075 s até 0:43,7 do
 * wav; +50,643; +53,209; +56,643 s a partir de 0:59,6). O remapeamento foi à
 * mão, por correlação cruzada em janelas de 20 s.
 *
 * Aqui, puro (o CLI decodifica os dois áudios e roda a retranscrição):
 *   1. `alignEnvelopes`: envelope de energia (dB, o `energyEnvelope` do refino
 *      dos cortes) do áudio contra o do vídeo, correlação de Pearson em janelas
 *      de `windowS` (grossa a 1/`coarseFactor` da taxa, depois fina em volta do
 *      pico). As janelas boas dão os deslocamentos candidatos.
 *   2. Rotulagem monótona dos sub-trechos (`stepS`) do áudio entre esses
 *      deslocamentos (programação dinâmica: o deslocamento só cresce, porque o
 *      áudio é o vídeo com pausas tiradas). Sub-trecho que nenhum deslocamento
 *      explica (correlação baixa, e não é silêncio) fica sem par.
 *   3. `remapToVideo`: as palavras do áudio dentro de um trecho com par (a
 *      `marginS` das bordas) vão para o tempo do vídeo; o que fica de fora no
 *      vídeo (a pausa cortada no áudio, as bordas, o começo antes do áudio) sai
 *      em `uncovered`, para retranscrever só isso no vídeo.
 *   4. `mergeRetranscribed`: junta as palavras retranscritas (só as que caem
 *      em `uncovered`) com as remapeadas, em ordem.
 */

import { joinWordTexts, type Interval, type Segment, type Transcript, type Word } from "./video-montage.ts";

export const ALIGN_DEFAULTS = {
  /** Janela da correlação (a do remapeamento manual da 261029). */
  windowS: 20,
  /** Passo entre janelas (metade: janelas sobrepostas localizam melhor o corte). */
  windowHopS: 10,
  /** Fator de decimação da busca grossa (envelope de 100 Hz → 10 Hz). */
  coarseFactor: 10,
  /** Correlação mínima de uma janela "boa" (o mesmo som: perto de 1). */
  minScore: 0.85,
  /** Deslocamentos a menos disto (s) são o mesmo trecho. */
  sameOffsetS: 0.05,
  /** Sub-trechos da rotulagem: passo e largura (s). */
  stepS: 0.25,
  subWinS: 2,
  /** Sub-trecho com correlação abaixo disto, sob o deslocamento escolhido, fica sem par. */
  minSubScore: 0.5,
  /** Desvio-padrão (dB) abaixo do qual o sub-trecho é silêncio (neutro na rotulagem). */
  flatStdDb: 3,
  /** Custo de trocar de deslocamento na rotulagem (evita trocar por ruído). */
  switchPenalty: 2,
  /** Folga nas bordas de cada trecho: palavra a menos disto da troca é retranscrita no vídeo. */
  marginS: 0.3,
  /** Abaixo do piso, o envelope é cortado (silêncio digital não domina a correlação). */
  floorDb: -80,
  /** Folga da busca do deslocamento além da diferença de duração (s). */
  searchSlackS: 5,
  /** Cobertura mínima do áudio para o alinhamento valer. */
  minCoverage: 0.6,
} as const;

export type AlignOptions = Partial<{ [K in keyof typeof ALIGN_DEFAULTS]: number }> & { minOffsetS?: number; maxOffsetS?: number };

export interface AlignWindow {
  audioStart: number;
  audioEnd: number;
  /** vídeo − áudio (s), no pico da correlação; null em janela de silêncio. */
  offset: number | null;
  score: number;
}

/** Um trecho do áudio com par no vídeo: tempo do vídeo = tempo do áudio + `offset`. */
export interface AlignRun {
  audioStart: number;
  audioEnd: number;
  offset: number;
}

export interface AlignResult {
  hopS: number;
  windows: AlignWindow[];
  /** Deslocamentos distintos achados, em ordem. */
  offsets: number[];
  /** Trechos com par, em ordem; entre eles, áudio sem par. */
  runs: AlignRun[];
  /** Fração do áudio coberta por `runs`. */
  coverage: number;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function clampFloor(db: ArrayLike<number>, floor: number): Float64Array {
  const out = new Float64Array(db.length);
  for (let i = 0; i < db.length; i++) out[i] = Math.max(floor, db[i]);
  return out;
}

function decimateMean(x: Float64Array, k: number): Float64Array {
  const n = Math.floor(x.length / k);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += x[i * k + j];
    out[i] = s / k;
  }
  return out;
}

/** Somas acumuladas (x e x²) para média/desvio de qualquer trecho em O(1). */
function prefix(x: Float64Array): { s: Float64Array; q: Float64Array } {
  const s = new Float64Array(x.length + 1);
  const q = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) {
    s[i + 1] = s[i] + x[i];
    q[i + 1] = q[i] + x[i] * x[i];
  }
  return { s, q };
}

function stats(p: { s: Float64Array; q: Float64Array }, a: number, n: number): { mean: number; std: number } {
  const mean = (p.s[a + n] - p.s[a]) / n;
  const v = (p.q[a + n] - p.q[a]) / n - mean * mean;
  return { mean, std: v > 0 ? Math.sqrt(v) : 0 };
}

/** Pearson entre `a[ia..ia+n)` e `b[ib..ib+n)`; 0 se algum lado é constante ou sai do vetor. */
function pearsonAt(a: Float64Array, pa: ReturnType<typeof prefix>, ia: number, b: Float64Array, pb: ReturnType<typeof prefix>, ib: number, n: number): number {
  if (ia < 0 || ib < 0 || ia + n > a.length || ib + n > b.length || n < 2) return 0;
  const sa = stats(pa, ia, n);
  const sb = stats(pb, ib, n);
  if (sa.std === 0 || sb.std === 0) return 0;
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[ia + i] * b[ib + i];
  return (dot / n - sa.mean * sb.mean) / (sa.std * sb.std);
}

/**
 * Alinha o envelope do áudio (`audioDb`) ao do vídeo (`videoDb`), os dois com
 * passo `hopS`. Deslocamento = vídeo − áudio, buscado em
 * `[minOffsetS, maxOffsetS]` (default: de −`searchSlackS` até a diferença de
 * duração + `searchSlackS`).
 */
export function alignEnvelopes(audioDb: ArrayLike<number>, videoDb: ArrayLike<number>, hopS: number, opts: AlignOptions = {}): AlignResult {
  const o = { ...ALIGN_DEFAULTS, ...opts };
  const A = clampFloor(audioDb, o.floorDb);
  const V = clampFloor(videoDb, o.floorDb);
  const pA = prefix(A);
  const pV = prefix(V);
  const durA = A.length * hopS;
  const durV = V.length * hopS;
  const minOff = opts.minOffsetS ?? -o.searchSlackS;
  const maxOff = opts.maxOffsetS ?? Math.max(0, durV - durA) + o.searchSlackS;
  const k = Math.max(1, Math.round(o.coarseFactor));
  const Ac = decimateMean(A, k);
  const Vc = decimateMean(V, k);
  const pAc = prefix(Ac);
  const pVc = prefix(Vc);
  const win = Math.max(2, Math.round(o.windowS / hopS));
  const winC = Math.max(2, Math.floor(win / k));
  const hop = Math.max(1, Math.round(o.windowHopS / hopS));

  const windows: AlignWindow[] = [];
  const starts: number[] = [];
  for (let s = 0; s + win <= A.length; s += hop) starts.push(s);
  if (starts.length === 0 && A.length >= 2) starts.push(0);
  else if (starts.length && starts[starts.length - 1] + win < A.length) starts.push(A.length - win);
  for (const s of starts) {
    const n = Math.min(win, A.length - s);
    const audioStart = round3(s * hopS);
    const audioEnd = round3((s + n) * hopS);
    if (stats(pA, s, n).std < o.flatStdDb) {
      windows.push({ audioStart, audioEnd, offset: null, score: 0 });
      continue;
    }
    // Busca grossa.
    const sc = Math.floor(s / k);
    const nc = Math.min(winC, Ac.length - sc);
    let bestC = 0;
    let bestCOff = 0;
    for (let d = Math.ceil(minOff / (hopS * k)); d <= Math.floor(maxOff / (hopS * k)); d++) {
      const r = pearsonAt(Ac, pAc, sc, Vc, pVc, sc + d, nc);
      if (r > bestC) {
        bestC = r;
        bestCOff = d * k;
      }
    }
    // Fina, em volta do pico grosso.
    let best = -1;
    let bestOff = bestCOff;
    for (let d = bestCOff - 2 * k; d <= bestCOff + 2 * k; d++) {
      if (d * hopS < minOff - 1e-9 || d * hopS > maxOff + 1e-9) continue;
      const r = pearsonAt(A, pA, s, V, pV, s + d, n);
      if (r > best) {
        best = r;
        bestOff = d;
      }
    }
    windows.push({ audioStart, audioEnd, offset: round3(bestOff * hopS), score: Math.max(0, best) });
  }

  // Deslocamentos distintos das janelas boas, na ordem do áudio (o deslocamento só cresce).
  const offsets: number[] = [];
  for (const w of windows) {
    if (w.offset === null || w.score < o.minScore) continue;
    const last = offsets[offsets.length - 1];
    if (last !== undefined && Math.abs(w.offset - last) <= o.sameOffsetS) continue;
    if (last !== undefined && w.offset < last) continue; // fora da ordem: janela que pegou um eco
    offsets.push(w.offset);
  }
  if (offsets.length === 0) return { hopS, windows, offsets, runs: [], coverage: 0 };

  // Rotulagem monótona dos sub-trechos.
  const step = Math.max(1, Math.round(o.stepS / hopS));
  const sub = Math.max(2, Math.round(o.subWinS / hopS));
  const T = Math.max(1, Math.ceil(A.length / step));
  const K = offsets.length;
  const score = new Float64Array(T * K);
  const flat = new Uint8Array(T);
  for (let t = 0; t < T; t++) {
    const c = t * step;
    const a = Math.max(0, Math.min(A.length - sub, c - (sub >> 1)));
    const n = Math.min(sub, A.length - a);
    if (n < 2 || stats(pA, a, n).std < o.flatStdDb) {
      flat[t] = 1;
      continue;
    }
    for (let j = 0; j < K; j++) score[t * K + j] = pearsonAt(A, pA, a, V, pV, a + Math.round(offsets[j] / hopS), n);
  }
  // dp[t][j] = s(t, j) + max(dp[t−1][j], max_{i<j} dp[t−1][i] − troca); silêncio pontua 0.
  const dp = new Float64Array(T * K);
  const from = new Int32Array(T * K);
  for (let j = 0; j < K; j++) dp[j] = flat[0] ? 0 : score[j];
  for (let t = 1; t < T; t++) {
    let pm = -Infinity;
    let pmJ = 0;
    for (let j = 0; j < K; j++) {
      const stay = dp[(t - 1) * K + j];
      const sw = pm - o.switchPenalty;
      const s = flat[t] ? 0 : score[t * K + j];
      if (stay >= sw) {
        dp[t * K + j] = stay + s;
        from[t * K + j] = j;
      } else {
        dp[t * K + j] = sw + s;
        from[t * K + j] = pmJ;
      }
      if (stay > pm) {
        pm = stay;
        pmJ = j;
      }
    }
  }
  let j = 0;
  for (let q = 1; q < K; q++) if (dp[(T - 1) * K + q] > dp[(T - 1) * K + j]) j = q;
  const label = new Int32Array(T);
  for (let t = T - 1; t >= 0; t--) {
    label[t] = j;
    if (t > 0) j = from[t * K + j];
  }

  // Trechos: mesmo rótulo e com par (silêncio herda o rótulo, sem par = score baixo).
  const runs: AlignRun[] = [];
  let covered = 0;
  for (let t = 0; t < T; ) {
    const ok = (u: number) => flat[u] === 1 || score[u * K + label[u]] >= o.minSubScore;
    if (!ok(t)) {
      t++;
      continue;
    }
    let u = t;
    while (u + 1 < T && label[u + 1] === label[t] && ok(u + 1)) u++;
    const audioStart = round3(t === 0 ? 0 : (t * step - step / 2) * hopS);
    const audioEnd = round3(u === T - 1 ? durA : ((u + 1) * step - step / 2) * hopS);
    runs.push({ audioStart, audioEnd, offset: offsets[label[t]] });
    t = u + 1;
  }
  refineCuts(runs, A, V, hopS, o.subWinS, o.floorDb);
  for (const r of runs) covered += r.audioEnd - r.audioStart;
  return { hopS, windows, offsets, runs, coverage: durA > 0 ? covered / durA : 0 };
}

/**
 * Ganho entre os dois envelopes sob o deslocamento (mediana de áudio − vídeo
 * nos quadros com som do trecho): o mesmo som pode ter sido gravado/exportado
 * com nível diferente.
 */
function gainUnder(A: Float64Array, V: Float64Array, a: number, b: number, d: number, floorDb: number): number {
  const diffs: number[] = [];
  for (let n = Math.max(0, a); n < Math.min(A.length, b); n++) {
    const m = n + d;
    if (m < 0 || m >= V.length || A[n] < floorDb + 20) continue;
    diffs.push(A[n] - V[m]);
  }
  if (diffs.length === 0) return 0;
  diffs.sort((x, y) => x - y);
  return diffs[diffs.length >> 1];
}

/**
 * O corte exato entre dois trechos vizinhos de deslocamentos diferentes
 * (#11504). A rotulagem acerta o corte só até a largura do sub-trecho (~1 s),
 * e palavra do lado errado iria parar segundos fora no vídeo. Aqui, quadro a
 * quadro (passo do envelope): erro |áudio − vídeo − ganho| sob cada
 * deslocamento, e o corte é o ponto que minimiza o erro do trecho de antes
 * sob o 1º mais o de depois sob o 2º. Os dois trechos passam a se encostar no
 * corte (o vão sem par entre eles, se havia, some: é a mesma fala).
 */
function refineCuts(runs: AlignRun[], A: Float64Array, V: Float64Array, hopS: number, subWinS: number, floorDb: number): void {
  const ERR_MAX = 30;
  for (let i = 0; i + 1 < runs.length; i++) {
    const r1 = runs[i];
    const r2 = runs[i + 1];
    if (r1.offset === r2.offset) continue;
    const a = Math.max(Math.round(r1.audioStart / hopS), Math.round((r1.audioEnd - subWinS) / hopS));
    const b = Math.min(Math.round(r2.audioEnd / hopS), Math.round((r2.audioStart + subWinS) / hopS));
    if (b - a < 2) continue;
    const d1 = Math.round(r1.offset / hopS);
    const d2 = Math.round(r2.offset / hopS);
    const g1 = gainUnder(A, V, Math.round(r1.audioStart / hopS), Math.round(r1.audioEnd / hopS), d1, floorDb);
    const g2 = gainUnder(A, V, Math.round(r2.audioStart / hopS), Math.round(r2.audioEnd / hopS), d2, floorDb);
    const err = (n: number, d: number, g: number) => {
      const m = n + d;
      return m < 0 || m >= V.length ? ERR_MAX : Math.min(ERR_MAX, Math.abs(A[n] - V[m] - g));
    };
    // custo(c) = Σ_{a≤n<c} e1(n) + Σ_{c≤n<b} e2(n)
    let cost = 0;
    for (let n = a; n < b; n++) cost += err(n, d2, g2);
    let best = cost;
    let bestC = a;
    for (let c = a + 1; c <= b; c++) {
      cost += err(c - 1, d1, g1) - err(c - 1, d2, g2);
      if (cost < best) {
        best = cost;
        bestC = c;
      }
    }
    const cut = round3(bestC * hopS);
    r1.audioEnd = cut;
    r2.audioStart = cut;
  }
}

export interface RemapResult {
  /** Segmentos do áudio com as palavras que têm par, no tempo do vídeo. */
  segments: Segment[];
  words: number;
  dropped: number;
  /** Trechos do vídeo cobertos pelas palavras remapeadas. */
  covered: Interval[];
  /** Trechos do vídeo sem par, para retranscrever (≥ `minGapS`). */
  uncovered: Interval[];
}

/**
 * Leva as palavras do transcript do áudio para o tempo do vídeo. Palavra cujo
 * meio cai num trecho com par, a `marginS` das bordas internas (onde troca o
 * deslocamento ou acaba o par), vai com o deslocamento do trecho; o resto é
 * descartado e o trecho correspondente do vídeo entra em `uncovered`.
 */
export function remapToVideo(t: Transcript, runs: AlignRun[], videoDurS: number, opts: { marginS?: number; minGapS?: number; audioDurS?: number } = {}): RemapResult {
  const margin = opts.marginS ?? ALIGN_DEFAULTS.marginS;
  const minGap = opts.minGapS ?? 0.2;
  const audioEnd = opts.audioDurS ?? (runs.length ? runs[runs.length - 1].audioEnd : 0);
  // Trecho útil de cada run, sem a folga das bordas internas.
  const usable = runs.map((r, i) => ({
    a: r.audioStart <= 0 || (i > 0 && runs[i - 1].audioEnd >= r.audioStart && runs[i - 1].offset === r.offset) ? r.audioStart : r.audioStart + margin,
    b: r.audioEnd >= audioEnd - 1e-6 ? r.audioEnd : r.audioEnd - margin,
    offset: r.offset,
  })).filter((r) => r.b > r.a);
  const covered: Interval[] = usable.map((r) => ({ start: round3(Math.max(0, r.a + r.offset)), end: round3(Math.min(videoDurS, r.b + r.offset)) })).filter((iv) => iv.end > iv.start);
  let words = 0;
  let dropped = 0;
  const segments: Segment[] = [];
  for (const s of t.segments) {
    const kept: Word[] = [];
    for (const w of s.words ?? []) {
      if (!w.text.trim()) continue;
      const mid = (w.start + w.end) / 2;
      const r = usable.find((u) => mid >= u.a && mid <= u.b);
      if (!r) {
        dropped++;
        continue;
      }
      kept.push({ ...w, start: round3(w.start + r.offset), end: round3(w.end + r.offset) });
    }
    words += kept.length;
    if (kept.length === 0) continue;
    const all = kept.length === (s.words ?? []).filter((w) => w.text.trim()).length;
    segments.push({ start: kept[0].start, end: kept[kept.length - 1].end, text: all ? s.text : joinWordTexts(kept.map((w) => w.text)), words: kept });
  }
  const uncovered: Interval[] = [];
  let cur = 0;
  for (const c of [...covered].sort((x, y) => x.start - y.start)) {
    if (c.start - cur >= minGap) uncovered.push({ start: round3(cur), end: round3(c.start) });
    cur = Math.max(cur, c.end);
  }
  if (videoDurS - cur >= minGap) uncovered.push({ start: round3(cur), end: round3(videoDurS) });
  return { segments, words, dropped, covered, uncovered };
}

/**
 * Junta as retranscrições dos trechos sem par (já no tempo do vídeo) com os
 * segmentos remapeados. Da retranscrição só ficam as palavras cujo meio cai
 * em `uncovered` (a janela retranscrita pode ter folga para os lados).
 */
export function mergeRetranscribed(remapped: Segment[], patches: Transcript[], uncovered: Interval[], videoDurS: number, model?: string): Transcript {
  const inGap = (w: Word) => {
    const mid = (w.start + w.end) / 2;
    return uncovered.some((g) => mid >= g.start && mid <= g.end);
  };
  const extra: Segment[] = [];
  for (const p of patches) {
    for (const s of p.segments) {
      const ws = (s.words ?? []).filter((w) => w.text.trim() && inGap(w));
      if (ws.length === 0) continue;
      const all = ws.length === (s.words ?? []).filter((w) => w.text.trim()).length;
      extra.push({ start: ws[0].start, end: ws[ws.length - 1].end, text: all ? s.text : joinWordTexts(ws.map((w) => w.text)), words: ws });
    }
  }
  const segments = [...remapped, ...extra].sort((a, b) => a.start - b.start);
  return { duration: videoDurS, ...(model ? { model } : {}), segments };
}
