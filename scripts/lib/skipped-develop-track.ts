/**
 * #9463 — issue `pulada` por `requer-sessao-local` ou `guard-de-execucao`
 * (guard de arquivo sensível, etc.) precisa estar roteada pra trilha Develop
 * (label `develop-track` ou `windows`), senão `classifyExecTrack` continua
 * a mostrando como Overnight e a rodada seguinte a pega de novo.
 */
import { classifyExecTrack } from "./issue-exec-track.ts";
import { normalizeIssues, type IssuesBearing } from "./plan-issues-normalize.ts";

export interface SkippedPlanIssue {
  number?: number;
  status?: unknown;
  motivo?: unknown;
  [key: string]: unknown;
}

/** Motivos (prefixo, antes de `:`) que exigem roteamento pra Develop. */
export const DEVELOP_ROUTED_MOTIVOS = ["requer-sessao-local", "guard-de-execucao"] as const;

export function requiresDevelopRouting(issue: SkippedPlanIssue): boolean {
  if (issue?.status !== "pulada" || typeof issue.motivo !== "string") return false;
  const head = issue.motivo.split(":")[0].trim();
  return (DEVELOP_ROUTED_MOTIVOS as readonly string[]).includes(head);
}

export interface IssueSnapshot {
  labels: string[];
  body: string;
}

/** Pure: devolve os números de issues puladas por guard/sessão-local cujo
 * track classificado não é `develop`. Issue sem snapshot é ignorada (fail-soft). */
export function findUnroutedSkips(
  issues: SkippedPlanIssue[],
  snapshots: ReadonlyMap<number, IssueSnapshot>,
): number[] {
  const out: number[] = [];
  for (const issue of issues) {
    if (!requiresDevelopRouting(issue) || typeof issue.number !== "number") continue;
    const snap = snapshots.get(issue.number);
    if (!snap) continue;
    const track = classifyExecTrack({ labels: snap.labels, body: snap.body });
    if (track !== "develop") out.push(issue.number);
  }
  return out.sort((a, b) => a - b);
}

export function planIssuesRequiringRouting(plan: IssuesBearing<SkippedPlanIssue>): number[] {
  return normalizeIssues(plan)
    .filter(requiresDevelopRouting)
    .map((i) => i.number as number)
    .filter((n) => Number.isInteger(n));
}
