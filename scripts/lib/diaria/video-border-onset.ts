/**
 * Medição da borda de INÍCIO dos itens do `blocks.json` (#13587, resíduo da
 * #13463): quanto cada detector erra o início que o editor aprovou.
 *
 * Só medição: nada daqui entra na decupagem nem no `build`. O CLI é
 * `scripts/video-bordas-13587.ts`; procedimento e resultado em
 * `docs/video-montagem-resolucao-tomadas-13463.md`, seção "Detecção da borda
 * de início (#13587, 19/11/2026)".
 *
 * Detectores comparados, todos ancorados na palavra que abre o item (a que a
 * decupagem já acha, no transcript longo ou na retranscrição curta):
 *   - a própria palavra (o que a decupagem grava hoje);
 *   - `energyOnset`: limiar de energia por janela curta (20 ms), contra o piso
 *     de ruído dos 6 s antes da palavra;
 *   - `islandOnset`: início da ilha de fala (do Silero, ou do detector de
 *     energia + F0 do `build`) que cobre a palavra;
 *   - a palavra com pré-rolagem fixa ou condicionada ao silêncio antes dela.
 * Critério da issue: início a até 0,6 s do aprovado. Tolerância de fallback
 * aceita pelo editor (19/11/2026): 1,5 s.
 */

import type { Envelope } from "./video-cut-refine.ts";
import type { BlocksFile, Interval, Transcript, Word } from "./video-montage.ts";

export const BORDER_CRITERION_S = 0.6;
/** Tolerância de fallback nas bordas, decisão do editor de 19/11/2026 (#13587). */
export const BORDER_FALLBACK_TOLERANCE_S = 1.5;

export const BORDER_ONSET = {
  /** Janela antes da palavra de onde sai o piso de ruído local (longa o bastante para pegar pausa mesmo em fala corrida). */
  floorWindowS: 6,
  /** Percentil do piso (o barulho de fundo, não a fala da tomada anterior). */
  floorPercentile: 0.2,
  /** Energia acima do piso que conta como som. */
  marginDb: 8,
  /** Quanto tempo o som precisa durar para valer como início. */
  sustainS: 0.06,
  /** Onde a busca começa, antes da palavra (o Whisper às vezes adianta, às vezes atrasa). */
  backS: 0.6,
  /** Até onde a busca vai depois da palavra. */
  forwardS: 1.2,
  /** Picos mais curtos que isto não quebram o silêncio de `quietBeforeS`. */
  blipS: 0.05,
  /** Teto da medida de silêncio antes da palavra. */
  maxQuietS: 10,
} as const;

const dbAt = (env: Envelope, t: number): number => {
  const i = Math.round(t / env.hopS);
  return i >= 0 && i < env.db.length ? env.db[i] : -Infinity;
};

function percentile(xs: number[], p: number): number {
  if (!xs.length) return -Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
}

/** O limiar de som perto de `anchorS`: piso local (percentil dos `floorWindowS` antes) + `marginDb`. */
export function localThresholdDb(env: Envelope, anchorS: number, o: typeof BORDER_ONSET = BORDER_ONSET): number {
  const xs: number[] = [];
  for (let t = Math.max(0, anchorS - o.floorWindowS); t < anchorS; t += env.hopS) xs.push(dbAt(env, t));
  return percentile(xs, o.floorPercentile) + o.marginDb;
}

/**
 * Início de som por energia de janela curta: o 1º instante em
 * `[anchor - backS, anchor + forwardS)` com energia acima do limiar local por
 * `sustainS` seguidos. `null` quando não acha (áudio fora do alcance ou sem som).
 */
export function energyOnset(env: Envelope, anchorS: number, o: typeof BORDER_ONSET = BORDER_ONSET): number | null {
  const thr = localThresholdDb(env, anchorS, o);
  const n = Math.max(1, Math.round(o.sustainS / env.hopS));
  const i0 = Math.max(0, Math.round((anchorS - o.backS) / env.hopS));
  const i1 = Math.min(env.db.length - n, Math.round((anchorS + o.forwardS) / env.hopS));
  for (let i = i0; i <= i1; i++) {
    let ok = true;
    for (let j = 0; j < n; j++)
      if (!(env.db[i + j] > thr)) {
        ok = false;
        break;
      }
    if (ok) return round2(i * env.hopS);
  }
  return null;
}

/** Quanto silêncio (abaixo do limiar local, picos de até `blipS` tolerados) há logo antes de `anchorS`. */
export function quietBeforeS(env: Envelope, anchorS: number, o: typeof BORDER_ONSET = BORDER_ONSET): number {
  const thr = localThresholdDb(env, anchorS, o);
  const maxBlip = Math.max(1, Math.round(o.blipS / env.hopS));
  let quiet = 0;
  let blip = 0;
  for (let i = Math.round(anchorS / env.hopS) - 1; i >= 0; i--) {
    const t = i * env.hopS;
    if (anchorS - t > o.maxQuietS) break;
    if (env.db[i] > thr) {
      if (++blip > maxBlip) break;
    } else {
      blip = 0;
      quiet = anchorS - t;
    }
  }
  return round2(quiet);
}

/**
 * Início da 1ª ilha que termina depois de `anchor - backS` e começa antes de
 * `anchor + forwardS`, sem recorte: a ilha que engole a tomada anterior (bruto
 * quente, M4 da #13463) aparece como erro grande, não como acerto.
 */
export function islandOnset(islands: readonly Interval[], anchorS: number, o: Pick<typeof BORDER_ONSET, "backS" | "forwardS"> = BORDER_ONSET): number | null {
  const isl = islands.find((x) => x.end > anchorS - o.backS);
  return isl && isl.start < anchorS + o.forwardS ? round2(isl.start) : null;
}

// ── As bordas aprovadas ───────────────────────────────────────────────────

/** Uma borda de início do `blocks.json`, com a palavra que abre o item. */
export interface ApprovedStart {
  block: string;
  falaId?: string;
  /** O início aprovado (Gate 2). */
  start: number;
  /** A 1ª palavra do texto do item, normalizada. */
  firstWord: string;
  /** Início dessa palavra no transcript longo (a mais perto do aprovado em [-1, +4] s). */
  wordLong: number | null;
  /** Idem, nas retranscrições curtas (`retranscribe-*.json`). */
  wordShort: number | null;
  /** O início não está no molde (`blocks.template.json`): o editor acertou a borda à mão. */
  handSet: boolean;
}

export const normWord = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]/g, "");

/** A palavra `w` (normalizada) que começa mais perto de `start`, entre `start - 1` e `start + 4`. */
export function nearestWordStart(words: readonly Word[], w: string, start: number): number | null {
  let best: number | null = null;
  for (const x of words) {
    if (normWord(x.text) !== w) continue;
    const d = x.start - start;
    if (d < -1 || d > 4) continue;
    if (best === null || Math.abs(d) < Math.abs(best - start)) best = x.start;
  }
  return best;
}

const wordsOf = (t: Transcript): Word[] => t.segments.flatMap((s) => s.words ?? []);

/**
 * As bordas de início explícitas do `blocks.json` (item só com texto fica de
 * fora: a borda dele é a da palavra, sem decisão), sem repetir o mesmo
 * início (o item que aparece em dois blocos conta uma vez).
 */
export function approvedStarts(input: { blocks: BlocksFile; transcript: Transcript; retranscriptions: readonly Transcript[]; templateStarts: readonly number[] }): ApprovedStart[] {
  const long = wordsOf(input.transcript);
  const short = input.retranscriptions.flatMap(wordsOf);
  const seen = new Set<number>();
  const out: ApprovedStart[] = [];
  for (const [block, items] of Object.entries(input.blocks.blocks))
    for (const it of items ?? []) {
      if (typeof it.start !== "number" || seen.has(it.start)) continue;
      seen.add(it.start);
      const firstWord = normWord((it.text ?? "").split(/\s+/)[0] ?? "");
      out.push({
        block,
        ...(it.falaId ? { falaId: it.falaId } : {}),
        start: it.start,
        firstWord,
        wordLong: firstWord ? nearestWordStart(long, firstWord, it.start) : null,
        wordShort: firstWord ? nearestWordStart(short, firstWord, it.start) : null,
        handSet: !input.templateStarts.some((s) => Math.abs(s - it.start!) < 0.05),
      });
    }
  return out;
}

/** A palavra que a decupagem usaria: a mais cedo entre a do transcript longo e a da retranscrição. */
export function anchorWord(a: Pick<ApprovedStart, "wordLong" | "wordShort">): number | null {
  if (a.wordLong !== null && a.wordShort !== null) return Math.min(a.wordLong, a.wordShort);
  return a.wordLong ?? a.wordShort;
}

// ── Placar ────────────────────────────────────────────────────────────────

/** Uma borda com o que cada detector previu para ela. */
export interface BorderMeasure extends ApprovedStart {
  anchor: number;
  quietBeforeS: number;
  predicted: Record<string, number | null>;
}

export interface MethodScore {
  method: string;
  /** Bordas em que o detector deu um valor. */
  n: number;
  withinCriterion: number;
  withinTolerance: number;
  medianAbsErrS: number | null;
  p90AbsErrS: number | null;
  maxAbsErrS: number | null;
  /** As que passam do critério: `início aprovado (erro)`. */
  misses: string[];
}

export function scoreMethod(method: string, rows: readonly BorderMeasure[], criterionS: number = BORDER_CRITERION_S, toleranceS: number = BORDER_FALLBACK_TOLERANCE_S): MethodScore {
  const errs: Array<{ row: BorderMeasure; e: number }> = [];
  for (const row of rows) {
    const p = row.predicted[method];
    if (typeof p === "number") errs.push({ row, e: round2(p - row.start) });
  }
  const abs = errs.map((x) => Math.abs(x.e));
  return {
    method,
    n: errs.length,
    withinCriterion: abs.filter((x) => x <= criterionS + 1e-9).length,
    withinTolerance: abs.filter((x) => x <= toleranceS + 1e-9).length,
    medianAbsErrS: abs.length ? percentile(abs, 0.5) : null,
    p90AbsErrS: abs.length ? percentile(abs, 0.9) : null,
    maxAbsErrS: abs.length ? Math.max(...abs) : null,
    misses: errs.filter((x) => Math.abs(x.e) > criterionS + 1e-9).map((x) => `${x.row.start} (${x.e > 0 ? "+" : ""}${x.e.toFixed(2)})`),
  };
}

/** Pré-rolagens fixas medidas (palavra - k). */
export const FIXED_PREROLL_S = [0.3, 0.5, 1.0] as const;
/** Grade da pré-rolagem condicional (palavra - k só quando há ≥ q s de silêncio antes). */
export const CONDITIONAL_GRID = { quietS: [1, 3, 5], prerollS: [0.2, 0.4, 0.6, 0.8] } as const;

/** Os detectores de uma borda, a partir da palavra, do envelope e das ilhas. */
export function measureBorder(a: ApprovedStart, ctx: { env: Envelope; sileroIslands?: readonly Interval[]; energyIslands?: readonly Interval[] }): BorderMeasure | null {
  const anchor = anchorWord(a);
  if (anchor === null) return null;
  const predicted: Record<string, number | null> = {
    "palavra (transcript longo)": a.wordLong,
    "palavra (retranscrição curta)": a.wordShort,
    "palavra (a mais cedo das duas)": anchor,
    "energia, janela de 20 ms": energyOnset(ctx.env, anchor),
  };
  if (ctx.sileroIslands) predicted["Silero (início da ilha)"] = islandOnset(ctx.sileroIslands, anchor);
  if (ctx.energyIslands) predicted["energia + F0 do build (início da ilha)"] = islandOnset(ctx.energyIslands, anchor);
  for (const k of FIXED_PREROLL_S) predicted[`palavra - ${k} s`] = round2(anchor - k);
  const quiet = quietBeforeS(ctx.env, anchor);
  for (const q of CONDITIONAL_GRID.quietS) for (const k of CONDITIONAL_GRID.prerollS) predicted[conditionalKey(q, k)] = round2(quiet >= q ? anchor - k : anchor);
  return { ...a, anchor, quietBeforeS: quiet, predicted };
}

export const conditionalKey = (q: number, k: number): string => `palavra - ${k} s se silêncio >= ${q} s`;

export interface BorderReport {
  edition: string;
  criterionS: number;
  toleranceS: number;
  rows: BorderMeasure[];
  /** Placar só das bordas acertadas à mão (o que de fato mede o detector). */
  handSet: MethodScore[];
  all: MethodScore[];
}

export function borderReport(edition: string, rows: readonly BorderMeasure[]): BorderReport {
  const methods = [...new Set(rows.flatMap((r) => Object.keys(r.predicted)))];
  const hand = rows.filter((r) => r.handSet);
  return {
    edition,
    criterionS: BORDER_CRITERION_S,
    toleranceS: BORDER_FALLBACK_TOLERANCE_S,
    rows: [...rows],
    handSet: methods.map((m) => scoreMethod(m, hand)),
    all: methods.map((m) => scoreMethod(m, rows)),
  };
}

/** Junta as bordas de várias edições num placar só (a grade é avaliada no conjunto). */
export function mergeReports(reports: readonly BorderReport[]): BorderReport {
  return borderReport(reports.map((r) => r.edition).join("+"), reports.flatMap((r) => r.rows));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
