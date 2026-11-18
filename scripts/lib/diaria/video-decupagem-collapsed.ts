/**
 * scripts/lib/diaria/video-decupagem-collapsed.ts (#13587, item A da #13463) —
 * tomada colapsada resolvida já na 1ª passada da decupagem.
 *
 * Até aqui a 1ª passada só avisava (`[aviso] segmento N: possível tomada
 * colapsada ... retranscribe --from --to`), a skill retranscrevia janela a
 * janela, e a linha "usar" do segmento colapsado levava ao
 * `blocks.template.json` o intervalo do segmento inteiro (todas as tomadas):
 * na 261118 o molde do gancho H1, de H7 e de H12 saiu 12,9 a 37,9 s antes da
 * tomada aprovada.
 *
 * Agora, na 1ª passada:
 *   1. `collapsedSegmentJobs`: um pedido por segmento suspeito, com a MESMA
 *      janela do aviso de hoje (`collapsedTakeSuspects`, 1ª suspeita) e o nome
 *      do arquivo que o `retranscribe --from --to` gravaria
 *      (`retranscribe-{de}-{até}.json`): retranscrição já feita à mão é
 *      reaproveitada, nunca refeita;
 *   2. as janelas que faltam vão ao Whisper numa chamada só (`--windows`, com o
 *      residente da #13506), sem VAD e sem `condition_on_previous_text`;
 *   3. `expandCollapsedSegments`: o segmento colapsado é trocado, na listagem
 *      numerada, pelos segmentos da retranscrição (as tomadas separadas, com a
 *      borda da palavra retranscrita e o ar de `takeInterval`), marcados como
 *      retranscritos;
 *   4. onde a janela inteira achou uma tomada só, `subJobsFor` pede as
 *      subjanelas (`retranscribe --sub`, #11958) e `repetitionNoteFor` diz na
 *      linha o falso começo que elas acharam (o corte em si segue no roteiro).
 *
 * A listagem expandida fica congelada em `decupagem-segments.json`
 * (`frozenListing`): a 2ª passada e o `roteiro` leem os mesmos números de
 * segmento que a skill classificou, mesmo que outra retranscrição apareça no
 * meio. Puro: o Whisper, o disco e o relógio entram por parâmetro.
 */

import { createHash } from "node:crypto";
import {
  TAKE_DEFAULTS,
  alignTokens,
  collapsedTakeSuspects,
  normalizeToken,
  describeCollapsedSuspect,
  findRepetitionCut,
  joinWordTexts,
  mergeWindowWords,
  subRetranscribeWindow,
  subWindows,
  takeInterval,
  type CollapsedTakeSuspect,
  type Interval,
  type RepetitionCut,
  type Segment,
  type Transcript,
  type Word,
} from "./video-montage.ts";

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Nome do arquivo de uma janela, igual ao do `retranscribe --from --to` (o `tag` do `cmdRetranscribe`). */
export function retranscribeKey(w: Interval): string {
  return `${w.start.toFixed(1)}-${w.end.toFixed(1)}`;
}
export const windowFileName = (key: string): string => `retranscribe-${key}.json`;
export const subWindowFileName = (key: string): string => `retranscribe-sub-${key}.json`;

export interface CollapsedSegmentJob {
  /** Índice 0-based do segmento no `transcript.json`. */
  segment: number;
  suspect: CollapsedTakeSuspect;
  /** A janela do aviso de hoje (a mesma do `retranscribe --from --to` sugerido). */
  window: Interval;
  key: string;
}

/** Um pedido por segmento com suspeita de tomada colapsada (#11754), com a janela da 1ª suspeita. */
export function collapsedSegmentJobs(segments: Segment[], silences: Interval[], durationS?: number): CollapsedSegmentJob[] {
  const out: CollapsedSegmentJob[] = [];
  segments.forEach((s, i) => {
    const sus = collapsedTakeSuspects(s.words ?? [], silences, { durationS });
    if (!sus.length) return;
    out.push({ segment: i, suspect: sus[0], window: sus[0].window, key: retranscribeKey(sus[0].window) });
  });
  return out;
}

/** As janelas que ainda não têm arquivo, sem repetir chave (dois segmentos podem cair na mesma janela). */
export function missingWindows(jobs: readonly CollapsedSegmentJob[], has: (key: string) => boolean): Array<{ key: string; start: number; end: number }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; start: number; end: number }> = [];
  for (const j of jobs) {
    if (seen.has(j.key) || has(j.key)) continue;
    seen.add(j.key);
    out.push({ key: j.key, start: j.window.start, end: j.window.end });
  }
  return out;
}

/** Por que um segmento suspeito ficou como estava na listagem. */
export type UnresolvedReason = "sem-retranscricao" | "janela-parcial" | "uma-tomada";

export interface ListingOrigin {
  /** Segmento do `transcript.json` (1-based) de onde a linha veio. */
  original: number;
  /** A linha é um segmento da retranscrição da janela (`file`), não do transcript longo. */
  retranscribed?: { file: string };
  /** Nota da linha na listagem (tomada separada, falso começo, suspeita que ficou). */
  note?: string;
}

export interface CollapsedExpansion {
  /** A listagem numerada: o transcript com cada segmento colapsado resolvido trocado pelas tomadas separadas. */
  segments: Segment[];
  /** Uma entrada por segmento da listagem. */
  origin: ListingOrigin[];
  /** Os suspeitos que ficaram inteiros, com o motivo. */
  unresolved: Array<{ job: CollapsedSegmentJob; reason: UnresolvedReason }>;
  /** Quantos segmentos colapsados viraram tomadas separadas. */
  resolved: number;
}

/** Folga, em segundos, para as palavras da retranscrição que caem logo fora do segmento (o Whisper longo erra a borda). */
const EDGE_TOL_S = 0.5;

/**
 * Troca cada segmento suspeito pelos segmentos da retranscrição da janela dele
 * quando ela separou as tomadas (2 ou mais segmentos dentro do trecho). As
 * palavras entram pelo meio delas, dentro do segmento com `EDGE_TOL_S` de
 * folga e nunca no segmento vizinho; o início e o fim de cada tomada saem de
 * `takeInterval` sobre as palavras retranscritas (o mesmo ar do `roteiro`),
 * sem passar da palavra do segmento vizinho. Janela que não cobre o segmento
 * inteiro (segmento de mais de 60 s) ou que achou uma tomada só deixa o
 * segmento como está, em `unresolved`.
 */
export function expandCollapsedSegments(
  segments: Segment[],
  jobs: readonly CollapsedSegmentJob[],
  windowOf: (key: string) => Transcript | null,
  silences: Interval[] = [],
): CollapsedExpansion {
  const byIndex = new Map(jobs.map((j) => [j.segment, j]));
  const out: Segment[] = [];
  const origin: ListingOrigin[] = [];
  const unresolved: CollapsedExpansion["unresolved"] = [];
  let resolved = 0;
  const guard = TAKE_DEFAULTS.guardS;
  segments.forEach((seg, i) => {
    const keep = () => {
      out.push(seg);
      origin.push({ original: i + 1 });
    };
    const job = byIndex.get(i);
    if (!job) return keep();
    const fail = (reason: UnresolvedReason) => {
      unresolved.push({ job, reason });
      out.push(seg);
      origin.push({ original: i + 1, note: unresolvedNote(job, reason) });
    };
    const patch = windowOf(job.key);
    if (!patch) return fail("sem-retranscricao");
    const ws = (seg.words ?? []).filter((w) => w.text.trim() !== "");
    const lo0 = ws.length ? ws[0].start : seg.start;
    const hi0 = ws.length ? ws[ws.length - 1].end : seg.end;
    if (job.window.start > lo0 + EDGE_TOL_S || job.window.end < hi0 - EDGE_TOL_S) return fail("janela-parcial");
    const prev = segments[i - 1];
    const next = segments[i + 1];
    const floor = Math.max(seg.start - EDGE_TOL_S, prev ? prev.end : Number.NEGATIVE_INFINITY);
    const ceil = Math.min(seg.end + EDGE_TOL_S, next ? next.start : Number.POSITIVE_INFINITY);
    const inRange = (w: Word) => w.text.trim() !== "" && (w.start + w.end) / 2 >= floor && (w.start + w.end) / 2 <= ceil;
    const parts = patch.segments
      .map((s) => ({ s, words: (s.words ?? []).filter(inRange).sort((a, b) => a.start - b.start) }))
      .filter((p) => p.words.length > 0)
      .sort((a, b) => a.words[0].start - b.words[0].start);
    // Uma parte só vale quando ela é a frase inteira sem o vão (a janela ouviu só a última tomada, como no gancho
    // da 261118: as anteriores ficam sem palavra e saem como bastidor); senão a janela não separou nada.
    if (parts.length === 0 || (parts.length === 1 && !isWholePhrase(parts[0].words, ws, silences))) return fail("uma-tomada");
    // O ar de cada tomada (takeInterval) sobre TODAS as palavras da janela no trecho: a borda não invade a tomada vizinha.
    const all = parts.flatMap((p) => p.words);
    const lowBound = prev ? prev.end + guard : 0;
    const highBound = next ? next.start - guard : Number.POSITIVE_INFINITY;
    let at = 0;
    const file = windowFileName(job.key);
    parts.forEach((p, k) => {
      const iv = takeInterval(all, { firstWord: at, lastWord: at + p.words.length - 1 });
      at += p.words.length;
      const start = round3(Math.max(iv.start, Math.min(p.words[0].start, lowBound)));
      const end = round3(Math.min(iv.end, Math.max(p.words[p.words.length - 1].end, highBound)));
      out.push({
        start,
        end,
        text: joinWordTexts(p.words.map((w) => w.text.trim())),
        words: p.words,
        ...(p.s.no_speech_prob !== undefined ? { no_speech_prob: p.s.no_speech_prob } : {}),
        ...(p.s.avg_logprob !== undefined ? { avg_logprob: p.s.avg_logprob } : {}),
      });
      origin.push({
        original: i + 1,
        retranscribed: { file },
        note:
          parts.length === 1
            ? `retranscrito: a tomada separada do segmento ${i + 1} do transcript; o resto do trecho ficou sem palavra na retranscrição (tomadas anteriores, sai como bastidor) (tomada colapsada, ${describeCollapsedSuspect(job.suspect)}; ${file}, #13587)`
            : `retranscrito: parte ${k + 1} de ${parts.length} do segmento ${i + 1} do transcript (tomada colapsada, ${describeCollapsedSuspect(job.suspect)}; ${file}, #13587)`,
      });
    });
    resolved++;
  });
  return { segments: out, origin, unresolved, resolved };
}

/** Fração das palavras do segmento colapsado que a parte única precisa repetir, em ordem, para ser a frase inteira. */
export const WHOLE_PHRASE_MIN = 0.8;

/**
 * A parte única da retranscrição é a frase do segmento, já sem a tomada
 * colapsada: repete em ordem pelo menos `WHOLE_PHRASE_MIN` das palavras dele e
 * não tem, ela mesma, vão de som sem palavra.
 */
function isWholePhrase(part: Word[], segWords: Word[], silences: Interval[]): boolean {
  const want = segWords.map((w) => normalizeToken(w.text)).filter(Boolean);
  const got = part.map((w) => normalizeToken(w.text)).filter(Boolean);
  if (!want.length || !got.length) return false;
  if (alignTokens(got, want).length < WHOLE_PHRASE_MIN * want.length) return false;
  return collapsedTakeSuspects(part, silences).length === 0;
}

function unresolvedNote(job: CollapsedSegmentJob, reason: UnresolvedReason): string {
  const what = describeCollapsedSuspect(job.suspect);
  const w = `${job.window.start.toFixed(1)}–${job.window.end.toFixed(1)} s`;
  if (reason === "sem-retranscricao") return `possível tomada colapsada (${what}), sem retranscrição da janela ${w}: conferir no áudio (#13587)`;
  if (reason === "janela-parcial") return `possível tomada colapsada (${what}); o segmento passa da janela de retranscrição (${w}): conferir no áudio (#13587)`;
  return `possível tomada colapsada (${what}); a retranscrição de ${w} achou uma tomada só (#13587)`;
}

/** As subjanelas (`retranscribe --sub`, #11958) dos segmentos em que a janela inteira achou uma tomada só, sem repetir chave. */
export function subJobsFor(unresolved: CollapsedExpansion["unresolved"], has: (key: string) => boolean): Array<{ key: string; start: number; end: number }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; start: number; end: number }> = [];
  for (const u of unresolved) {
    if (u.reason !== "uma-tomada") continue;
    for (const w of subWindows(subRetranscribeWindow(u.job.suspect))) {
      const key = retranscribeKey(w);
      if (seen.has(key) || has(key)) continue;
      seen.add(key);
      out.push({ key, start: w.start, end: w.end });
    }
  }
  return out;
}

/**
 * O falso começo que as subjanelas acharam no segmento (`findRepetitionCut`,
 * a mesma busca do `roteiro`), ou null. `subs` = as subjanelas gravadas, com a
 * janela delas.
 */
export function repetitionFor(seg: Segment, job: CollapsedSegmentJob, subs: ReadonlyArray<{ start: number; end: number; words: Word[] }>, silences: Interval[]): RepetitionCut | null {
  const sus = job.suspect;
  const margin = 1.5;
  const near = subs.filter((p) => p.end >= sus.at - margin && p.start <= sus.end + margin);
  if (!near.length) return null;
  return findRepetitionCut(seg.words ?? [], sus, mergeWindowWords(near), silences);
}

/** A nota da linha quando as subjanelas acharam (ou não) o falso começo. */
export function repetitionNote(rep: RepetitionCut | null, job: CollapsedSegmentJob): string {
  if (!rep) return `possível tomada colapsada (${describeCollapsedSuspect(job.suspect)}); nem a janela nem as subjanelas separaram: conferir no áudio (#13587)`;
  return `falso começo "${rep.falseStart}" em ${rep.cut.start.toFixed(2)}–${rep.cut.end.toFixed(2)} s (subjanelas): o roteiro propõe o corte na linha repetição, a fala fica neste segmento (#11958, #13587)`;
}

// ── Listagem congelada (`decupagem-segments.json`) ────────────────────────

/** Arquivo da listagem expandida, no state dir. */
export const DECUPAGEM_SEGMENTS_FILE = "decupagem-segments.json";

export interface FrozenListing {
  edition: string;
  /** Hash dos segmentos do `transcript.json` de que a listagem saiu. */
  transcriptSha256: string;
  segments: Segment[];
  origin: ListingOrigin[];
}

/** Hash do que numera a listagem: início, fim e texto de cada segmento do transcript. */
export function transcriptSegmentsSha256(segments: readonly Segment[]): string {
  const h = createHash("sha256");
  for (const s of segments) h.update(`${s.start}|${s.end}|${s.text}\n`);
  return h.digest("hex");
}

export function freezeListing(edition: string, transcript: readonly Segment[], expansion: Pick<CollapsedExpansion, "segments" | "origin">): FrozenListing {
  return { edition, transcriptSha256: transcriptSegmentsSha256(transcript), segments: expansion.segments, origin: expansion.origin };
}

/**
 * Os segmentos que a 2ª passada (e o `roteiro`) numeram: a listagem congelada
 * da 1ª passada, quando ela é deste transcript; sem o arquivo (plano anterior
 * ao #13587), os do transcript. Listagem de outro transcript é erro: os
 * números do plano não apontariam para as mesmas falas.
 */
export function listingSegments(transcript: Segment[], frozen: unknown, edition: string): { segments: Segment[]; origin: ListingOrigin[] | null } {
  if (frozen === null || frozen === undefined) return { segments: transcript, origin: null };
  const f = frozen as Partial<FrozenListing>;
  if (!f || typeof f !== "object" || !Array.isArray(f.segments) || !Array.isArray(f.origin) || typeof f.transcriptSha256 !== "string") {
    throw new Error(`${DECUPAGEM_SEGMENTS_FILE} ilegível: refazer a 1ª passada da decupagem (mover o decupagem-plan.json e rodar decupagem)`);
  }
  if (f.edition !== edition) throw new Error(`${DECUPAGEM_SEGMENTS_FILE} é da edição ${String(f.edition)}, não ${edition}`);
  if (f.transcriptSha256 !== transcriptSegmentsSha256(transcript)) {
    throw new Error(`${DECUPAGEM_SEGMENTS_FILE} é de outro transcript.json: os números do decupagem-plan.json não valem mais; refazer a 1ª passada (mover o decupagem-plan.json e o ${DECUPAGEM_SEGMENTS_FILE} e rodar decupagem)`);
  }
  return { segments: f.segments as Segment[], origin: f.origin as ListingOrigin[] };
}

/**
 * A 1ª passada inteira, com o Whisper e o disco por parâmetro (testável sem
 * Python): retranscreve numa chamada só as janelas que faltam, expande, pede
 * as subjanelas onde a janela achou uma tomada só (outra chamada só) e escreve
 * a nota do falso começo nessas linhas.
 */
export interface CollapsedListingIO {
  /** A retranscrição da janela já gravada (tempo do bruto), ou null. */
  readWindow(key: string): Transcript | null;
  /** A subjanela já gravada, ou null. */
  readSub(key: string): Transcript | null;
  /** Retranscreve e GRAVA as janelas (uma chamada do Whisper); false = sem áudio nesta máquina (nada feito). */
  transcribeWindows(wins: Array<{ key: string; start: number; end: number }>, kind: "janela" | "sub"): boolean;
}

export interface CollapsedListingResult extends CollapsedExpansion {
  jobs: CollapsedSegmentJob[];
  /** Janelas e subjanelas retranscritas nesta passada (as já gravadas não contam). */
  transcribed: { windows: number; subs: number };
  /** O áudio faltou para alguma retranscrição: as suspeitas ficam como aviso. */
  audioMissing: boolean;
}

export function resolveCollapsedListing(
  segments: Segment[],
  silences: Interval[],
  durationS: number | undefined,
  io: CollapsedListingIO,
  opts: { retranscribe?: boolean } = {},
): CollapsedListingResult {
  const jobs = collapsedSegmentJobs(segments, silences, durationS);
  const allow = opts.retranscribe !== false;
  let audioMissing = false;
  const transcribed = { windows: 0, subs: 0 };
  const missing = missingWindows(jobs, (k) => io.readWindow(k) !== null);
  if (allow && missing.length) {
    if (io.transcribeWindows(missing, "janela")) transcribed.windows = missing.length;
    else audioMissing = true;
  }
  const exp = expandCollapsedSegments(segments, jobs, (k) => io.readWindow(k), silences);
  const oneTake = exp.unresolved.filter((u) => u.reason === "uma-tomada");
  if (oneTake.length) {
    const subMissing = subJobsFor(oneTake, (k) => io.readSub(k) !== null);
    if (allow && subMissing.length) {
      if (io.transcribeWindows(subMissing, "sub")) transcribed.subs = subMissing.length;
      else audioMissing = true;
    }
    for (const u of oneTake) {
      const subs = subWindows(subRetranscribeWindow(u.job.suspect))
        .map((w) => ({ w, t: io.readSub(retranscribeKey(w)) }))
        .filter((x): x is { w: Interval; t: Transcript } => x.t !== null)
        .map(({ w, t }) => ({ start: t.sub?.window.start ?? w.start, end: t.sub?.window.end ?? w.end, words: t.segments.flatMap((s) => s.words ?? []) }));
      if (!subs.length) continue;
      const seg = segments[u.job.segment];
      const at = exp.origin.findIndex((o) => o.original === u.job.segment + 1 && !o.retranscribed);
      if (at >= 0) exp.origin[at] = { ...exp.origin[at], note: repetitionNote(repetitionFor(seg, u.job, subs, silences), u.job) };
    }
  }
  return { ...exp, jobs, transcribed, audioMissing };
}
