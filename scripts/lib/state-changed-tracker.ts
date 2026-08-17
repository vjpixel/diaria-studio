/**
 * state-changed-tracker.ts (#5476)
 *
 * Gate mecânico para o achado da rodada overnight 260816e: uma ação do
 * PRÓPRIO coordenador durante a rodada (aplicar label de classificação —
 * `not-this-week`, `trade-off-real`, `external-blocker`, etc. — ou
 * encerrar/remover uma claim de `session-registry`) muda a elegibilidade de
 * uma issue JÁ CONHECIDA da rodada, sem passar pelo mecanismo de
 * "re-varredura de convergência" da Fase 1 (que só cobre issues NOVAS
 * aparecendo em `gh issue list`).
 *
 * Este módulo dá ao coordenador um jeito determinístico de registrar essas
 * mudanças (`add`) e de resolvê-las depois de reavaliar dispatch (`remove`),
 * mais um checador (`checkStateChangedPending`) que a Fase 2 (compilação do
 * relatório final) roda antes de fechar a rodada: se sobrar pendência, a
 * rodada não deveria escrever o relatório ainda — precisa voltar pra Fase 1
 * e reavaliar aquela(s) issue(s) primeiro.
 *
 * **Não é gate de merge nem bloqueia o processo por si**: o "exit 1" é um
 * sinal pro humano/coordenador que lê a saída do script, não uma trava de
 * infraestrutura — mesma natureza advisory de
 * `scripts/check-overnight-token-instrumentation.ts` (ver esse arquivo como
 * referência de estilo), mas aqui o exit code É NÃO-ZERO quando há
 * pendência, porque a instrução (regra #5476 nos 3 SKILL.md) é "não escreva
 * o relatório final enquanto isso não voltar a exit 0".
 *
 * O array `state_changed_issues` vive dentro do `plan.json` da rodada
 * (`data/overnight/{AAMMDD}/plan.json` ou `data/develop/...`) — arquivo já
 * lido/escrito pelo coordenador ao longo da rodada. Ausência do campo é
 * tratada como `[]` (fail-open, compatível com `plan.json` legado de rodadas
 * anteriores ao #5476).
 *
 * Uso CLI:
 *   npx tsx scripts/lib/state-changed-tracker.ts --plan {path}
 *     → checa; imprime pendências (se houver) e sai 1, ou "ok" e sai 0.
 *   npx tsx scripts/lib/state-changed-tracker.ts --add-pending {N} --plan {path}
 *   npx tsx scripts/lib/state-changed-tracker.ts --remove-pending {N} --plan {path}
 *
 * @see scripts/check-overnight-token-instrumentation.ts (padrão de estilo)
 * @see .claude/skills/diaria-overnight/SKILL.md
 * @see .claude/skills/diaria-develop/SKILL.md
 * @see .claude/skills/diaria-continuo/SKILL.md
 */

import { readFileSync, writeFileSync } from "node:fs";

export interface PlanWithStateChanged {
  state_changed_issues?: unknown;
  [key: string]: unknown;
}

export type StateChangedCheckResult =
  | { status: "ok" }
  | { status: "pending"; issues: number[] };

/**
 * Pure: normaliza o campo `state_changed_issues` de um plan.json já
 * parseado. Ausente/não-array/entries não-numéricas viram `[]` — fail-open,
 * nunca lança.
 */
export function readStateChangedIssues(plan: PlanWithStateChanged): number[] {
  const raw = plan.state_changed_issues;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/**
 * Pure: array com `issueNumber` adicionado, deduplicado (no-op se já
 * presente). Não muta a lista original.
 */
export function addStateChangedIssue(issues: number[], issueNumber: number): number[] {
  if (issues.includes(issueNumber)) return issues;
  return [...issues, issueNumber];
}

/**
 * Pure: array com `issueNumber` removido, idempotente (no-op se ausente).
 * Não muta a lista original.
 */
export function removeStateChangedIssue(issues: number[], issueNumber: number): number[] {
  return issues.filter((n) => n !== issueNumber);
}

/**
 * Pure: veredito de checagem a partir da lista já lida. `pending` lista as
 * issues explicitamente — nunca só "há pendências", pra a mensagem de erro
 * ser acionável.
 */
export function checkStateChangedIssues(issues: number[]): StateChangedCheckResult {
  if (issues.length === 0) return { status: "ok" };
  return { status: "pending", issues: [...issues].sort((a, b) => a - b) };
}

function readPlan(planPath: string): PlanWithStateChanged {
  const raw = readFileSync(planPath, "utf8");
  return JSON.parse(raw) as PlanWithStateChanged;
}

function writePlan(planPath: string, plan: PlanWithStateChanged): void {
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

/** I/O: lê o plan.json, aplica `add`, grava de volta. */
export function addPendingToPlan(planPath: string, issueNumber: number): void {
  const plan = readPlan(planPath);
  const current = readStateChangedIssues(plan);
  plan.state_changed_issues = addStateChangedIssue(current, issueNumber);
  writePlan(planPath, plan);
}

/** I/O: lê o plan.json, aplica `remove`, grava de volta. */
export function removePendingFromPlan(planPath: string, issueNumber: number): void {
  const plan = readPlan(planPath);
  const current = readStateChangedIssues(plan);
  plan.state_changed_issues = removeStateChangedIssue(current, issueNumber);
  writePlan(planPath, plan);
}

/** I/O: lê o plan.json e devolve o veredito de checagem. */
export function checkStateChangedPending(planPath: string): StateChangedCheckResult {
  const plan = readPlan(planPath);
  return checkStateChangedIssues(readStateChangedIssues(plan));
}
