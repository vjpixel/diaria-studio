/**
 * scripts/lib/overnight-waves-report.ts (#8496)
 *
 * Leitor de `plan.waves[]` (#8486/#8492) — o que faltava pra a decisão A/B
 * do teto 3→6 (#8486) parar de depender de alguém fazer a conta à mão.
 * Puro (sem I/O — CLI de scan de disco vive em `scripts/report-overnight-waves.ts`).
 *
 * Responde as 3 perguntas que a issue #8496 e o SKILL.md já sabem que
 * importam:
 * - **Distribuição de `unit_count`**: quantas ondas tiveram 1, 2, 3... unidades.
 * - **Fração de ondas com `cap_hit`**: `cap_hit` quase sempre `false` significa
 *   que a fila nunca tinha unidades independentes suficientes pra o teto ser
 *   de fato o limite.
 * - **`pr→merge` p90 segmentado por `cap_hit`**: se subir muito acima de
 *   ~30min (ou o volume de `draft-ci-vermelho` subir) nas ondas com
 *   `cap_hit: true`, é sinal de que o teto 6 está sobrecarregando o
 *   coordenador/CI e vale reverter pra 3.
 *
 * `pr→merge` de uma UNIDADE (não de uma issue isolada) é definido como o
 * intervalo entre o `pr_opened` MAIS CEDO e o `merged` MAIS TARDE entre as
 * issues da unidade — mesma convenção de "representante do lote" que
 * `render-overnight-timeline.ts` usa (uma unidade em lote compartilha 1 PR).
 * Unidade sem `pr_opened`+`merged` completos em NENHUMA issue (pulada, CI
 * vermelho persistente, ainda em voo) não entra no p90 — só unidades
 * efetivamente mergeadas respondem "quanto tempo levou".
 */

import type { OvernightWaveRecord } from "./overnight-waves.ts";
import type { PlanIssue } from "../render-overnight-timeline.ts";

export interface WaveUnitDuration {
  issues: number[];
  cap_hit: boolean;
  /** ms entre o pr_opened mais cedo e o merged mais tarde da unidade; null se incompleto. */
  duration_ms: number | null;
}

/** Pure: índice `número da issue -> PlanIssue`, ignorando issues sem `number` válido. */
function indexIssuesByNumber(issues: PlanIssue[]): Map<number, PlanIssue> {
  const map = new Map<number, PlanIssue>();
  for (const issue of issues) {
    if (Number.isInteger(issue.number)) map.set(issue.number, issue);
  }
  return map;
}

function parseISO(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * Pure: computa a duração pr→merge de cada UNIDADE de cada onda, cruzando
 * `waves[].units[].issues` com o `timeline` de cada issue em `issues`
 * (já normalizado — ver `normalizeIssues` de `plan-issues-normalize.ts`).
 */
export function computeWaveUnitDurations(
  waves: OvernightWaveRecord[],
  issues: PlanIssue[],
): WaveUnitDuration[] {
  const byNumber = indexIssuesByNumber(issues);
  const out: WaveUnitDuration[] = [];
  for (const wave of waves) {
    for (const unit of wave.units) {
      let earliestOpen: number | null = null;
      let latestMerged: number | null = null;
      for (const num of unit.issues) {
        const tl = byNumber.get(num)?.timeline;
        const open = parseISO(tl?.pr_opened);
        const merged = parseISO(tl?.merged);
        if (open !== null && (earliestOpen === null || open < earliestOpen)) earliestOpen = open;
        if (merged !== null && (latestMerged === null || merged > latestMerged)) latestMerged = merged;
      }
      const duration_ms =
        earliestOpen !== null && latestMerged !== null && latestMerged >= earliestOpen
          ? latestMerged - earliestOpen
          : null;
      out.push({ issues: unit.issues, cap_hit: wave.cap_hit, duration_ms });
    }
  }
  return out;
}

/** Pure: percentil (0-100) de uma amostra numérica via interpolação linear (nearest-rank simplificado). Amostra vazia -> null. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export interface WavesAggregateReport {
  rounds_scanned: number;
  waves_total: number;
  /** unit_count -> quantidade de ondas com esse tamanho. */
  unit_count_distribution: Record<number, number>;
  cap_hit_count: number;
  cap_hit_fraction: number;
  /** Unidades com duração conhecida (pr_opened + merged presentes), por grupo cap_hit. */
  pr_to_merge_p90_ms: { cap_hit_true: number | null; cap_hit_false: number | null };
  /** Tamanho de cada amostra usada no p90 (unidades com duração conhecida). */
  pr_to_merge_sample_size: { cap_hit_true: number; cap_hit_false: number };
}

/**
 * Pure: agrega N rondas (cada uma: `waves[]` + `issues[]` já normalizado) numa
 * `WavesAggregateReport`. Rondas sem `waves` (plano legado, pré-#8486) contam
 * pra `rounds_scanned` mas não contribuem nenhuma onda.
 */
export function aggregateWaveRounds(
  rounds: Array<{ waves?: OvernightWaveRecord[]; issues: PlanIssue[] }>,
): WavesAggregateReport {
  const allWaves: OvernightWaveRecord[] = [];
  const allDurations: WaveUnitDuration[] = [];
  for (const round of rounds) {
    const waves = round.waves ?? [];
    allWaves.push(...waves);
    allDurations.push(...computeWaveUnitDurations(waves, round.issues));
  }

  const unit_count_distribution: Record<number, number> = {};
  let cap_hit_count = 0;
  for (const w of allWaves) {
    unit_count_distribution[w.unit_count] = (unit_count_distribution[w.unit_count] ?? 0) + 1;
    if (w.cap_hit) cap_hit_count++;
  }

  const durTrue = allDurations.filter((d) => d.cap_hit && d.duration_ms !== null).map((d) => d.duration_ms as number);
  const durFalse = allDurations.filter((d) => !d.cap_hit && d.duration_ms !== null).map((d) => d.duration_ms as number);

  return {
    rounds_scanned: rounds.length,
    waves_total: allWaves.length,
    unit_count_distribution,
    cap_hit_count,
    cap_hit_fraction: allWaves.length === 0 ? 0 : cap_hit_count / allWaves.length,
    pr_to_merge_p90_ms: {
      cap_hit_true: percentile(durTrue, 90),
      cap_hit_false: percentile(durFalse, 90),
    },
    pr_to_merge_sample_size: {
      cap_hit_true: durTrue.length,
      cap_hit_false: durFalse.length,
    },
  };
}

/** Formata ms em "1h23m"/"45m"/"—" — mesmo estilo de `render-overnight-timeline.ts`. */
export function fmtDurationMs(ms: number | null): string {
  if (ms === null) return "—";
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h${String(m).padStart(2, "0")}m`;
}

/**
 * Renderiza o `WavesAggregateReport` em markdown — usado tanto pelo CLI
 * standalone (`report-overnight-waves.ts`) quanto pela linha de resumo da
 * Fase 2 do overnight (#8496 item 2), que embute a versão de UMA rodada só.
 */
export function renderWavesReportMarkdown(report: WavesAggregateReport): string {
  const lines: string[] = [];
  lines.push(`Rondas: ${report.rounds_scanned} | Ondas: ${report.waves_total}`);
  if (report.waves_total === 0) {
    lines.push("Nenhuma onda registrada (plan.json sem `waves[]` — rodadas anteriores ao #8486, ou nenhuma unidade despachada).");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("| unit_count | ondas |");
  lines.push("| --- | --- |");
  for (const k of Object.keys(report.unit_count_distribution).map(Number).sort((a, b) => a - b)) {
    lines.push(`| ${k} | ${report.unit_count_distribution[k]} |`);
  }
  lines.push("");
  lines.push(
    `cap_hit: ${report.cap_hit_count}/${report.waves_total} (${(report.cap_hit_fraction * 100).toFixed(1)}%)`,
  );
  lines.push("");
  lines.push(
    `pr→merge p90 (cap_hit=true): ${fmtDurationMs(report.pr_to_merge_p90_ms.cap_hit_true)} (n=${report.pr_to_merge_sample_size.cap_hit_true})`,
  );
  lines.push(
    `pr→merge p90 (cap_hit=false): ${fmtDurationMs(report.pr_to_merge_p90_ms.cap_hit_false)} (n=${report.pr_to_merge_sample_size.cap_hit_false})`,
  );
  return lines.join("\n");
}
