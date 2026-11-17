/**
 * scripts/lib/diaria/video-vad-vote.ts (#13369, R2 da #13199)
 *
 * MEDIÇÃO do Silero VAD como 2º voto nas pausas ambíguas do corte, sem mexer
 * no `build`: o detector de fala da montagem (energia + F0, `speechIslands`,
 * #12089/#12263/#13188/#13194) decide sozinho; aqui se mede o que o Silero
 * teria votado em cada ponta de clipe e em cada pausa interna, contra o que o
 * EDITOR fez com o corte no Premiere (o registro do `video-xml-vs-final`,
 * #13196: ponta estendida, aparada ou mantida, pausa interna removida).
 *
 * O voto, por ponta de clipe do XML (a pausa ambígua mora nas pontas: é ali
 * que sobra respiração ou sai sílaba):
 *   - `estender`: o Silero ouve fala (pelo menos `minSpeechS` seguidos acima
 *     de `threshold`) nos `outsideLookS` FORA do clipe, colados à ponta (a
 *     sílaba que o corte tirou);
 *   - `aparar`: nenhuma janela de fala nos `insideLookS` DENTRO do clipe,
 *     colados à ponta (mais que a folga do detector, 150 ms antes / 120 ms
 *     depois da fala, `SPEECH_DETECT`): respiração ou ruído que sobrou;
 *   - `manter`: nenhum dos dois.
 * O editor: `headMs`/`tailMs` acima de `editorTolMs` = estendeu, abaixo de
 * −`editorTolMs` = aparou, senão manteve. Ponta que o editor juntou ao clipe
 * vizinho (`joinedHead`/`joinedTail`) e clipe removido ficam de fora.
 *
 * As probabilidades vêm de `scripts/video/vad_probs.py` (uma por janela de
 * 32 ms do `audio.wav` do `transcribe`, na linha do tempo do bruto, a mesma do
 * `plan.json`). Puro: o CLI (`scripts/video-medicoes.ts vad`) lê arquivos e
 * roda o Python.
 */

import type { ClipComparison, EditionRecord } from "./video-xml-vs-final.ts";

export const VAD_VOTE_SCHEMA = 1;

export interface VadProbs {
  hopS: number;
  probs: number[];
}

export const VAD_VOTE = {
  /** Probabilidade a partir da qual a janela é fala (o default do Silero). */
  threshold: 0.5,
  /** Fala contínua mínima para votar "estender" (2 janelas de 32 ms): 1 janela isolada é estalo. */
  minSpeechS: 0.064,
  /** Quanto olhar fora do clipe, colado à ponta. */
  outsideLookS: 0.3,
  /** Quanto olhar dentro do clipe na entrada: a folga de 150 ms do detector + 150 ms. */
  insideHeadS: 0.3,
  /** Na saída: a folga de 120 ms + 150 ms. */
  insideTailS: 0.27,
  /** Diferença do editor abaixo disto é "manteve" (o alinhamento do xml-vs-final erra dezenas de ms). */
  editorTolMs: 40,
} as const;

export type VadVoteParams = { -readonly [K in keyof typeof VAD_VOTE]: number };

export type EdgeVote = "estender" | "aparar" | "manter";
export type EditorEdge = "estendeu" | "aparou" | "manteve";

export interface EdgeMeasure {
  seq: string;
  clip: number;
  side: "entrada" | "saida";
  /** Ponta no bruto (s). */
  t: number;
  vote: EdgeVote;
  editor: EditorEdge;
  editorMs: number;
  /** Voto e editor na mesma direção (estender/estendeu, aparar/aparou, manter/manteve). */
  agree: boolean;
}

export interface PauseMeasure {
  seq: string;
  clip: number;
  start: number;
  end: number;
  /** Fração das janelas da pausa com fala pelo Silero. */
  speechFraction: number;
  /** O Silero também corta a pausa (sem fala contínua nela). */
  vadCuts: boolean;
}

export interface VadVoteSummary {
  edges: number;
  /** Pontas que o editor mexeu (estendeu ou aparou). */
  editorTouched: number;
  /** Pontas em que o voto pede mudança (estender ou aparar). */
  voteChanges: number;
  /** Voto de mudança na mesma direção do editor. */
  hits: number;
  /** Voto de mudança onde o editor manteve (o voto teria piorado o corte aprovado). */
  falseAlarms: number;
  /** Voto de mudança na direção oposta à do editor. */
  opposite: number;
  /** Editor mexeu e o voto ficou em manter. */
  missed: number;
  pausesRemoved: number;
  /** Pausas internas removidas pelo editor que o Silero também cortaria. */
  pausesVadCuts: number;
  /** Matriz voto × editor. */
  confusion: Record<EdgeVote, Record<EditorEdge, number>>;
}

export interface VadVoteReport {
  schema: typeof VAD_VOTE_SCHEMA;
  edition: string;
  method: "silero-vad-vote-v1";
  params: VadVoteParams;
  edges: EdgeMeasure[];
  pauses: PauseMeasure[];
  summary: VadVoteSummary;
  skipped: Array<{ seq: string; reason: string }>;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Janelas (índices) cujo intervalo [i·hop, (i+1)·hop) cruza [a, b). */
function windowRange(v: VadProbs, a: number, b: number): [number, number] {
  const lo = Math.max(0, Math.floor(a / v.hopS + 1e-9));
  const hi = Math.min(v.probs.length, Math.ceil(b / v.hopS - 1e-9));
  return [lo, hi];
}

/** Maior sequência contínua de janelas com fala em [a, b), em segundos. */
export function longestSpeechRunS(v: VadProbs, a: number, b: number, threshold: number = VAD_VOTE.threshold): number {
  const [lo, hi] = windowRange(v, a, b);
  let best = 0;
  let cur = 0;
  for (let i = lo; i < hi; i++) {
    cur = v.probs[i] >= threshold ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best * v.hopS;
}

/** Fração das janelas em [a, b) com fala. */
export function speechFraction(v: VadProbs, a: number, b: number, threshold: number = VAD_VOTE.threshold): number {
  const [lo, hi] = windowRange(v, a, b);
  if (hi <= lo) return 0;
  let n = 0;
  for (let i = lo; i < hi; i++) if (v.probs[i] >= threshold) n++;
  return n / (hi - lo);
}

/** O voto do Silero numa ponta de clipe. */
export function edgeVote(v: VadProbs, t: number, side: "entrada" | "saida", p: VadVoteParams = { ...VAD_VOTE }): EdgeVote {
  const outside = side === "entrada" ? [t - p.outsideLookS, t] : [t, t + p.outsideLookS];
  if (longestSpeechRunS(v, outside[0], outside[1], p.threshold) >= p.minSpeechS - 1e-9) return "estender";
  const inside = side === "entrada" ? [t, t + p.insideHeadS] : [t - p.insideTailS, t];
  if (longestSpeechRunS(v, inside[0], inside[1], p.threshold) === 0) return "aparar";
  return "manter";
}

export function editorEdge(ms: number, tolMs: number = VAD_VOTE.editorTolMs): EditorEdge {
  return ms > tolMs ? "estendeu" : ms < -tolMs ? "aparou" : "manteve";
}

const AGREE: Record<EdgeVote, EditorEdge> = { estender: "estendeu", aparar: "aparou", manter: "manteve" };

function emptyConfusion(): Record<EdgeVote, Record<EditorEdge, number>> {
  const row = () => ({ estendeu: 0, aparou: 0, manteve: 0 });
  return { estender: row(), aparar: row(), manter: row() };
}

export function summarizeVadVote(edges: readonly EdgeMeasure[], pauses: readonly PauseMeasure[]): VadVoteSummary {
  const confusion = emptyConfusion();
  for (const e of edges) confusion[e.vote][e.editor]++;
  const changes = edges.filter((e) => e.vote !== "manter");
  return {
    edges: edges.length,
    editorTouched: edges.filter((e) => e.editor !== "manteve").length,
    voteChanges: changes.length,
    hits: changes.filter((e) => e.agree).length,
    falseAlarms: changes.filter((e) => e.editor === "manteve").length,
    opposite: changes.filter((e) => !e.agree && e.editor !== "manteve").length,
    missed: edges.filter((e) => e.vote === "manter" && e.editor !== "manteve").length,
    pausesRemoved: pauses.length,
    pausesVadCuts: pauses.filter((x) => x.vadCuts).length,
    confusion,
  };
}

/**
 * Mede o voto numa edição: cada ponta dos clipes mantidos de cada sequência
 * do registro do `video-xml-vs-final`, e cada pausa interna que o editor
 * removeu. Sequência sem `detail` (registro importado da #11670) vai para
 * `skipped`.
 */
export function measureVadVote(input: { record: Pick<EditionRecord, "edition" | "sequences">; vad: VadProbs; params?: Partial<VadVoteParams> }): VadVoteReport {
  if (!(input.vad.hopS > 0)) throw new Error("vad: hopS inválido");
  const p: VadVoteParams = { ...VAD_VOTE, ...(input.params ?? {}) };
  const edges: EdgeMeasure[] = [];
  const pauses: PauseMeasure[] = [];
  const skipped: VadVoteReport["skipped"] = [];
  const endS = input.vad.probs.length * input.vad.hopS;
  for (const s of input.record.sequences) {
    const clips: ClipComparison[] | undefined = s.detail?.clips;
    if (!clips) {
      skipped.push({ seq: s.key, reason: "registro sem detalhe por clipe" });
      continue;
    }
    const beyond: number[] = [];
    for (const c of clips) {
      if (c.status !== "kept" || c.headMs === null || c.tailMs === null) continue;
      if (c.srcOut > endS + 1e-6) {
        beyond.push(c.index);
        continue;
      }
      const push = (side: "entrada" | "saida", t: number, ms: number) => {
        const vote = edgeVote(input.vad, t, side, p);
        const editor = editorEdge(ms, p.editorTolMs);
        edges.push({ seq: s.key, clip: c.index, side, t, vote, editor, editorMs: ms, agree: AGREE[vote] === editor });
      };
      if (!c.joinedHead) push("entrada", c.srcIn, c.headMs);
      if (!c.joinedTail) push("saida", c.srcOut, c.tailMs);
      for (const g of c.internalPauses) {
        const frac = speechFraction(input.vad, g.start, g.end, p.threshold);
        pauses.push({ seq: s.key, clip: c.index, start: g.start, end: g.end, speechFraction: r3(frac), vadCuts: longestSpeechRunS(input.vad, g.start, g.end, p.threshold) < p.minSpeechS - 1e-9 });
      }
    }
    if (beyond.length) skipped.push({ seq: s.key, reason: `${beyond.length} clipe(s) além do fim do áudio do VAD (${r3(endS)} s; clipes ${beyond.join(", ")}): áudio de outro bruto ou cortado?` });
  }
  return { schema: VAD_VOTE_SCHEMA, edition: input.record.edition, method: "silero-vad-vote-v1", params: p, edges, pauses, summary: summarizeVadVote(edges, pauses), skipped };
}

export interface VadVoteAggregate {
  editions: string[];
  summary: VadVoteSummary;
  /** Das mudanças que o voto pede, quantas o editor fez igual (null sem voto de mudança). */
  precision: number | null;
  /** Das pontas que o editor mexeu, quantas o voto pegou na mesma direção (null sem ponta mexida). */
  recall: number | null;
}

/** Soma as edições medidas (a decisão de levar o voto ao `build` é do editor, com estes números). */
export function aggregateVadVote(reports: readonly VadVoteReport[]): VadVoteAggregate {
  const summary = summarizeVadVote(reports.flatMap((r) => r.edges), reports.flatMap((r) => r.pauses));
  const ratio = (a: number, b: number) => (b > 0 ? r3(a / b) : null);
  return {
    editions: [...new Set(reports.map((r) => r.edition))].sort(),
    summary,
    precision: ratio(summary.hits, summary.voteChanges),
    recall: ratio(summary.hits, summary.editorTouched),
  };
}
