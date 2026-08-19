/**
 * scripts/lib/develop-target-set-coverage.ts (#5718)
 *
 * Fecha o buraco do meio entre dois gates existentes no `/diaria-develop`:
 * `check-state-changed-pending.ts` (#5706) pega issue aberta que nunca
 * entrou no plano; `validate-develop-plan-motivo.ts` (#5708) pega issue
 * `pulada` com `motivo` inventado. Nenhum dos dois pega o caso do #5718 —
 * issue que ENTROU em `goal.target_set` (foi triada, faz parte do escopo da
 * sessão) mas nunca recebeu nenhuma tentativa de dispatch, e por isso nunca
 * ganhou uma entrada em `issues[]`. Sem entrada, ela sobrevive só como um
 * número solto em `goal.remaining` — e o relatório final, ao listar
 * `remaining`, misturava esses números com as issues genuinamente `pulada`
 * (tentadas, bloqueadas) na mesma seção "não-destraváveis nesta sessão",
 * afirmação falsa ao editor (achado ao vivo, rodada `260819d`: #5700, #5419,
 * #5692 nunca foram tentadas, mas saíram relatadas como não-destraváveis).
 *
 * O novo status `"nao-tentada"` (ver `DEVELOP_NAO_TENTADA_STATUS`) é o
 * registro honesto: "esta issue fazia parte do alvo da sessão e não foi
 * tocada" — distinto de `pulada` (tentada e descartada por um motivo real,
 * ver `develop-plan-motivo.ts`) e distinto de `pendente` (ainda em
 * progresso, sessão não terminou). `nao-tentada` só é escrito na Fase 2, ao
 * fechar o relatório, como backfill mecânico sobre o que sobrou sem
 * entrada — nunca é um estado que a Fase 1 escolhe ativamente.
 *
 * **Não é status terminal** (não entra na lista de `.claude/skills/diaria-develop/SKILL.md`
 * § "'Nenhuma issue aberta' = estado terminal") — uma issue `nao-tentada`
 * continua contando pra `goal.remaining`/`goal.reached: false`. O que este
 * módulo garante não é que o Goal seja atingido, é que o relatório nunca
 * minta sobre POR QUE ele não foi.
 *
 * Puro (`findMissingTargetSetCoverage`/`checkTargetSetCoverageFromPlan`) +
 * I/O fino (`checkTargetSetCoverage`, lê o plan.json do disco). CLI em
 * `scripts/check-develop-target-set-coverage.ts`.
 *
 * @see scripts/lib/develop-plan-motivo.ts (gate irmão — motivo inválido em vez de cobertura ausente)
 * @see scripts/lib/state-changed-tracker.ts (`extractIssueNumbers`, reusado aqui; gate irmão de convergência)
 * @see scripts/lib/plan-issues-normalize.ts (`plan.issues` array vs dict)
 * @see .claude/skills/diaria-develop/SKILL.md § "'Nenhuma issue aberta' = estado terminal"
 */

import { readFileSync } from "node:fs";
import { normalizeIssues, type IssuesBearing } from "./plan-issues-normalize.ts";
import { extractIssueNumbers } from "./state-changed-tracker.ts";
import type { DevelopPlanIssueLike } from "./develop-plan-motivo.ts";

/**
 * Valor de `status` pra uma issue de `goal.target_set` que termina a sessão
 * sem entrada em `issues[]` — nunca tentada, nunca dispatchada. Distinto de
 * `pulada` (tentativa real que esbarrou num bloqueio) e de `pendente`
 * (sessão ainda em progresso pra essa issue).
 */
export const DEVELOP_NAO_TENTADA_STATUS = "nao-tentada" as const;

export interface PlanWithTargetSet {
  goal?: {
    target_set?: unknown;
    [key: string]: unknown;
  };
  issues?: unknown;
  [key: string]: unknown;
}

export type TargetSetCoverageResult =
  | { status: "ok" }
  | { status: "missing"; issues: number[] };

/**
 * Pure: entre os números de `targetSet`, devolve os que não têm entrada
 * correspondente em `issues` — "entrada" exige `number` numérico E `status`
 * string não-vazia (uma entrada `{ number: 5700 }` sem `status` é o mesmo
 * problema, silenciosamente pior: existe no array mas ainda não foi
 * classificada). Saída ordenada, deduplicada, nunca lança.
 */
export function findMissingTargetSetCoverage(
  targetSet: number[],
  issues: DevelopPlanIssueLike[],
): number[] {
  const covered = new Set<number>();
  for (const issue of issues) {
    const hasNumber = typeof issue?.number === "number" && Number.isFinite(issue.number);
    const hasStatus = typeof issue?.status === "string" && issue.status.length > 0;
    if (hasNumber && hasStatus) covered.add(issue.number as number);
  }
  const missing = targetSet.filter((n) => !covered.has(n));
  return [...new Set(missing)].sort((a, b) => a - b);
}

/** Pure: veredito a partir do plano já parseado. `target_set` ausente/vazio
 * (política `table_only`, ou Fase 0.5 ainda não gravou) → `ok` — nada pra
 * cobrir ainda, mesmo fail-open documentado nos gates irmãos. */
export function checkTargetSetCoverageFromPlan(plan: PlanWithTargetSet): TargetSetCoverageResult {
  const targetSet = extractIssueNumbers(plan.goal?.target_set);
  if (targetSet.length === 0) return { status: "ok" };
  const issues = normalizeIssues<DevelopPlanIssueLike>(
    plan as IssuesBearing<DevelopPlanIssueLike>,
  );
  const missing = findMissingTargetSetCoverage(targetSet, issues);
  if (missing.length === 0) return { status: "ok" };
  return { status: "missing", issues: missing };
}

/** I/O: lê o plan.json do disco e devolve o veredito. */
export function checkTargetSetCoverage(planPath: string): TargetSetCoverageResult {
  const raw = readFileSync(planPath, "utf8");
  const plan = JSON.parse(raw) as PlanWithTargetSet;
  return checkTargetSetCoverageFromPlan(plan);
}
