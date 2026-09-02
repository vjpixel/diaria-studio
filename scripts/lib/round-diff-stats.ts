/**
 * scripts/lib/round-diff-stats.ts (#7113)
 *
 * "Hoje ninguém mede isso" — este módulo fecha a lacuna: mede e persiste a
 * razão adição:remoção de cada rodada autônoma (`/diaria-overnight`,
 * `/diaria-develop`, `/diaria-continuo`), e agrega a série em janelas (7d/
 * 30d/90d) pra tornar a razão consultável, não só pontual.
 *
 * ─── Onde a série mora ─────────────────────────────────────────────────────
 *
 * Não é um arquivo novo — reusa `data/run-log.jsonl` (via
 * `scripts/lib/run-log.ts`), o mesmo canal append-only já usado pra
 * instrumentação de custo (`subagent_metrics`/`coordinator_tokens_estimate`/
 * `review_metrics`, ver `check-overnight-token-instrumentation.ts`). Um novo
 * tipo de evento (`message: "round_diff_stats"`) evita inventar um 2º
 * mecanismo de persistência pra um dado da MESMA família (métrica
 * operacional por rodada).
 *
 * ─── Design: tudo puro, I/O só no CLI (`measure-round-diff-stats.ts` /
 * `round-diff-stats-report.ts`) ────────────────────────────────────────────
 *
 * Este módulo nunca chama `git`/`fs`/`gh` — recebe `DiffLineStats` já
 * calculado (`scripts/lib/diff-line-stats.ts`) e eventos já lidos do
 * run-log. É o que permite testar com dado sintético, como #7113 exige.
 */
import { diffNet, diffRatio, formatRatio, type DiffLineStats } from "./diff-line-stats.ts";
import type { RunLogEvent } from "./run-log.ts";

export const ROUND_DIFF_STATS_MESSAGE = "round_diff_stats";

export type RoundSessionKind = "overnight" | "develop" | "continuo";

export interface RoundDiffStatsRecord {
  sessionKind: RoundSessionKind;
  /** Ref/sha do início da rodada (commit-base). */
  base: string;
  /** Ref/sha do fim da rodada (HEAD no momento da medição). */
  head: string;
  files: number;
  added: number;
  removed: number;
  /** `null` = sem remoções nesta rodada (não é 0, é indefinido). */
  ratio: number | null;
  net: number;
  /** ISO 8601 — quando a medição foi tirada (não quando a rodada começou). */
  capturedAt: string;
}

/**
 * Constrói o `RoundDiffStatsRecord` a partir de stats de diff já calculados.
 * Puro — sem I/O.
 */
export function buildRoundDiffStatsRecord(
  input: { sessionKind: RoundSessionKind; base: string; head: string; stats: DiffLineStats },
  now: Date = new Date(),
): RoundDiffStatsRecord {
  const { added, removed, files } = input.stats;
  return {
    sessionKind: input.sessionKind,
    base: input.base,
    head: input.head,
    files,
    added,
    removed,
    ratio: diffRatio(added, removed),
    net: diffNet(added, removed),
    capturedAt: now.toISOString(),
  };
}

/**
 * Envelope pra `logEvent`/`buildLogEvent` (`scripts/lib/run-log.ts`) — o CLI
 * é quem de fato persiste; esta função só monta o payload.
 */
export function buildRoundDiffStatsRunLogEvent(
  record: RoundDiffStatsRecord,
  edition: string | null = null,
): RunLogEvent {
  return {
    edition,
    stage: null,
    agent: record.sessionKind,
    level: "info",
    message: ROUND_DIFF_STATS_MESSAGE,
    details: record,
  };
}

/** Formato mínimo esperado de uma linha já parseada de `run-log.jsonl`. */
interface RunLogLikeEntry {
  message?: unknown;
  details?: unknown;
  timestamp?: unknown;
}

/**
 * Extrai os `RoundDiffStatsRecord` válidos de um array de entradas já
 * parseadas do `run-log.jsonl` (`JSON.parse` linha a linha, feito pelo
 * caller — este módulo não lê arquivo). Entradas malformadas/de outro tipo
 * de evento são ignoradas silenciosamente (mesmo padrão de
 * `check-overnight-token-instrumentation.ts`: contagem tolerante a ruído).
 */
export function parseRoundDiffStatsEvents(entries: readonly unknown[]): RoundDiffStatsRecord[] {
  const out: RoundDiffStatsRecord[] = [];
  for (const raw of entries) {
    const entry = raw as RunLogLikeEntry;
    if (!entry || entry.message !== ROUND_DIFF_STATS_MESSAGE) continue;
    const d = entry.details as Partial<RoundDiffStatsRecord> | undefined;
    if (!d || typeof d !== "object") continue;
    if (
      typeof d.sessionKind !== "string" ||
      typeof d.base !== "string" ||
      typeof d.head !== "string" ||
      typeof d.files !== "number" ||
      typeof d.added !== "number" ||
      typeof d.removed !== "number" ||
      typeof d.net !== "number" ||
      typeof d.capturedAt !== "string"
    ) {
      continue;
    }
    out.push({
      sessionKind: d.sessionKind as RoundSessionKind,
      base: d.base,
      head: d.head,
      files: d.files,
      added: d.added,
      removed: d.removed,
      ratio: typeof d.ratio === "number" ? d.ratio : null,
      net: d.net,
      capturedAt: d.capturedAt,
    });
  }
  return out;
}

export interface WindowedRoundDiffStats {
  windowDays: number;
  /** Quantas rodadas caem dentro da janela. */
  rounds: number;
  added: number;
  removed: number;
  ratio: number | null;
  net: number;
  /** Líquido de linhas por dia (net / windowDays) — 0 se a janela está vazia. */
  netPerDay: number;
}

/**
 * Agrega os records cujo `capturedAt` cai dentro dos últimos `windowDays`
 * dias a partir de `now`. Pura — janela e "agora" são sempre parâmetros
 * explícitos, nunca `Date.now()` implícito (testável com dado sintético).
 */
export function computeWindowedRoundDiffStats(
  records: readonly RoundDiffStatsRecord[],
  windowDays: number,
  now: Date = new Date(),
): WindowedRoundDiffStats {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = records.filter((r) => {
    const t = Date.parse(r.capturedAt);
    return Number.isFinite(t) && t >= cutoff && t <= now.getTime();
  });
  const added = inWindow.reduce((sum, r) => sum + r.added, 0);
  const removed = inWindow.reduce((sum, r) => sum + r.removed, 0);
  const net = diffNet(added, removed);
  return {
    windowDays,
    rounds: inWindow.length,
    added,
    removed,
    ratio: diffRatio(added, removed),
    net,
    netPerDay: windowDays > 0 ? net / windowDays : 0,
  };
}

/** As 3 janelas citadas no corpo da #7113 (7d/30d/90d). */
export const ROUND_DIFF_STATS_WINDOWS_DAYS = [7, 30, 90] as const;

export function computeAllRoundDiffStatsWindows(
  records: readonly RoundDiffStatsRecord[],
  now: Date = new Date(),
): WindowedRoundDiffStats[] {
  return ROUND_DIFF_STATS_WINDOWS_DAYS.map((d) => computeWindowedRoundDiffStats(records, d, now));
}

/**
 * Limiar proposto pela #7113 pra alarmar sobre a razão de 7 dias. Constante
 * isolada (não hardcoded no evaluator) pra facilitar recalibração — mesmo
 * espírito de `EFFORT_DIFF_LINE_THRESHOLD` em `pr-create-review.mjs`: um
 * valor que pode precisar mudar depois que a série acumular histórico
 * suficiente pra calibrar (a própria issue reconhece isso: "Instrumentar
 * antes de legislar é deliberado").
 */
export const ROUND_DIFF_RATIO_ALARM_THRESHOLD = 10;

export interface RoundDiffAlarmEvaluation {
  alarming: boolean;
  window: WindowedRoundDiffStats;
}

/**
 * Pura — decide se a janela de 7 dias cruzou o limiar. Sem remoções
 * (`ratio === null`) com adições > 0 conta como acima do limiar (pior caso,
 * não "indefinido = ok"); janela vazia (`rounds === 0`) nunca alarma — não
 * há dado, não é razão de disparar.
 */
export function evaluateRoundDiffAlarm(
  window7d: WindowedRoundDiffStats,
  threshold: number = ROUND_DIFF_RATIO_ALARM_THRESHOLD,
): RoundDiffAlarmEvaluation {
  if (window7d.rounds === 0) return { alarming: false, window: window7d };
  if (window7d.ratio === null) {
    return { alarming: window7d.added > 0, window: window7d };
  }
  return { alarming: window7d.ratio >= threshold, window: window7d };
}

/**
 * Monta a tabela markdown `janela | rodadas | adições | remoções | razão |
 * líquido/dia` pro relatório de fim de rodada — mesmo formato da tabela que
 * o corpo da #7113 já usou pra apresentar a medição manual inicial, agora
 * gerada a partir da série persistida.
 */
export function formatRoundDiffStatsReport(windows: readonly WindowedRoundDiffStats[]): string {
  const header = "| janela | rodadas | adições | remoções | razão | líquido/dia |\n|---|---|---|---|---|---|";
  const rows = windows.map((w) => {
    const label = `${w.windowDays}d`;
    const ratioLabel = formatRatio(w.ratio, w.added);
    const netPerDayLabel = Math.round(w.netPerDay).toLocaleString("pt-BR");
    return `| ${label} | ${w.rounds} | ${w.added.toLocaleString("pt-BR")} | ${w.removed.toLocaleString("pt-BR")} | ${ratioLabel} | ${netPerDayLabel} |`;
  });
  return [header, ...rows].join("\n");
}
