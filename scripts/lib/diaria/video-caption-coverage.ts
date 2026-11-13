/**
 * video-caption-coverage.ts (#12935) — a fala do áudio está coberta pelas
 * palavras/legendas?
 *
 * Achado de 12/11/2026: num vídeo avulso legendado à mão, a transcrição com
 * VAD omitiu 6 s de fala (1:39–1:45). A legenda dessincronizou a partir dali
 * e uma cue ficou 11 s na tela; só o editor, assistindo, pegou. As duas
 * conferências aqui medem isso pelo áudio, sem ouvir:
 *
 * - `captionCoverageFindings`: legenda longa demais (a cue que "esticou" sobre
 *   a fala perdida) e trecho com fala (energia acima do `silencedetect`) sem
 *   nenhuma legenda na tela. Autorrevisão do `video-montagem.ts legendar`.
 * - `speechWithoutWords`: trecho com fala sem nenhuma palavra no transcript.
 *   Conferência do `transcribe` do bruto (com VAD), que aponta a janela para o
 *   `retranscribe` (sem VAD).
 *
 * A "fala" é o complemento dos silêncios do `silencedetect`: ruído alto
 * (respiração, música) também conta, então o resultado é `[aviso]` para
 * conferir, nunca recusa. Tudo puro.
 */

import { clockTime, type Interval, type Word } from "./video-montage.ts";

/** Limiares da conferência (segundos). */
export const CAPTION_COVERAGE_DEFAULTS = {
  /** Cue acima disso na tela é suspeita (a da 261112 ficou 11 s; as normais ficam abaixo de 5 s). */
  maxCueS: 7,
  /** Fala sem legenda abaixo disso é respiro/ruído curto, não fala perdida. */
  minGapS: 1.5,
  /** Folga em volta de cada cue/palavra antes de contar a fala como descoberta. */
  padS: 0.3,
  /** Fala sem palavra no transcript do bruto: a partir disso vira aviso (a frase perdida da 261112 tinha 6 s). */
  minWordGapS: 2,
} as const;

/** Trechos com fala: o complemento dos silêncios em [0, durationS]. */
export function speechIntervals(silences: Interval[], durationS: number): Interval[] {
  const sorted = [...silences].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  let t = 0;
  for (const s of sorted) {
    const start = Math.max(0, Math.min(s.start, durationS));
    if (start > t) out.push({ start: t, end: start });
    t = Math.max(t, Math.min(s.end, durationS));
  }
  if (durationS > t) out.push({ start: t, end: durationS });
  return out;
}

/** O que sobra de `from` depois de tirar `cover` (cada intervalo de `cover` aumentado de `padS` de cada lado). */
export function subtractIntervals(from: Interval[], cover: Interval[], padS = 0): Interval[] {
  const pads = cover.map((c) => ({ start: c.start - padS, end: c.end + padS })).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const f of from) {
    let pieces: Interval[] = [{ ...f }];
    for (const c of pads) {
      if (c.end <= f.start || c.start >= f.end) continue;
      pieces = pieces.flatMap((p) => {
        if (c.end <= p.start || c.start >= p.end) return [p];
        const keep: Interval[] = [];
        if (c.start > p.start) keep.push({ start: p.start, end: c.start });
        if (c.end < p.end) keep.push({ start: c.end, end: p.end });
        return keep;
      });
    }
    out.push(...pieces);
  }
  return out;
}

export interface CaptionCoverageFinding {
  kind: "legenda-longa" | "fala-sem-legenda";
  start: number;
  end: number;
  line: string;
}

/**
 * Autorrevisão de uma legenda contra o áudio (#12935): cue com mais de
 * `maxCueS` na tela, e fala (fora dos silêncios) sem cue por `minGapS` ou mais.
 * `cues` são os tempos de `cueTimings`. Ordenado pelo tempo. Puro.
 */
export function captionCoverageFindings(input: {
  cues: Array<{ start: number; end: number; text: string }>;
  silences: Interval[];
  durationS: number;
  maxCueS?: number;
  minGapS?: number;
  padS?: number;
}): CaptionCoverageFinding[] {
  const maxCueS = input.maxCueS ?? CAPTION_COVERAGE_DEFAULTS.maxCueS;
  const minGapS = input.minGapS ?? CAPTION_COVERAGE_DEFAULTS.minGapS;
  const padS = input.padS ?? CAPTION_COVERAGE_DEFAULTS.padS;
  const out: CaptionCoverageFinding[] = [];
  for (const c of input.cues) {
    const d = c.end - c.start;
    if (d > maxCueS) {
      out.push({
        kind: "legenda-longa",
        start: c.start,
        end: c.end,
        line: `legenda de ${d.toFixed(1)} s na tela em ${clockTime(c.start)}–${clockTime(c.end)} ("${c.text}"): provável fala sem transcrição dentro dela`,
      });
    }
  }
  const gaps = subtractIntervals(speechIntervals(input.silences, input.durationS), input.cues, padS).filter((g) => g.end - g.start >= minGapS);
  for (const g of gaps) {
    out.push({
      kind: "fala-sem-legenda",
      start: g.start,
      end: g.end,
      line: `${(g.end - g.start).toFixed(1)} s com som de fala e sem legenda em ${clockTime(g.start)}–${clockTime(g.end)}`,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Conferência do transcript do bruto (#12935 item 2): trechos com fala (fora
 * dos silêncios) sem nenhuma palavra por `minGapS` ou mais, que o VAD pode ter
 * descartado. Puro.
 */
export function speechWithoutWords(input: { words: Word[]; silences: Interval[]; durationS: number; minGapS?: number; padS?: number }): Interval[] {
  const minGapS = input.minGapS ?? CAPTION_COVERAGE_DEFAULTS.minWordGapS;
  const padS = input.padS ?? CAPTION_COVERAGE_DEFAULTS.padS;
  return subtractIntervals(speechIntervals(input.silences, input.durationS), input.words, padS).filter((g) => g.end - g.start >= minGapS);
}

/**
 * Linhas de `[aviso]` do `transcribe` para cada trecho de `speechWithoutWords`
 * (#12935 item 2), com o `retranscribe` (sem VAD) da janela: 1 s de folga de
 * cada lado, no máximo `maxWindowS` (o teto do `retranscribe`). Puro.
 */
export function speechWithoutWordsWarnings(gaps: Interval[], edition: string, maxWindowS: number, durationS: number): string[] {
  return gaps.map((g) => {
    const from = Math.max(0, Math.floor(g.start - 1));
    const to = Math.min(Math.ceil(durationS), Math.ceil(g.end + 1), from + maxWindowS);
    return (
      `${(g.end - g.start).toFixed(1)} s com som de fala e nenhuma palavra no transcript em ${clockTime(g.start)}–${clockTime(g.end)} ` +
      `(o VAD pode ter descartado fala, #12935): conferir com \`npx tsx scripts/video-montagem.ts retranscribe ${edition} --from ${from} --to ${to}\` (sem VAD)`
    );
  });
}
