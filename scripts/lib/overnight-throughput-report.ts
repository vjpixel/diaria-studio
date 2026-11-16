/**
 * scripts/lib/overnight-throughput-report.ts (#13271)
 *
 * Leitura de VAZÃO do overnight a partir de `plan.issues[].timeline` e
 * `status`/`motivo` — o agregado que a #13271 montou à mão (57 rondas desde
 * 261023) para mostrar onde o tempo e as issues se perdem. Complementa o
 * `overnight-waves-report.ts` (#8496), que responde só a pergunta do teto
 * (`cap_hit` e `pr→merge` p90 por onda); aqui a pergunta é "quantas issues por
 * hora e onde o ciclo de cada unidade gasta o tempo".
 *
 * Puro (sem I/O). CLI: `scripts/report-overnight-throughput.ts`.
 *
 * Responde, com o mesmo agregado de rodada a rodada (métrica de sucesso da
 * issue):
 * - **Vazão:** issues `mergeada` por rodada e por hora de rodada.
 * - **Trechos do ciclo** (p50/p90/n): dispatch → PR aberta, PR aberta → CI
 *   verde, CI verde → merge, dispatch → merge.
 * - **Onde as issues se perdem:** contagem de `pulada` por `motivo`.
 * - **Cobertura da instrumentação:** das unidades mergeadas, quantas têm cada
 *   marco gravado. Trecho medido sobre poucas unidades (ex.: `ci_green` em 124
 *   de 579) é amostra enviesada, e a cobertura fica à vista no próprio relatório.
 *
 * **Unidade, não issue.** Um lote compartilha 1 PR e as issues dele carregam o
 * mesmo timeline; contar por issue pesaria o lote N vezes. A unidade é a PR
 * (`pr`), senão o `batch`, senão a própria issue — e, dentro dela, o início de
 * um trecho é o marco MAIS CEDO e o fim, o MAIS TARDE (mesma convenção do
 * `overnight-waves-report.ts`). Trecho com fim antes do início (marco gravado
 * fora de ordem) não entra na amostra.
 *
 * **Hora de rodada:** `started_at` do plano até o último marco de timeline da
 * rodada. Rodada sem `started_at` usa o primeiro marco. Rodada sem nenhum marco
 * conta 0 h (não infla a taxa). É uma aproximação: o fim real da rodada (após o
 * relatório) não é gravado no plano.
 */

import { issueKeyOfPlanEntry } from "./issue-key.ts";
import { fmtDurationMs as fmtMs, percentile } from "./overnight-waves-report.ts";
import type { PlanIssue } from "../render-overnight-timeline.ts";

export interface ThroughputRound {
  dir: string;
  started_at?: string;
  issues: PlanIssue[];
}

/** Trechos medidos: [nome, marco de início, marco de fim]. */
export const THROUGHPUT_SEGMENTS = [
  ["dispatch→pr_opened", "dispatch", "pr_opened"],
  ["pr_opened→ci_green", "pr_opened", "ci_green"],
  ["ci_green→merged", "ci_green", "merged"],
  ["dispatch→merged", "dispatch", "merged"],
  ["pr_opened→review_done", "pr_opened", "review_done"],
  ["review_done→gate2", "review_done", "gate2"],
  ["ci_green→gate2", "ci_green", "gate2"],
  ["gate2→merged", "gate2", "merged"],
] as const;

export type ThroughputSegmentName = (typeof THROUGHPUT_SEGMENTS)[number][0];

/** Marcos cuja cobertura o relatório mostra (alavanca 4 da #13271). */
export const TIMELINE_MILESTONES = ["dispatch", "pr_opened", "ci_green", "review_done", "gate2", "merged"] as const;

export interface SegmentStats {
  p50_ms: number | null;
  p90_ms: number | null;
  n: number;
}

export interface ThroughputReport {
  rounds_scanned: number;
  /** Soma das horas de rodada (ver docstring do módulo). */
  round_hours: number;
  merged_issues: number;
  merged_per_round: number | null;
  merged_per_hour: number | null;
  segments: Record<ThroughputSegmentName, SegmentStats>;
  /** `motivo` -> issues `pulada`, ordem decrescente na renderização. Sem motivo = "(sem motivo)". */
  pulada_by_motivo: Record<string, number>;
  pulada_total: number;
  /** Unidades com `merged` gravado no timeline, base da cobertura. */
  merged_units: number;
  /** Marco -> unidades mergeadas que têm esse marco gravado. */
  milestone_coverage: Record<(typeof TIMELINE_MILESTONES)[number], number>;
}

function parseISO(s: unknown): number | null {
  if (typeof s !== "string" || s === "") return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Pure: chave da unidade — PR, senão batch, senão a issue (ver docstring). */
export function unitKeyOf(issue: PlanIssue, roundDir: string): string {
  const pr = Number(String(issue.pr ?? "").replace(/^#/, ""));
  if (Number.isInteger(pr) && pr > 0) return `${roundDir}|pr:${pr}`;
  if (typeof issue.batch === "string" && issue.batch !== "") return `${roundDir}|batch:${issue.batch}`;
  return `${roundDir}|issue:${issueKeyOfPlanEntry(issue) ?? issue.number}`;
}

interface UnitMarks {
  earliest: Map<string, number>;
  latest: Map<string, number>;
}

/** Pure: agrupa as issues de uma rodada em unidades com o marco mais cedo e o mais tarde de cada evento. */
export function collectUnitMarks(round: ThroughputRound): Map<string, UnitMarks> {
  const units = new Map<string, UnitMarks>();
  for (const issue of round.issues) {
    const tl = issue.timeline;
    if (!tl || typeof tl !== "object") continue;
    const key = unitKeyOf(issue, round.dir);
    let marks = units.get(key);
    if (!marks) {
      marks = { earliest: new Map(), latest: new Map() };
      units.set(key, marks);
    }
    for (const [event, value] of Object.entries(tl)) {
      const t = parseISO(value);
      if (t === null) continue;
      const e = marks.earliest.get(event);
      if (e === undefined || t < e) marks.earliest.set(event, t);
      const l = marks.latest.get(event);
      if (l === undefined || t > l) marks.latest.set(event, t);
    }
  }
  return units;
}

/** Pure: horas de rodada (ver docstring do módulo). */
export function roundHours(round: ThroughputRound): number {
  let first: number | null = null;
  let last: number | null = null;
  for (const issue of round.issues) {
    for (const value of Object.values(issue.timeline ?? {})) {
      const t = parseISO(value);
      if (t === null) continue;
      if (first === null || t < first) first = t;
      if (last === null || t > last) last = t;
    }
  }
  if (last === null) return 0;
  const start = parseISO(round.started_at) ?? first;
  if (start === null || last <= start) return 0;
  return (last - start) / 3_600_000;
}

/** Pure: agrega N rodadas num `ThroughputReport`. */
export function aggregateThroughput(rounds: ThroughputRound[]): ThroughputReport {
  const samples = Object.fromEntries(THROUGHPUT_SEGMENTS.map(([name]) => [name, [] as number[]])) as Record<
    ThroughputSegmentName,
    number[]
  >;
  const pulada_by_motivo: Record<string, number> = {};
  const milestone_coverage = Object.fromEntries(TIMELINE_MILESTONES.map((m) => [m, 0])) as ThroughputReport["milestone_coverage"];
  let round_hours = 0;
  let merged_issues = 0;
  let pulada_total = 0;
  let merged_units = 0;

  for (const round of rounds) {
    round_hours += roundHours(round);
    for (const issue of round.issues) {
      if (issue.status === "mergeada") merged_issues++;
      if (issue.status === "pulada") {
        pulada_total++;
        const motivo = typeof issue.motivo === "string" && issue.motivo.trim() !== "" ? issue.motivo.trim() : "(sem motivo)";
        pulada_by_motivo[motivo] = (pulada_by_motivo[motivo] ?? 0) + 1;
      }
    }
    for (const marks of collectUnitMarks(round).values()) {
      for (const [name, from, to] of THROUGHPUT_SEGMENTS) {
        const start = marks.earliest.get(from);
        const end = marks.latest.get(to);
        if (start !== undefined && end !== undefined && end >= start) samples[name].push(end - start);
      }
      if (marks.latest.has("merged")) {
        merged_units++;
        for (const m of TIMELINE_MILESTONES) if (marks.latest.has(m)) milestone_coverage[m]++;
      }
    }
  }

  const segments = Object.fromEntries(
    THROUGHPUT_SEGMENTS.map(([name]) => [
      name,
      { p50_ms: percentile(samples[name], 50), p90_ms: percentile(samples[name], 90), n: samples[name].length },
    ]),
  ) as Record<ThroughputSegmentName, SegmentStats>;

  return {
    rounds_scanned: rounds.length,
    round_hours,
    merged_issues,
    merged_per_round: rounds.length === 0 ? null : merged_issues / rounds.length,
    merged_per_hour: round_hours > 0 ? merged_issues / round_hours : null,
    segments,
    pulada_by_motivo,
    pulada_total,
    merged_units,
    milestone_coverage,
  };
}

function fmtRate(v: number | null): string {
  return v === null ? "—" : v.toFixed(1).replace(".", ",");
}

/** Renderiza o relatório em markdown (`top` = quantos motivos de `pulada` listar). */
export function renderThroughputMarkdown(report: ThroughputReport, top = 10): string {
  const lines: string[] = [];
  lines.push(`Rondas: ${report.rounds_scanned} | Horas de rodada: ${fmtRate(report.round_hours)}`);
  lines.push(
    `Mergeadas: ${report.merged_issues} | por rodada: ${fmtRate(report.merged_per_round)} | por hora: ${fmtRate(report.merged_per_hour)}`,
  );
  lines.push("");
  lines.push("| Trecho | p50 | p90 | n |");
  lines.push("| --- | --- | --- | --- |");
  for (const [name] of THROUGHPUT_SEGMENTS) {
    const s = report.segments[name];
    lines.push(`| ${name} | ${fmtMs(s.p50_ms)} | ${fmtMs(s.p90_ms)} | ${s.n} |`);
  }
  lines.push("");
  const cov = TIMELINE_MILESTONES.map((m) => `${m} ${report.milestone_coverage[m]}`).join(", ");
  lines.push(`Cobertura do timeline (de ${report.merged_units} unidades com merged): ${cov}`);
  lines.push("");
  lines.push(`Puladas: ${report.pulada_total}`);
  const motivos = Object.entries(report.pulada_by_motivo).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (motivos.length > 0) {
    lines.push("");
    lines.push("| Motivo | Issues |");
    lines.push("| --- | --- |");
    for (const [motivo, n] of motivos.slice(0, top)) lines.push(`| ${motivo} | ${n} |`);
    if (motivos.length > top) {
      const rest = motivos.slice(top).reduce((acc, [, n]) => acc + n, 0);
      lines.push(`| (outros ${motivos.length - top} motivos) | ${rest} |`);
    }
  }
  return lines.join("\n");
}
