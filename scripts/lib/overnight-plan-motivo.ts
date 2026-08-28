/**
 * scripts/lib/overnight-plan-motivo.ts (#6438)
 *
 * Espelha `scripts/lib/develop-plan-motivo.ts` (#5708) — que fecha o
 * vocabulário de `motivo` das issues `status: "pulada"` no plan.json do
 * `/diaria-develop` — mas para o `/diaria-overnight`. Até esta issue, o
 * vocabulário de `motivo` do overnight só existia em PROSA, espalhado pelo
 * passo 4/1 do `.claude/skills/diaria-overnight/SKILL.md` (ex: exemplo de
 * `log-event.ts` no passo 5 da Fase 1: `"motivo": "bloqueio-externo |
 * sem-resposta | ..."`) — sem nenhum guard mecânico equivalente ao
 * `check-develop-exec-track-coverage.ts`/`validate-develop-plan-motivo.ts`
 * que confirme que o texto gravado bate com esse vocabulário.
 *
 * Achado ao vivo (rodada 260827b): 3 motivos apareceram em `plan.json` sem
 * nunca terem sido documentados — `mesmo-tema-sessao-ativa` (#6425/#6427,
 * issue de mesmo tema que sessão `/diaria-develop` ativa, sem claim
 * registrado), `session-finding-deferida` (finding de rodada anterior
 * deferido sem status terminal claro) e `stale-aguarda-reexecucao` (falha
 * antes do fix mergear, #5653/#5615). Nenhum gate os rejeitava nem os
 * roteava — a issue ficava "Overnight sem sinal" pra sempre (mesma classe
 * do #6437: motivo em prosa livre que nenhum consumidor mecânico consegue
 * comparar).
 *
 * Vocabulário fechado agora inclui os motivos legados observados em
 * SKILL.md/logs (`bloqueio-externo`, `sem-resposta`, `requer-sessao-local`,
 * `ambigua`, `not-this-week`, `fora-do-escopo`, `sem-direcao-acionavel`),
 * o motivo já mecânico `claimed-por-outra-sessao` (#5156 passo 2 da Fase 1)
 * e `pr-em-voo`/`bloqueio-execucao` (#6259, motivos transitórios de
 * `block-staleness.ts`), mais os 3 novos fechados por esta issue.
 *
 * Puro (`findInvalidPuladaMotivos`/`checkOvernightPlanMotivosFromIssues`) +
 * I/O fino (`checkOvernightPlanMotivos`, lê o plan.json do disco). CLI em
 * `scripts/check-overnight-plan-motivo.ts`.
 *
 * @see scripts/lib/develop-plan-motivo.ts (irmão do develop, mesmo padrão)
 * @see scripts/lib/overnight-prose-track-map.ts (tradução prosa↔ExecTrack —
 *      os 3 novos motivos entram lá também como `OvernightProseStatus`)
 * @see .claude/skills/diaria-overnight/SKILL.md Fase 1 passo 1/2/5
 * @see scripts/lib/plan-issues-normalize.ts (`plan.issues` array vs dict)
 */

import { readFileSync } from "node:fs";
import { normalizeIssues, type IssuesBearing } from "./plan-issues-normalize.ts";

/**
 * Vocabulário fechado de `motivo` para issues `status: "pulada"` no
 * plan.json do `/diaria-overnight`. Literal, não derivado — cada valor
 * corresponde a uma ação de roteamento documentada (ver
 * `scripts/lib/overnight-prose-track-map.ts` para os 3 novos, #6438).
 */
export const OVERNIGHT_PULADA_MOTIVOS = [
  // legados, já em uso antes do #6438 (SKILL.md passo 1/4, log-event de exemplo)
  "sem-resposta",
  "bloqueio-externo",
  "requer-sessao-local",
  "ambigua",
  "not-this-week",
  "fora-do-escopo",
  "sem-direcao-acionavel",
  "claimed-por-outra-sessao",
  // motivos transitórios de `block-staleness.ts` (#6259) — também podem
  // aparecer como `motivo` de uma entrada `pulada` antes de caducar.
  "pr-em-voo",
  "bloqueio-execucao",
  // novos, fechados pelo #6438 — ver docstring do módulo.
  "mesmo-tema-sessao-ativa",
  "session-finding-deferida",
  "stale-aguarda-reexecucao",
] as const;

export type OvernightPuladaMotivo = (typeof OVERNIGHT_PULADA_MOTIVOS)[number];

const VALID_SET: ReadonlySet<string> = new Set(OVERNIGHT_PULADA_MOTIVOS);

/** Type guard: `motivo` pertence ao vocabulário fechado `OVERNIGHT_PULADA_MOTIVOS`. */
export function isOvernightPuladaMotivo(motivo: string): motivo is OvernightPuladaMotivo {
  return VALID_SET.has(motivo);
}

export interface OvernightPlanIssueLike {
  number?: number;
  status?: unknown;
  motivo?: unknown;
  [key: string]: unknown;
}

export interface InvalidOvernightMotivoEntry {
  number: number;
  /** `null` quando `motivo` está ausente ou não é string — issue `pulada`
   * sem motivo registrado é o mesmo problema, silenciosamente pior. */
  motivo: string | null;
}

/**
 * Pure: varre as issues já normalizadas (array ou dict, via
 * `normalizeIssues`), devolve as `status: "pulada"` cujo `motivo` não bate
 * com `OVERNIGHT_PULADA_MOTIVOS`. Nunca lança.
 */
export function findInvalidPuladaMotivos(
  issues: OvernightPlanIssueLike[],
): InvalidOvernightMotivoEntry[] {
  const out: InvalidOvernightMotivoEntry[] = [];
  for (const issue of issues) {
    if (issue?.status !== "pulada") continue;
    const motivo = typeof issue.motivo === "string" ? issue.motivo : null;
    const number = typeof issue.number === "number" ? issue.number : Number.NaN;
    if (motivo === null || !isOvernightPuladaMotivo(motivo)) {
      out.push({ number, motivo });
    }
  }
  return out;
}

export type OvernightPlanMotivoCheckResult =
  | { status: "ok" }
  | { status: "invalid"; entries: InvalidOvernightMotivoEntry[] };

/** Pure: veredito a partir das issues já normalizadas. */
export function checkOvernightPlanMotivosFromIssues(
  issues: OvernightPlanIssueLike[],
): OvernightPlanMotivoCheckResult {
  const entries = findInvalidPuladaMotivos(issues);
  if (entries.length === 0) return { status: "ok" };
  return { status: "invalid", entries: [...entries].sort((a, b) => a.number - b.number) };
}

/** I/O: lê o plan.json do disco (array ou dict) e devolve o veredito. */
export function checkOvernightPlanMotivos(planPath: string): OvernightPlanMotivoCheckResult {
  const raw = readFileSync(planPath, "utf8");
  const plan = JSON.parse(raw) as IssuesBearing<OvernightPlanIssueLike>;
  const issues = normalizeIssues(plan);
  return checkOvernightPlanMotivosFromIssues(issues);
}
