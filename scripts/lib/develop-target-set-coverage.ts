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
 * **#10618 (fatia 2):** a cobertura é por identidade canônica `owner/repo#N`
 * (`extractIssueKeys` + `planEntryKey`), não mais por número — uma entrada do
 * diaria-design nunca cobre o mesmo número do studio. A saída mantém o shape
 * legado (`issues: number[]` = faltantes do studio) e ganha `foreign`
 * (faltantes de outro repo) e `unreadable` (alvo ilegível) só quando há.
 *
 * @see scripts/lib/state-changed-tracker.ts (`extractIssueKeys`, reusado aqui; gate irmão de convergência)
 * @see scripts/lib/plan-issues-normalize.ts (`plan.issues` array vs dict)
 * @see .claude/skills/diaria-develop/SKILL.md § "'Nenhuma issue aberta' = estado terminal"
 */

import { readFileSync } from "node:fs";
import { normalizeIssues, type IssuesBearing } from "./plan-issues-normalize.ts";
import { extractIssueKeys } from "./state-changed-tracker.ts";
import { planEntryKey, studioNumberOfPlanEntry } from "./plan-issue-ref.ts";
import { legacyIssueNumber, parseIssueRef } from "./issue-repos.ts";
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
  | {
      status: "missing";
      /** Faltantes do repo default (número legado). */
      issues: number[];
      /** #10618 — faltantes de OUTRO repo, como `owner/repo#N`. Presente só
       * quando há algum (shape legado intacto para planos só do studio). */
      foreign?: string[];
      /** #10618 — entradas de `goal.target_set` cuja identidade não dá pra
       * ler (em JSON). Nunca viram `ok` por omissão: um alvo ilegível não é
       * um alvo coberto. Presente só quando há. */
      unreadable?: string[];
    };

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
    // #10618: entrada de OUTRO repo (`{ ref }`/`{ number, repo }`) nunca cobre
    // o número do diaria-studio — `studioNumberOfPlanEntry` devolve `null`.
    const n = studioNumberOfPlanEntry(issue);
    const hasStatus = typeof issue?.status === "string" && issue.status.length > 0;
    if (n !== null && hasStatus) covered.add(n);
  }
  const missing = targetSet.filter((n) => !covered.has(n));
  return [...new Set(missing)].sort((a, b) => a - b);
}

/**
 * #10618 (fatia 2) — mesma regra de `findMissingTargetSetCoverage`, sobre a
 * identidade canônica `owner/repo#N` (cobre issue de qualquer repo, sem
 * colisão de número). Saída ordenada e deduplicada.
 */
export function findMissingTargetSetCoverageKeys(
  targetKeys: string[],
  issues: DevelopPlanIssueLike[],
): string[] {
  const covered = new Set<string>();
  for (const issue of issues) {
    const key = planEntryKey(issue);
    const hasStatus = typeof issue?.status === "string" && issue.status.length > 0;
    if (key && hasStatus) covered.add(key);
  }
  return [...new Set(targetKeys.filter((k) => !covered.has(k)))].sort();
}

/** Pure: veredito a partir do plano já parseado. `target_set` ausente/vazio
 * (política `table_only`, ou Fase 0.5 ainda não gravou) → `ok` — nada pra
 * cobrir ainda, mesmo fail-open documentado nos gates irmãos. */
export function checkTargetSetCoverageFromPlan(plan: PlanWithTargetSet): TargetSetCoverageResult {
  const targetKeys = extractIssueKeys(plan.goal?.target_set);
  // #10618: entrada ilegível de `target_set` (`"lixo"`, `{ number: 3, repo:
  // "x" }`) — `extractIssueKeys` a descarta; aqui ela vira `missing`, nunca
  // some (antes, um `target_set` só de entradas ilegíveis dava `ok`).
  const rawTarget = plan.goal?.target_set;
  const unreadable = Array.isArray(rawTarget)
    ? rawTarget.filter((e) => planEntryKey(e) === null).map((e) => JSON.stringify(e))
    : [];
  if (targetKeys.length === 0 && unreadable.length === 0) return { status: "ok" };
  const issues = normalizeIssues<DevelopPlanIssueLike>(
    plan as IssuesBearing<DevelopPlanIssueLike>,
  );
  const missingKeys = findMissingTargetSetCoverageKeys(targetKeys, issues);
  if (missingKeys.length === 0 && unreadable.length === 0) return { status: "ok" };
  const missing: number[] = [];
  const foreign: string[] = [];
  for (const key of missingKeys) {
    const ref = parseIssueRef(key);
    const n = ref ? legacyIssueNumber(ref) : null;
    if (n !== null) missing.push(n);
    else foreign.push(key);
  }
  missing.sort((a, b) => a - b);
  return {
    status: "missing",
    issues: missing,
    ...(foreign.length > 0 ? { foreign } : {}),
    ...(unreadable.length > 0 ? { unreadable } : {}),
  };
}

/** I/O: lê o plan.json do disco e devolve o veredito. */
export function checkTargetSetCoverage(planPath: string): TargetSetCoverageResult {
  const raw = readFileSync(planPath, "utf8");
  const plan = JSON.parse(raw) as PlanWithTargetSet;
  return checkTargetSetCoverageFromPlan(plan);
}
