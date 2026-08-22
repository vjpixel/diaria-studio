/**
 * scripts/lib/develop-exec-track-coverage.ts (#5907 item 1/a)
 *
 * Fecha o gap (a) do #5907 — a causa-raiz de maior peso da rodada 260821c:
 * o passo 6a da Fase 0 (rodar `classifyExecTrack` por issue e gravar
 * `exec_track_painel` no `plan.json`) estourou timeout, foi pra background e
 * **nada obrigava a rodar** — a sessão seguiu de nota de memória, as issues
 * novas que entraram por convergência foram classificadas errado em prosa, e
 * o buraco só foi pego por sorte (o `/diaria-continuo` pegou #5891/#5125 no
 * wake seguinte). `validate-develop-plan-motivo.ts` (#5914, gap b) consome o
 * campo QUANDO gravado — mas nenhum gate conferia que ele foi gravado pra
 * TODA entrada de `issues[]`. Sem este gate, o passo 6a continua pulável:
 * a ausência do campo é invisível pra todos os gates existentes.
 *
 * O que este gate falha:
 * - `exec_track_painel` ausente ou não-string em qualquer entrada de
 *   `issues[]` com `number` numérico (o caso do 6a que nunca rodou);
 * - valor string FORA do enum de 5 tracks (`ExecTrack`, `issue-exec-track.ts`)
 *   — typo grava classificação que nenhum consumidor reconhece, que é a
 *   mesma mentira estrutural de um rótulo inventado.
 *
 * Remediation determinística: pra cada número listado, rodar
 * `classifyExecTrack` (`scripts/lib/issue-exec-track.ts`) e gravar o valor —
 * backfill mecânico, sem julgamento (o módulo é puro; ler labels/corpo é
 * I/O, mas o veredito por issue não tem discricionariedade).
 *
 * Fail-open documentado, mesmo padrão dos gates irmãos: `issues[]` vazio →
 * `ok` (o gate de cobertura do `target_set` #5718 já cobre sessão que não
 * registrou entrada nenhuma; aqui não há o que conferir).
 *
 * Pure (`findMissingExecTrack`/`checkExecTrackCoverageFromPlan`) + I/O fino
 * (`checkExecTrackCoverage`, lê o plan.json do disco). CLI em
 * `scripts/check-develop-exec-track-coverage.ts`.
 *
 * @see scripts/lib/issue-exec-track.ts (fonte do enum `ExecTrack`)
 * @see scripts/lib/develop-plan-motivo.ts (`findHeliosBuraco`, consumidor do campo — gap b)
 * @see scripts/lib/develop-target-set-coverage.ts (gate irmão — mesma forma)
 * @see .claude/skills/diaria-develop/SKILL.md Fase 2 (onde o CLI roda)
 */

import { readFileSync } from "node:fs";
import { normalizeIssues, type IssuesBearing } from "./plan-issues-normalize.ts";
import type { DevelopPlanIssueLike } from "./develop-plan-motivo.ts";
import type { ExecTrack } from "./issue-exec-track.ts";

/** Os únicos valores válidos de `exec_track_painel` — espelho do enum
 * `ExecTrack` de `issue-exec-track.ts` (reexportado como literal pra este
 * módulo não depender de I/O nem arrastar o classify pro bundle do gate). */
export const EXEC_TRACK_VALUES: readonly ExecTrack[] = [
  "overnight",
  "develop",
  "agendada",
  "bloqueada",
  "fora-de-rodada",
];

export interface PlanWithIssues {
  issues?: unknown;
  [key: string]: unknown;
}

export type ExecTrackCoverageResult =
  | { status: "ok" }
  | { status: "missing"; numbers: number[] }
  | { status: "invalid"; entries: Array<{ number: number; value: string }> };

/**
 * Pure: separa as entradas de `issues` em cobertas vs. problemáticas.
 *
 * - Entradas sem `number` numérico finito são ignoradas (mesmo contrato dos
 *   gates irmãos — lixo de shape não é alvo deste gate).
 * - `exec_track_painel` ausente/não-string/vazio → lista `missing`
 *   (números ordenados, deduplicados).
 * - String fora do enum → lista `invalid` (ordenada por número).
 *
 * Uma entrada só entra numa das listas (missing tem precedência — se o campo
 * não é string, não há valor a validar). Nunca lança.
 */
export function findMissingExecTrack(issues: DevelopPlanIssueLike[]): {
  missing: number[];
  invalid: Array<{ number: number; value: string }>;
} {
  const valid = new Set<string>(EXEC_TRACK_VALUES);
  const missing = new Set<number>();
  const invalid: Array<{ number: number; value: string }> = [];
  for (const issue of issues) {
    if (typeof issue?.number !== "number" || !Number.isFinite(issue.number)) continue;
    const raw = issue.exec_track_painel;
    if (typeof raw !== "string" || raw.length === 0) {
      missing.add(issue.number);
      continue;
    }
    if (!valid.has(raw)) {
      invalid.push({ number: issue.number, value: raw });
    }
  }
  return {
    missing: [...missing].sort((a, b) => a - b),
    invalid: invalid.sort((a, b) => a.number - b.number),
  };
}

/** Pure: veredito a partir do plano já parseado. */
export function checkExecTrackCoverageFromPlan(plan: PlanWithIssues): ExecTrackCoverageResult {
  const issues = normalizeIssues<DevelopPlanIssueLike>(
    plan as IssuesBearing<DevelopPlanIssueLike>,
  );
  const { missing, invalid } = findMissingExecTrack(issues);
  if (missing.length > 0) return { status: "missing", numbers: missing };
  if (invalid.length > 0) return { status: "invalid", entries: invalid };
  return { status: "ok" };
}

/** I/O: lê o plan.json do disco e devolve o veredito. */
export function checkExecTrackCoverage(planPath: string): ExecTrackCoverageResult {
  const raw = readFileSync(planPath, "utf8");
  const plan = JSON.parse(raw) as PlanWithIssues;
  return checkExecTrackCoverageFromPlan(plan);
}
