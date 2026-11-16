/**
 * scripts/lib/diaria/video-xml-vs-final.ts (#13196, #13197)
 *
 * Comparação recorrente entre o XML que o `/diaria-video-montagem` gera e o
 * vídeo que o editor exporta do Premiere para `{AAMMDD}/Final/`. Transforma o
 * método da análise única da #11670 (scripts descartáveis, fora do repo) em
 * código: o CLI `scripts/video-xml-vs-final.ts` decodifica os áudios e chama
 * o alinhamento por envelope que já existe (`alignEnvelopes`, #11504); aqui
 * fica a parte pura.
 *
 *   1. `finalSpansFromRuns`: os trechos do final com par no bruto, cada um com
 *      o tempo no bruto (o `offset` do alinhamento é bruto − final).
 *   2. `compareSequence`: cruza os clipes do `plan.json` (a verdade do XML, em
 *      segundos do bruto) com esses trechos e classifica cada diferença:
 *      clipe removido, ponta aparada ou estendida (ms, por lado), pausa
 *      interna removida, trecho acrescentado, tomada trocada (o acrescentado
 *      tem o texto de um clipe removido), ordem. As palavras do
 *      `transcript.json` do bruto dão "palavras recuperadas pelo editor" (no
 *      final, nas pontas estendidas fora de todo clipe do XML: o sinal da
 *      #13194; a fala da outra tomada e a dos trechos acrescentados fica de
 *      fora) e "palavras tiradas". `alignWithReorder` dá os trechos mesmo
 *      com a ordem trocada.
 *   3. `aggregateRecords` + `detectPatterns`: o agregado ao longo do tempo e os
 *      padrões que se repetem em N edições, cada um com a evidência e o corpo
 *      de issue pronto (marcador `video-xml-final-pattern: {id}` para não
 *      duplicar).
 *
 * Fora do escopo (o registro diz `null`, nunca um número inventado):
 * enquadramento (faceX/eyeY/escala) e legenda queimada. A #11670 conferiu os
 * dois em frames, à mão, e não achou mudança; medir exige detecção de rosto e
 * OCR no final, que ficam para quando um padrão pedir.
 */

import { alignEnvelopes, type AlignOptions, type AlignRun } from "./video-audio-align.ts";
import type { Word } from "./video-montage.ts";

export const XML_FINAL_SCHEMA = 1;

/** Vão do final sem par a partir do qual a 2ª passada procura o trecho no bruto inteiro (s). */
export const REORDER_MIN_GAP_S = 2;

/**
 * Alinhamento final × bruto que aguenta trecho reordenado (self-review da PR
 * #13205). `alignEnvelopes` é monótono (o deslocamento só cresce, pensado para
 * pausa cortada): o trecho que o editor levou para trás fica sem par, os clipes
 * dele sairiam como removidos e a ordem trocada, invisível. Aqui, como a #11670
 * fazia ("busca global quando o trecho muda"), cada vão sem par de pelo menos
 * `minGapS` é alinhado de novo sozinho contra o bruto inteiro, e os runs
 * achados entram na posição dele. Puro.
 */
export function alignWithReorder(
  finalDb: ArrayLike<number>,
  brutoDb: ArrayLike<number>,
  hopS: number,
  opts: AlignOptions = {},
  minGapS = REORDER_MIN_GAP_S,
): { runs: AlignRun[]; coverage: number; reordered: number } {
  const base = alignEnvelopes(finalDb, brutoDb, hopS, opts);
  const durF = finalDb.length * hopS;
  const gaps: Iv[] = [];
  let cur = 0;
  for (const r of base.runs) {
    if (r.audioStart - cur >= minGapS) gaps.push({ start: cur, end: r.audioStart });
    cur = Math.max(cur, r.audioEnd);
  }
  if (durF - cur >= minGapS) gaps.push({ start: cur, end: durF });
  const extra: AlignRun[] = [];
  for (const g of gaps) {
    const a = Math.round(g.start / hopS);
    const b = Math.min(finalDb.length, Math.round(g.end / hopS));
    if (b - a < 2) continue;
    const slice = Array.prototype.slice.call(finalDb, a, b) as number[];
    // Busca no bruto inteiro: o trecho pode estar antes do ponto onde a 1ª passada parou.
    const sub = alignEnvelopes(slice, brutoDb, hopS, { ...opts, minOffsetS: -(b - a) * hopS, maxOffsetS: brutoDb.length * hopS });
    const t0 = a * hopS;
    for (const r of sub.runs) {
      const s = r3(Math.max(g.start, r.audioStart + t0));
      const e = r3(Math.min(g.end, r.audioEnd + t0));
      if (e > s) extra.push({ audioStart: s, audioEnd: e, offset: r3(r.offset - t0) });
    }
  }
  const runs = [...base.runs, ...extra].sort((x, y) => x.audioStart - y.audioStart);
  const covered = runs.reduce((n, r) => n + (r.audioEnd - r.audioStart), 0);
  return { runs, coverage: durF > 0 ? covered / durF : 0, reordered: extra.length };
}

/** Abaixo disto (s) a diferença é ruído do alinhamento (a #11670 media ±0,05–0,08 s). */
export const XML_FINAL_TOLERANCE_S = 0.1;
/** Clipe com menos que esta fração no final conta como removido. */
export const REMOVED_CLIP_MAX_FRACTION = 0.2;
/** Token mínimo de semelhança (Jaccard) para um trecho acrescentado ser a outra tomada de um clipe removido. */
export const TAKE_SWAP_MIN_JACCARD = 0.5;

export interface XmlClip {
  /** Posição do clipe na sequência do XML (0 = primeiro). */
  index: number;
  /** No bruto, segundos. */
  srcIn: number;
  srcOut: number;
}

/** Um trecho do final com par no bruto: `[finalStart, finalEnd)` no final = `[brutoStart, brutoEnd)` no bruto. */
export interface FinalSpan {
  finalStart: number;
  finalEnd: number;
  brutoStart: number;
  brutoEnd: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const ms = (s: number) => Math.round(s * 1000);

/** Os runs do alinhamento (final = "áudio", bruto = "vídeo") como trechos no bruto. */
export function finalSpansFromRuns(runs: readonly AlignRun[]): FinalSpan[] {
  return runs
    .filter((r) => r.audioEnd > r.audioStart)
    .map((r) => ({ finalStart: r3(r.audioStart), finalEnd: r3(r.audioEnd), brutoStart: r3(r.audioStart + r.offset), brutoEnd: r3(r.audioEnd + r.offset) }));
}

interface Iv {
  start: number;
  end: number;
}

function union(ivs: readonly Iv[]): Iv[] {
  const s = [...ivs].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Iv[] = [];
  for (const i of s) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

function overlap(a: Iv, b: Iv): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** `a` menos a união de `cut`, pedaços em ordem. */
function subtract(a: readonly Iv[], cut: readonly Iv[]): Iv[] {
  const c = union(cut);
  const out: Iv[] = [];
  for (const iv of union(a)) {
    let cur = iv.start;
    for (const x of c) {
      if (x.end <= cur || x.start >= iv.end) continue;
      if (x.start > cur) out.push({ start: cur, end: x.start });
      cur = Math.max(cur, x.end);
    }
    if (cur < iv.end) out.push({ start: cur, end: iv.end });
  }
  return out;
}

const within = (t: number, ivs: readonly Iv[]) => ivs.some((i) => t >= i.start && t < i.end);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1),
  );
}

export function jaccard(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

function wordsIn(words: readonly Word[], iv: Iv): Word[] {
  return words.filter((w) => {
    const mid = (w.start + w.end) / 2;
    return mid >= iv.start && mid < iv.end;
  });
}

const textOf = (ws: readonly Word[]) => ws.map((w) => w.text.trim()).filter(Boolean).join(" ");

export interface ClipComparison {
  index: number;
  srcIn: number;
  srcOut: number;
  status: "kept" | "removed";
  /** Positivo = o editor estendeu a ponta (usou mais bruto), negativo = aparou. `null` no removido. */
  headMs: number | null;
  tailMs: number | null;
  /** Pausas do bruto dentro do clipe que o final pulou. */
  internalPauses: Array<{ start: number; end: number; ms: number }>;
  /** A ponta encostou no clipe vizinho do XML: o editor juntou os dois. */
  joinedHead?: true;
  joinedTail?: true;
  /** Início do clipe no final (s), para a ordem. */
  finalStart: number | null;
  touched: boolean;
}

export interface AddedSpan {
  brutoStart: number;
  brutoEnd: number;
  text: string;
  /** Mesma fala de um clipe removido do XML: a outra tomada. */
  swapOf?: number;
}

export interface SequenceComparison {
  clips: ClipComparison[];
  added: AddedSpan[];
  takeSwaps: Array<{ clip: number; xml: { start: number; end: number }; final: { start: number; end: number }; similarity: number }>;
  /** Pares de clipes mantidos em ordem trocada no final. */
  orderInversions: number;
  wordsRecovered: Array<{ text: string; start: number; end: number }>;
  wordsRemoved: number;
  /** Segundos do final sem par no bruto (vinheta, cards, capa, ou trecho fora do alinhamento). */
  finalUnpairedS: number;
  summary: SequenceSummary;
}

export interface SequenceSummary {
  clips: number;
  clipsRemoved: number;
  clipsTouched: number;
  /** Médias sobre os clipes mantidos (ms), sem as pontas emendadas ao vizinho; `null` sem nenhuma. */
  headMeanMs: number | null;
  tailMeanMs: number | null;
  headExtended: number;
  headTrimmed: number;
  tailExtended: number;
  tailTrimmed: number;
  /** Emendas: clipes que o editor juntou ao seguinte do XML (a ponta deles fica fora das médias). */
  joins: number;
  internalPausesRemoved: number;
  internalPausesMs: number;
  added: number;
  takeSwaps: number;
  orderInversions: number;
  wordsRecovered: number;
  wordsRemoved: number;
}

/**
 * Compara os clipes do XML com os trechos do final no tempo do bruto. Puro.
 * `durationFinalS` só entra no `finalUnpairedS`.
 */
export function compareSequence(input: {
  clips: readonly XmlClip[];
  spans: readonly FinalSpan[];
  words?: readonly Word[];
  finalDurationS: number;
  toleranceS?: number;
}): SequenceComparison {
  const tol = input.toleranceS ?? XML_FINAL_TOLERANCE_S;
  const words = input.words ?? [];
  const clips = [...input.clips].sort((a, b) => a.index - b.index);
  const xmlIvs = clips.map((c) => ({ start: c.srcIn, end: c.srcOut }));
  const used = union(input.spans.map((s) => ({ start: s.brutoStart, end: s.brutoEnd })));
  const byBruto = [...clips].sort((a, b) => a.srcIn - b.srcIn);

  const out: ClipComparison[] = [];
  for (const c of clips) {
    const iv = { start: c.srcIn, end: c.srcOut };
    const len = iv.end - iv.start;
    const touching = input.spans.filter((s) => overlap({ start: s.brutoStart, end: s.brutoEnd }, iv) > 0);
    const covered = used.reduce((n, u) => n + overlap(u, iv), 0);
    if (len <= 0 || touching.length === 0 || covered < Math.max(REMOVED_CLIP_MAX_FRACTION * len, tol)) {
      out.push({ index: c.index, srcIn: c.srcIn, srcOut: c.srcOut, status: "removed", headMs: null, tailMs: null, internalPauses: [], finalStart: null, touched: true });
      continue;
    }
    const pos = byBruto.indexOf(c);
    const prevBound = pos > 0 ? byBruto[pos - 1].srcOut : -Infinity;
    const nextBound = pos < byBruto.length - 1 ? byBruto[pos + 1].srcIn : Infinity;
    const usedHere = used.filter((u) => overlap(u, iv) > 0);
    const lo = usedHere[0].start;
    const hi = usedHere[usedHere.length - 1].end;
    const headStart = Math.max(lo, prevBound);
    const tailEnd = Math.min(hi, nextBound);
    const headS = c.srcIn - headStart;
    const tailS = tailEnd - c.srcOut;
    const internalPauses = subtract([iv], used)
      .filter((g) => g.start > iv.start + 1e-9 && g.end < iv.end - 1e-9 && g.end - g.start > tol)
      .map((g) => ({ start: r3(g.start), end: r3(g.end), ms: ms(g.end - g.start) }));
    const headMs = Math.abs(headS) > tol ? ms(headS) : 0;
    const tailMs = Math.abs(tailS) > tol ? ms(tailS) : 0;
    const finalStart = Math.min(...touching.map((s) => s.finalStart + Math.max(0, c.srcIn - s.brutoStart)));
    out.push({
      index: c.index,
      srcIn: c.srcIn,
      srcOut: c.srcOut,
      status: "kept",
      headMs,
      tailMs,
      internalPauses,
      ...(lo < prevBound - 1e-9 && pos > 0 ? { joinedHead: true as const } : {}),
      ...(hi > nextBound + 1e-9 && pos < byBruto.length - 1 ? { joinedTail: true as const } : {}),
      finalStart: r3(finalStart),
      touched: headMs !== 0 || tailMs !== 0 || internalPauses.length > 0,
    });
  }

  // O que o final usa fora de todo clipe e longe das pontas: trecho acrescentado.
  const xmlGrown = union(xmlIvs.map((i) => ({ start: i.start - tol, end: i.end + tol })));
  const extras = subtract(used, xmlIvs).filter((p) => p.end - p.start > tol);
  const added: AddedSpan[] = [];
  const takeSwaps: SequenceComparison["takeSwaps"] = [];
  const removed = out.filter((c) => c.status === "removed");
  for (const p of extras) {
    const adjacent = xmlGrown.some((g) => (p.start >= g.start && p.start <= g.end) || (p.end >= g.start && p.end <= g.end));
    if (adjacent) continue; // ponta estendida: já está no headMs/tailMs
    const text = textOf(wordsIn(words, p));
    let best: { clip: ClipComparison; sim: number } | null = null;
    for (const rc of removed) {
      const sim = jaccard(text, textOf(wordsIn(words, { start: rc.srcIn, end: rc.srcOut })));
      if (sim >= TAKE_SWAP_MIN_JACCARD && (!best || sim > best.sim)) best = { clip: rc, sim };
    }
    added.push({ brutoStart: r3(p.start), brutoEnd: r3(p.end), text, ...(best ? { swapOf: best.clip.index } : {}) });
    if (best) takeSwaps.push({ clip: best.clip.index, xml: { start: best.clip.srcIn, end: best.clip.srcOut }, final: { start: r3(p.start), end: r3(p.end) }, similarity: Math.round(best.sim * 100) / 100 });
  }

  const kept = out.filter((c) => c.status === "kept" && c.finalStart !== null);
  let orderInversions = 0;
  for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) if ((kept[i].finalStart as number) > (kept[j].finalStart as number)) orderInversions++;

  // Só a palavra das pontas estendidas conta como recuperada (o sinal da #13194): a fala da outra tomada e a dos
  // trechos acrescentados já sai em `takeSwaps`/`added` e não é palavra comida pelo corte (self-review da PR #13205).
  const addedIvs = added.map((a) => ({ start: a.brutoStart, end: a.brutoEnd }));
  const wordsRecovered = words
    .filter((w) => {
      const mid = (w.start + w.end) / 2;
      return within(mid, used) && !within(mid, xmlIvs) && !within(mid, addedIvs) && w.text.trim() !== "";
    })
    .map((w) => ({ text: w.text.trim(), start: r3(w.start), end: r3(w.end) }));
  const wordsRemoved = words.filter((w) => {
    const mid = (w.start + w.end) / 2;
    return within(mid, xmlIvs) && !within(mid, used) && w.text.trim() !== "";
  }).length;

  const pairedS = input.spans.reduce((n, s) => n + Math.max(0, s.finalEnd - s.finalStart), 0);
  const keptClips = out.filter((c) => c.status === "kept");
  // Ponta emendada ao clipe vizinho mede o vão inteiro até ele, não padding: fica fora da média e das contagens de
  // ponta, e entra à parte em `joins` (self-review da PR #13205).
  const heads = keptClips.filter((c) => !c.joinedHead).map((c) => c.headMs as number);
  const tails = keptClips.filter((c) => !c.joinedTail).map((c) => c.tailMs as number);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const summary: SequenceSummary = {
    clips: out.length,
    clipsRemoved: out.length - keptClips.length,
    clipsTouched: out.filter((c) => c.touched).length,
    headMeanMs: mean(heads),
    tailMeanMs: mean(tails),
    headExtended: heads.filter((x) => x > 0).length,
    headTrimmed: heads.filter((x) => x < 0).length,
    tailExtended: tails.filter((x) => x > 0).length,
    tailTrimmed: tails.filter((x) => x < 0).length,
    joins: keptClips.filter((c) => c.joinedTail).length,
    internalPausesRemoved: keptClips.reduce((n, c) => n + c.internalPauses.length, 0),
    internalPausesMs: keptClips.reduce((n, c) => n + c.internalPauses.reduce((m, p) => m + p.ms, 0), 0),
    added: added.filter((a) => a.swapOf === undefined).length,
    takeSwaps: takeSwaps.length,
    orderInversions,
    wordsRecovered: wordsRecovered.length,
    wordsRemoved,
  };
  return { clips: out, added, takeSwaps, orderInversions, wordsRecovered, wordsRemoved, finalUnpairedS: r3(Math.max(0, input.finalDurationS - pairedS)), summary };
}

// ── Registro por edição ──────────────────────────────────────────────────

export type RecordMethod = "audio-envelope-align-v1" | "11670-manual";

export interface LoudnessSnapshot {
  inputI: number;
  /** `null` quando a fonte não mediu (registro importado da #11670). */
  inputTp: number | null;
}

/** Uma sequência comparada. Campos `null` = não medido (nunca zero inventado). */
export interface SequenceRecord {
  key: string;
  /** Método desta sequência; ausente = o do registro (`EditionRecord.method`). */
  method?: RecordMethod;
  target: string | null;
  finalFile: string | null;
  /** `<sequence id>` versionado do XML (`xmlVersions`, `_V{n}`), quando o plan.json o tem. */
  xmlVersion: string | null;
  xmlDurationS: number | null;
  finalDurationS: number | null;
  /** Fração do final com par no bruto. */
  coverage: number | null;
  summary: Partial<SequenceSummary>;
  loudness: LoudnessSnapshot | null;
  /** Fora do escopo do v1 (ver docstring do módulo). */
  framing: null;
  captions: null;
  /** Detalhe (clipes, acrescentados, palavras); ausente no registro importado da #11670. */
  detail?: Omit<SequenceComparison, "summary">;
  notes?: string[];
}

export interface EditionRecord {
  schema: typeof XML_FINAL_SCHEMA;
  edition: string;
  method: RecordMethod;
  generatedAt: string;
  sequences: SequenceRecord[];
  /** Sequências do plano sem par (sem final, sem bruto local, alinhamento ruim). */
  skipped: Array<{ key: string; reason: string }>;
  source?: string;
}

/**
 * Junta um registro novo ao anterior da mesma edição: sequência medida de
 * novo substitui a antiga, as outras ficam. Registro importado da #11670 nunca
 * substitui uma medição automática. Puro.
 */
export function mergeEditionRecord(prev: EditionRecord | null, next: EditionRecord): EditionRecord {
  const stamp = (r: EditionRecord) => r.sequences.map((s) => ({ ...s, method: s.method ?? r.method }));
  if (!prev) return { ...next, sequences: stamp(next) };
  const prevSeqs = stamp(prev);
  // Sequência medida automaticamente nunca é substituída pelo importado da #11670.
  const nextSeqs = stamp(next).filter((s) => !(s.method === "11670-manual" && prevSeqs.some((p) => p.key === s.key && p.method !== "11670-manual")));
  const keys = new Set(nextSeqs.map((s) => s.key));
  const sequences = [...prevSeqs.filter((s) => !keys.has(s.key)), ...nextSeqs].sort((a, b) => a.key.localeCompare(b.key));
  const measured = new Set(sequences.map((s) => s.key));
  const skipped = [...prev.skipped.filter((s) => !keys.has(s.key) && !next.skipped.some((n) => n.key === s.key)), ...next.skipped].filter((s) => !measured.has(s.key));
  // Sem nenhuma sequência medida, o método é o do registro novo: a rodada automática que só pulou não vira "#11670".
  const method = sequences.length === 0 ? next.method : sequences.some((s) => s.method !== "11670-manual") ? "audio-envelope-align-v1" : "11670-manual";
  return { ...next, method, generatedAt: next.method === method ? next.generatedAt : prev.generatedAt, sequences, skipped };
}

// ── Agregado e padrões ───────────────────────────────────────────────────

export interface AggregateRow {
  edition: string;
  key: string;
  method: RecordMethod;
  xmlDurationS: number | null;
  finalDurationS: number | null;
  clips: number | null;
  clipsRemoved: number | null;
  touchedPct: number | null;
  headMeanMs: number | null;
  tailMeanMs: number | null;
  internalPausesRemoved: number | null;
  takeSwaps: number | null;
  orderInversions: number | null;
  wordsRecovered: number | null;
  loudnessI: number | null;
}

export interface Aggregate {
  rows: AggregateRow[];
  editions: number;
  /** Médias ao longo do tempo (sobre as linhas que mediram o campo). */
  totals: {
    headMeanMs: number | null;
    tailMeanMs: number | null;
    touchedPct: number | null;
    wordsRecovered: number;
    wordsRecoveredPerSequence: number | null;
    internalPausesPerSequence: number | null;
  };
}

const num = (x: number | null | undefined): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

export function aggregateRecords(records: readonly EditionRecord[]): Aggregate {
  const rows: AggregateRow[] = [];
  for (const r of [...records].sort((a, b) => a.edition.localeCompare(b.edition))) {
    for (const s of r.sequences) {
      const clips = num(s.summary.clips);
      const touched = num(s.summary.clipsTouched);
      rows.push({
        edition: r.edition,
        key: s.key,
        method: s.method ?? r.method,
        xmlDurationS: num(s.xmlDurationS),
        finalDurationS: num(s.finalDurationS),
        clips,
        clipsRemoved: num(s.summary.clipsRemoved),
        touchedPct: clips && touched !== null ? Math.round((touched / clips) * 100) : null,
        headMeanMs: num(s.summary.headMeanMs),
        tailMeanMs: num(s.summary.tailMeanMs),
        internalPausesRemoved: num(s.summary.internalPausesRemoved),
        takeSwaps: num(s.summary.takeSwaps),
        orderInversions: num(s.summary.orderInversions),
        wordsRecovered: num(s.summary.wordsRecovered),
        loudnessI: num(s.loudness?.inputI),
      });
    }
  }
  const avg = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const recovered = rows.map((r) => r.wordsRecovered).filter((x): x is number => x !== null);
  const pauses = rows.map((r) => r.internalPausesRemoved).filter((x): x is number => x !== null);
  return {
    rows,
    editions: new Set(rows.map((r) => r.edition)).size,
    totals: {
      headMeanMs: avg(rows.map((r) => r.headMeanMs)),
      tailMeanMs: avg(rows.map((r) => r.tailMeanMs)),
      touchedPct: avg(rows.map((r) => r.touchedPct)),
      wordsRecovered: recovered.reduce((a, b) => a + b, 0),
      wordsRecoveredPerSequence: recovered.length ? Math.round((recovered.reduce((a, b) => a + b, 0) / recovered.length) * 10) / 10 : null,
      internalPausesPerSequence: pauses.length ? Math.round((pauses.reduce((a, b) => a + b, 0) / pauses.length) * 10) / 10 : null,
    },
  };
}

export interface PatternRule {
  id: string;
  title: string;
  priority: "P1" | "P2" | "P3";
  /** Edições distintas em que a regra precisa bater. */
  minEditions: number;
  /** A linha conta para o padrão; `null` = a linha não mediu o campo. */
  hit(row: AggregateRow): boolean | null;
  /** Valor mostrado na evidência. */
  value(row: AggregateRow): string;
  /** O que mudar no gerador (vai no corpo da issue). */
  suggestion: string;
  /**
   * Issue que já acompanha o padrão: enquanto aberta, a evidência vai como
   * comentário nela em vez de abrir outra (não duplicar a #13194, a #12089).
   */
  trackingIssue?: number;
}

const fmt = (x: number | null, unit = "") => (x === null ? "n/d" : `${x > 0 ? "+" : ""}${x}${unit}`);

/**
 * Padrões vigiados. Limiares conservadores de propósito: a issue sai só com o
 * mesmo sinal em várias edições (a #11670 abria issue com 2+). Ajuste de
 * limiar é decisão a registrar aqui, com a medição que a motivou.
 */
export const PATTERN_RULES: readonly PatternRule[] = [
  {
    id: "palavras-recuperadas",
    title: "video-montagem: o editor recupera palavras que o XML cortou",
    priority: "P1",
    minEditions: 2,
    hit: (r) => (r.wordsRecovered === null ? null : r.wordsRecovered >= 1),
    value: (r) => `${r.wordsRecovered} palavra(s)`,
    suggestion: "Rever a folga e o refino das pontas dos clipes (#13194): a palavra que o editor recoloca estava fora do corte do XML.",
    trackingIssue: 13194,
  },
  {
    id: "ponta-saida-estendida",
    title: "video-montagem: o editor estende a ponta da saída dos clipes",
    priority: "P3",
    minEditions: 3,
    hit: (r) => (r.tailMeanMs === null ? null : r.tailMeanMs >= 80),
    value: (r) => fmt(r.tailMeanMs, " ms"),
    suggestion: "Aumentar o padding da saída do clipe no build pela média medida (parâmetro com critério mecânico).",
  },
  {
    id: "ponta-entrada-estendida",
    title: "video-montagem: o editor estende a ponta da entrada dos clipes",
    priority: "P3",
    minEditions: 3,
    hit: (r) => (r.headMeanMs === null ? null : r.headMeanMs >= 80),
    value: (r) => fmt(r.headMeanMs, " ms"),
    suggestion: "Aumentar o padding da entrada do clipe no build pela média medida.",
  },
  {
    id: "cabeca-aparada",
    title: "video-montagem: o editor apara a cabeça dos clipes",
    priority: "P3",
    minEditions: 3,
    hit: (r) => (r.headMeanMs === null ? null : r.headMeanMs <= -150),
    value: (r) => fmt(r.headMeanMs, " ms"),
    suggestion: "Reduzir a folga da entrada (respiração/hesitação antes da fala), como na #12089.",
    trackingIssue: 12089,
  },
  {
    id: "pausa-interna-removida",
    title: "video-montagem: o editor remove pausas dentro dos clipes",
    priority: "P3",
    minEditions: 3,
    hit: (r) => (r.internalPausesRemoved === null ? null : r.internalPausesRemoved >= 3),
    value: (r) => `${r.internalPausesRemoved} pausa(s)`,
    suggestion: "Rever o limiar de pausa interna do corte por fala (#11753/#12089).",
    trackingIssue: 12089,
  },
  {
    id: "clipes-removidos",
    title: "video-montagem: o editor tira frases inteiras do XML",
    priority: "P3",
    minEditions: 2,
    hit: (r) => (r.clips === null || r.clipsRemoved === null || r.clips === 0 ? null : r.clipsRemoved / r.clips >= 0.2),
    value: (r) => `${r.clipsRemoved}/${r.clips} clipes`,
    suggestion: "Duração-alvo por sequência ou critério de corte de frase (#11757). Mudança de comportamento: issue, não PR automático.",
  },
  {
    id: "tomada-trocada",
    title: "video-montagem: o editor troca a tomada escolhida pelo XML",
    priority: "P3",
    minEditions: 2,
    hit: (r) => (r.takeSwaps === null ? null : r.takeSwaps >= 1),
    value: (r) => `${r.takeSwaps} troca(s)`,
    suggestion: "Rever o critério de tomada (#11754). Mudança de comportamento: issue, não PR automático.",
  },
];

export interface DetectedPattern {
  id: string;
  title: string;
  priority: PatternRule["priority"];
  editions: string[];
  evidence: Array<{ edition: string; key: string; value: string }>;
  suggestion: string;
  trackingIssue?: number;
  /** Hash estável da evidência: comentar de novo só quando ela muda. */
  evidenceHash: string;
}

/** FNV-1a 32 bits, hex: hash curto e determinístico, sem depender de crypto. */
export function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * `requireAuto` (default `true`): o padrão só sai com pelo menos uma edição
 * medida pela tarefa. Os números importados da #11670 reforçam a evidência,
 * mas sozinhos não reabrem o que a própria #11670 já triou (ela abriu as
 * issues dos padrões dela e registrou o resto sem issue).
 */
export function detectPatterns(agg: Aggregate, rules: readonly PatternRule[] = PATTERN_RULES, opts: { requireAuto?: boolean } = {}): DetectedPattern[] {
  const requireAuto = opts.requireAuto ?? true;
  const out: DetectedPattern[] = [];
  for (const rule of rules) {
    const hits = agg.rows.filter((r) => rule.hit(r) === true);
    const editions = [...new Set(hits.map((r) => r.edition))].sort();
    if (editions.length < rule.minEditions) continue;
    if (requireAuto && !hits.some((r) => r.method !== "11670-manual")) continue;
    const evidence = hits.map((r) => ({ edition: r.edition, key: r.key, value: rule.value(r) }));
    out.push({
      id: rule.id,
      title: rule.title,
      priority: rule.priority,
      editions,
      evidence,
      suggestion: rule.suggestion,
      ...(rule.trackingIssue ? { trackingIssue: rule.trackingIssue } : {}),
      evidenceHash: stableHash(JSON.stringify(evidence)),
    });
  }
  return out;
}

export const PATTERN_MARKER = (id: string) => `<!-- video-xml-final-pattern: ${id} -->`;

export function patternIssueBody(p: DetectedPattern, extra: { details?: Map<string, string[]> } = {}): string {
  const lines = [
    PATTERN_MARKER(p.id),
    "## Padrão",
    "",
    `Achado da comparação recorrente XML gerado × vídeo publicado (#13196): aparece em ${p.editions.length} edição(ões) (${p.editions.join(", ")}).`,
    "",
    "| Edição | Sequência | Medida |",
    "|---|---|---|",
    ...p.evidence.map((e) => `| ${e.edition} | ${e.key} | ${e.value} |`),
    "",
  ];
  const details = extra.details?.get(p.id);
  if (details?.length) lines.push("## Exemplos (tempo no bruto)", "", ...details.map((d) => `- ${d}`), "");
  lines.push(
    "## O que mudar",
    "",
    p.suggestion,
    "",
    `Prioridade ${p.priority}: sugerida pela regra \`${p.id}\` de \`scripts/lib/diaria/video-xml-vs-final.ts\` (PATTERN_RULES).`,
    "",
    "Registros por edição em `data/video-xml-vs-final/`; agregado em `data/video-xml-vs-final/aggregate.json`.",
  );
  return lines.join("\n");
}

export function patternCommentBody(p: DetectedPattern): string {
  return [
    `<!-- video-xml-final-evidence: ${p.evidenceHash} -->`,
    `Evidência atualizada pela comparação recorrente (#13196): ${p.editions.length} edição(ões).`,
    "",
    "| Edição | Sequência | Medida |",
    "|---|---|---|",
    ...p.evidence.map((e) => `| ${e.edition} | ${e.key} | ${e.value} |`),
  ].join("\n");
}

/** Exemplos com tempo no bruto, por padrão, tirados do detalhe dos registros. */
export function patternExamples(records: readonly EditionRecord[], max = 8): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const push = (id: string, line: string) => {
    const xs = out.get(id) ?? [];
    if (xs.length < max) xs.push(line);
    out.set(id, xs);
  };
  for (const r of records) {
    for (const s of r.sequences) {
      const d = s.detail;
      if (!d) continue;
      for (const w of d.wordsRecovered) push("palavras-recuperadas", `${r.edition} ${s.key}: "${w.text}" em ${w.start.toFixed(2)}–${w.end.toFixed(2)} s`);
      for (const t of d.takeSwaps) push("tomada-trocada", `${r.edition} ${s.key}: clipe ${t.clip} (${t.xml.start}–${t.xml.end} s) trocado por ${t.final.start}–${t.final.end} s`);
      for (const c of d.clips) {
        if (c.status === "removed") push("clipes-removidos", `${r.edition} ${s.key}: clipe ${c.index} (${c.srcIn}–${c.srcOut} s) fora do final`);
        else {
          if ((c.tailMs ?? 0) > 0) push("ponta-saida-estendida", `${r.edition} ${s.key}: clipe ${c.index} saída ${c.srcOut} s, +${c.tailMs} ms`);
          if ((c.headMs ?? 0) > 0) push("ponta-entrada-estendida", `${r.edition} ${s.key}: clipe ${c.index} entrada ${c.srcIn} s, +${c.headMs} ms`);
          if ((c.headMs ?? 0) < 0) push("cabeca-aparada", `${r.edition} ${s.key}: clipe ${c.index} entrada ${c.srcIn} s, ${c.headMs} ms`);
          for (const p of c.internalPauses) push("pausa-interna-removida", `${r.edition} ${s.key}: clipe ${c.index}, pausa ${p.start}–${p.end} s (${p.ms} ms)`);
        }
      }
    }
  }
  return out;
}

// ── Relatório ────────────────────────────────────────────────────────────

const cell = (x: number | null, suffix = "") => (x === null ? "n/d" : `${x}${suffix}`);

export function renderReport(input: { agg: Aggregate; patterns: readonly DetectedPattern[]; skipped: ReadonlyArray<{ edition: string; key: string; reason: string }>; generatedAt: string }): string {
  const { agg } = input;
  const lines = [
    `# Vídeo: XML gerado × final publicado`,
    "",
    `Gerado em ${input.generatedAt}. ${agg.editions} edição(ões), ${agg.rows.length} sequência(s) comparada(s) (#13196, #13197).`,
    "",
    "## Ao longo do tempo",
    "",
    `- Ponta da entrada, média: ${cell(agg.totals.headMeanMs, " ms")}; da saída: ${cell(agg.totals.tailMeanMs, " ms")} (positivo = o editor estendeu).`,
    `- Clipes mexidos: ${cell(agg.totals.touchedPct, "%")} em média.`,
    `- Palavras recuperadas pelo editor: ${agg.totals.wordsRecovered} no total, ${cell(agg.totals.wordsRecoveredPerSequence)} por sequência (deve cair com #13194).`,
    `- Pausas internas removidas: ${cell(agg.totals.internalPausesPerSequence)} por sequência.`,
    "",
    "## Por edição",
    "",
    "| Edição | Sequência | Método | XML | Final | Clipes fora | Mexidos | Entrada | Saída | Pausas | Tomadas | Palavras recuperadas | LUFS |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...agg.rows.map(
      (r) =>
        `| ${r.edition} | ${r.key} | ${r.method === "11670-manual" ? "#11670" : "auto"} | ${cell(r.xmlDurationS, " s")} | ${cell(r.finalDurationS, " s")} | ${r.clips === null ? "n/d" : `${cell(r.clipsRemoved)}/${r.clips}`} | ${cell(r.touchedPct, "%")} | ${cell(r.headMeanMs, " ms")} | ${cell(r.tailMeanMs, " ms")} | ${cell(r.internalPausesRemoved)} | ${cell(r.takeSwaps)} | ${cell(r.wordsRecovered)} | ${cell(r.loudnessI)} |`,
    ),
    "",
    "## Padrões",
    "",
    ...(input.patterns.length ? input.patterns.map((p) => `- **${p.id}** (${p.priority}): ${p.editions.length} edições (${p.editions.join(", ")})`) : ["Nenhum padrão acima dos limiares."]),
    "",
  ];
  if (input.skipped.length) {
    lines.push("## Sem par (puladas)", "", "| Edição | Sequência | Motivo |", "|---|---|---|", ...input.skipped.map((s) => `| ${s.edition} | ${s.key} | ${s.reason} |`), "");
  }
  lines.push("Enquadramento e legenda: fora da medição automática (v1); a #11670 conferiu à mão e não achou mudança.");
  return lines.join("\n") + "\n";
}

// ── Escolha dos finais e das edições ─────────────────────────────────────

export interface FinalCandidate {
  name: string;
  modifiedTime?: string | null;
}

/**
 * Um final por sequência: `.mp4` cujo nome resolve para uma sequência do
 * plano (`resolveKey`, o `reviewFinalSequence` do video-montagem), a maior
 * versão `_V{n}` e, no empate, o mais recente. Puro.
 */
export function pickFinalsPerSequence<F extends FinalCandidate>(
  files: readonly F[],
  resolveKey: (name: string) => string | null,
  versionOf: (name: string) => number | null,
): Map<string, F> {
  const out = new Map<string, F>();
  for (const f of files) {
    if (!/\.mp4$/i.test(f.name)) continue;
    const key = resolveKey(f.name);
    if (!key) continue;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, f);
      continue;
    }
    const vp = versionOf(prev.name) ?? 0;
    const vf = versionOf(f.name) ?? 0;
    if (vf > vp || (vf === vp && (f.modifiedTime ?? "") > (prev.modifiedTime ?? ""))) out.set(key, f);
  }
  return out;
}

/** Estado da tarefa recorrente (`data/video-xml-vs-final/state.json`). */
export interface RecurringState {
  lastRunAt: string | null;
  /** Edições com pelo menos uma sequência comparada, e quando. */
  done: Record<string, { at: string; sequences: string[] }>;
  /** Padrão → issue aberta e o hash da última evidência comentada. */
  patterns: Record<string, { issue: number; evidenceHash: string }>;
}

export const EMPTY_STATE: RecurringState = { lastRunAt: null, done: {}, patterns: {} };

/**
 * Motivo de `skipped` quando a consulta ao Drive falhou (credencial, rede,
 * pasta duplicada): distinto de "sem final exportado", que é ausência real
 * (self-review da PR #13205).
 */
export const DRIVE_UNAVAILABLE_REASON = "drive-indisponivel";

export const driveUnavailableReason = (message: string) => `${DRIVE_UNAVAILABLE_REASON}: ${message.slice(0, 200)}`;

/** A edição não pôde ser consultada no Drive (todas as sequências puladas por isso). */
export function isDriveUnavailable(rec: EditionRecord): boolean {
  return rec.sequences.length === 0 && rec.skipped.length > 0 && rec.skipped.every((s) => s.reason.startsWith(`${DRIVE_UNAVAILABLE_REASON}:`));
}

/**
 * Alarme da rodada: nenhuma das edições consultadas chegou ao Drive. O CLI sai
 * `1` nesse caso, para a falha de acesso não passar por "nada a comparar" e a
 * edição sair da janela de 14 dias em silêncio. Puro.
 */
export function driveUnreachable(records: readonly EditionRecord[]): boolean {
  return records.length > 0 && records.every(isDriveUnavailable);
}

/** AAMMDD → Date UTC do dia (meio-dia, sem borda de fuso). */
export function editionDate(e: string): Date {
  return new Date(Date.UTC(2000 + Number(e.slice(0, 2)), Number(e.slice(2, 4)) - 1, Number(e.slice(4, 6)), 12));
}

/**
 * As edições a comparar nesta rodada: com plan.json, dentro da janela
 * (`days` para trás a partir de `today`), e ainda sem todas as sequências do
 * plano comparadas. Sem par hoje, volta na próxima rodada até sair da janela
 * (o editor exporta o final às vezes dias depois). Puro.
 */
export function editionsToCompare(input: {
  withPlan: ReadonlyArray<{ edition: string; sequences: string[] }>;
  state: RecurringState;
  today: string;
  days: number;
}): string[] {
  const limit = editionDate(input.today).getTime() - input.days * 86_400_000;
  return input.withPlan
    .filter((e) => editionDate(e.edition).getTime() >= limit && editionDate(e.edition).getTime() <= editionDate(input.today).getTime())
    .filter((e) => {
      const done = new Set(input.state.done[e.edition]?.sequences ?? []);
      return e.sequences.some((k) => !done.has(k));
    })
    .map((e) => e.edition)
    .sort();
}

// ── Bruto: onde achar cada arquivo e como montar a linha do tempo ───────────
//
// A 1ª rodada real (backfill de 16/11/2026) pulou todas as edições de 261104
// em diante: sem o `audio.wav` no cache da montagem, só o caminho gravado no
// `plan.json` era tentado (G:/I:, do Windows) e o bruto em vários arquivos não
// tinha fallback (#13225). O bruto, porém, está no HD do 300 depois do
// arquivamento semanal (#12548), no cache da montagem ou no Drive.

export interface BrutoPart {
  /** Nome do arquivo (sem a pasta), como o Drive e o arquivo do HD o guardam. */
  name: string;
  /** Caminho gravado no `plan.json` (pode ser de outra máquina). */
  originalPath: string;
  /** Duração na linha do tempo (frames/fps); `null` no bruto de um arquivo só. */
  durationS: number | null;
}

/** Fonte do `plan.json` no que interessa aqui (`SourceInfo` da montagem). */
export interface BrutoSourceLite {
  fps?: number;
  path?: string;
  files?: ReadonlyArray<{ id?: string; path?: string; frames?: number; offsetFrames?: number }>;
}

/** Nome do arquivo de um caminho de qualquer máquina (`/` ou `\`). */
export function brutoFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Pura — os arquivos do bruto na ordem da linha do tempo da montagem. Bruto em
 * vários arquivos (#12559) precisa de `fps` e `frames` de cada um: é a duração
 * que cada parte ocupa na linha do tempo global dos `srcIn`/`srcOut`. Sem
 * isso, o motivo do pulo (nunca uma concatenação com tempos errados).
 */
export function brutoParts(source: BrutoSourceLite): { parts: BrutoPart[] } | { parts: null; reason: string } {
  const files = source.files ?? [];
  if (files.length > 1) {
    const fps = source.fps;
    if (!fps || !(fps > 0)) return { parts: null, reason: "bruto em vários arquivos sem fps no plan.json" };
    const sorted = [...files].sort((a, b) => (a.offsetFrames ?? 0) - (b.offsetFrames ?? 0));
    const parts: BrutoPart[] = [];
    for (const f of sorted) {
      // Sem `path`, o nome sai do `id` do `source.json` (`{id}.mp4`, o nome no Drive, #12089).
      const name = f.path ? brutoFileName(f.path) : f.id ? `${f.id}.mp4` : "";
      if (!name || !(f.frames && f.frames > 0)) return { parts: null, reason: "bruto em vários arquivos sem caminho ou frames de algum arquivo no plan.json" };
      parts.push({ name, originalPath: f.path ?? "", durationS: f.frames / fps });
    }
    return { parts };
  }
  const path = files[0]?.path ?? source.path;
  if (!path) return { parts: null, reason: "plan.json sem o caminho do bruto" };
  return { parts: [{ name: brutoFileName(path), originalPath: path, durationS: null }] };
}

/**
 * Pura — as pastas locais onde procurar um arquivo do bruto, em ordem: as do
 * arquivo do HD do 300 cujo nome cobre a edição (`261105`, `261109-10`, mesmo
 * critério do `archive-video-brutos.ts`, #12548) e a do cache da montagem
 * (`{cache}/{AAMMDD}/bruto`, onde o modo API dela baixa). O caminho original
 * do `plan.json` é tentado antes, por quem chama.
 */
export function brutoSearchDirs(input: {
  edition: string;
  archiveRoot: string | null;
  archiveFolders: readonly string[];
  montageEditionCache: string | null;
  join: (...p: string[]) => string;
  editionsOfFolder: (name: string) => string[] | null;
}): string[] {
  const dirs: string[] = [];
  if (input.archiveRoot) {
    for (const f of [...input.archiveFolders].sort()) {
      if (input.editionsOfFolder(f)?.includes(input.edition)) dirs.push(input.join(input.archiveRoot, f));
    }
  }
  if (input.montageEditionCache) dirs.push(input.join(input.montageEditionCache, "bruto"));
  return dirs;
}

/**
 * Pura — a duração do áudio montado bate com a linha do tempo? Tolerância de
 * 1 quadro mais 1 amostra (mesmo critério do `audioDurationMatches` da
 * montagem, #12559): um áudio mais curto adiantaria todas as falas seguintes.
 */
export function brutoTimelineMatches(actualS: number, parts: readonly BrutoPart[], fps: number | undefined, sampleRate = 16000): boolean {
  if (parts.some((p) => p.durationS === null)) return true;
  const expect = parts.reduce((s, p) => s + (p.durationS ?? 0), 0);
  const tol = (fps && fps > 0 ? 1 / fps : 0) + 1 / sampleRate + 1e-6;
  return Number.isFinite(actualS) && Math.abs(actualS - expect) <= tol;
}
