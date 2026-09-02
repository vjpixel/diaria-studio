#!/usr/bin/env npx tsx
/**
 * measure-merge-train-ci-runs.ts (#6300 — último critério de aceite:
 * "medição antes/depois: runs de CI por issue mergeada")
 *
 * Lê os eventos `merge_train_ci_runs` que `scripts/run-merge-train.ts`
 * emite (via `logEvent`, `scripts/lib/run-log.ts`) a cada invocação real do
 * trem, e agrega um "antes/depois" — quantos runs de CI o mecanismo do
 * trem de fato consumiu (`ci_runs_used`) contra quantos teriam sido
 * consumidos no caminho de hoje pros MESMOS PRs (`ci_runs_without_train`,
 * 1 run por PR — o que cada um já gastou pra chegar em Gate 2 verde).
 *
 * **Por que não reconstruir via `gh api actions/runs` histórico** (o
 * método que o comentário "Critério de aceite 2" da issue usou pra medir
 * "taxa de CI-verde-de-primeira"): a branch de integração de cada lote do
 * trem é descartável e removida ao final (`cleanupIntegrationBranch`,
 * `scripts/lib/merge-train-live.ts`) — não sobra PR nem branch pra
 * reconsultar depois. O evento gravado NO MOMENTO em que o trem processa
 * cada lote é a única fonte confiável; ver `summarizeTrainCiRuns`
 * (`scripts/lib/merge-train.ts`) pro racional completo de cada campo.
 *
 * Uso:
 *   npx tsx scripts/measure-merge-train-ci-runs.ts
 *   npx tsx scripts/measure-merge-train-ci-runs.ts --since 260901
 *   npx tsx scripts/measure-merge-train-ci-runs.ts --kind overnight
 *   npx tsx scripts/measure-merge-train-ci-runs.ts --json
 *
 * `--since {AAMMDD}`: só eventos cujo `timestamp` (convertido pra AAMMDD,
 * UTC) é >= o valor dado. `--kind {overnight|develop|continuo}`: só eventos
 * desse `agent`. Sem eventos (0 lotes ≥2 processados ainda pelo trem em
 * produção) não é erro — reporta explicitamente "instrumentação pronta,
 * sem uso real acumulado ainda" em vez de uma tabela vazia/zerada
 * ambígua (mesmo princípio de #6634: ausência de evento não é "0 gasto").
 */

import { existsSync, readFileSync } from "node:fs";
import { resolveRunLogPath } from "./lib/run-log.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

interface MergeTrainCiRunsEvent {
  timestamp?: string;
  agent?: string;
  message?: string;
  details?: {
    ci_runs_used?: number;
    ci_runs_without_train?: number;
    issues_involved_in_batches?: number;
    solo_prs?: number;
    batches?: number;
  };
}

export interface MergeTrainCiRunsSummary {
  /** Nº de invocações de `run-merge-train.ts` que emitiram o evento (independente de terem formado lote ≥2 ou não). */
  eventCount: number;
  /** Nº de invocações que de fato processaram ≥1 lote de tamanho ≥2 (ciRunsUsed > 0 no evento). */
  invocationsWithBatches: number;
  /** Soma de `ci_runs_used` — "depois" (com o trem). */
  ciRunsUsed: number;
  /** Soma de `ci_runs_without_train` — "antes" (sem o trem, 1 run por PR envolvido). */
  ciRunsWithoutTrain: number;
  /** Soma de `issues_involved_in_batches` — denominador de "por issue". */
  issuesInvolvedInBatches: number;
  /** Soma de `solo_prs` — PRs que nunca chegaram a formar lote (contexto, não afeta o antes/depois). */
  soloPrs: number;
}

function timestampToAammdd(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Pure: agrega linhas cruas de `run-log.jsonl` já filtradas por
 * `message === "merge_train_ci_runs"`. Linhas malformadas ou de outro
 * `message`/`agent` (quando `kind` for passado) são ignoradas
 * silenciosamente — mesmo padrão de `sumContinuoTokenEstimates`.
 */
export function summarizeMergeTrainCiRunsEvents(
  lines: readonly string[],
  opts: { since?: string | null; kind?: string | null } = {},
): MergeTrainCiRunsSummary {
  let eventCount = 0;
  let invocationsWithBatches = 0;
  let ciRunsUsed = 0;
  let ciRunsWithoutTrain = 0;
  let issuesInvolvedInBatches = 0;
  let soloPrs = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: MergeTrainCiRunsEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.message !== "merge_train_ci_runs") continue;
    if (opts.kind && event.agent !== opts.kind) continue;
    if (opts.since) {
      const day = timestampToAammdd(event.timestamp);
      if (day === null || day < opts.since) continue;
    }

    eventCount++;
    const d = event.details ?? {};
    const used = typeof d.ci_runs_used === "number" ? d.ci_runs_used : 0;
    const without = typeof d.ci_runs_without_train === "number" ? d.ci_runs_without_train : 0;
    ciRunsUsed += used;
    ciRunsWithoutTrain += without;
    issuesInvolvedInBatches += typeof d.issues_involved_in_batches === "number" ? d.issues_involved_in_batches : 0;
    soloPrs += typeof d.solo_prs === "number" ? d.solo_prs : 0;
    if (used > 0) invocationsWithBatches++;
  }

  return { eventCount, invocationsWithBatches, ciRunsUsed, ciRunsWithoutTrain, issuesInvolvedInBatches, soloPrs };
}

export function measureMergeTrainCiRuns(
  rootDir: string = process.cwd(),
  opts: { since?: string | null; kind?: string | null } = {},
): MergeTrainCiRunsSummary {
  const logPath = resolveRunLogPath(rootDir);
  const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [];
  return summarizeMergeTrainCiRunsEvents(lines, opts);
}

export function formatMergeTrainCiRunsSummary(summary: MergeTrainCiRunsSummary): string {
  if (summary.invocationsWithBatches === 0) {
    return (
      "measure-merge-train-ci-runs: instrumentação pronta (#6300), mas nenhum lote de tamanho >= 2 foi " +
      "processado pelo trem ainda — sem uso real acumulado, não há medição a reportar. " +
      `(${summary.eventCount} invocação(ões) de run-merge-train.ts registrada(s), todas só com PR(s) solo.)`
    );
  }

  const saved = summary.ciRunsWithoutTrain - summary.ciRunsUsed;
  const pctSaved = summary.ciRunsWithoutTrain > 0 ? ((saved / summary.ciRunsWithoutTrain) * 100).toFixed(1) : "0.0";
  const rateBefore =
    summary.issuesInvolvedInBatches > 0 ? (summary.ciRunsWithoutTrain / summary.issuesInvolvedInBatches).toFixed(2) : "n/d";
  const rateAfter =
    summary.issuesInvolvedInBatches > 0 ? (summary.ciRunsUsed / summary.issuesInvolvedInBatches).toFixed(2) : "n/d";

  return [
    `measure-merge-train-ci-runs: ${summary.invocationsWithBatches} invocação(ões) com lote(s) >= 2` +
      ` (de ${summary.eventCount} registrada(s) no total; ${summary.soloPrs} PR(s) só passaram solo, fora do trem).`,
    "",
    "| | Antes (sem trem) | Depois (com trem, medido) |",
    "|---|---:|---:|",
    `| Runs de CI | ${summary.ciRunsWithoutTrain} | ${summary.ciRunsUsed} |`,
    `| Issues cobertas em lote | ${summary.issuesInvolvedInBatches} | ${summary.issuesInvolvedInBatches} |`,
    `| Runs de CI / issue | ${rateBefore} | ${rateAfter} |`,
    "",
    `Economia: ${saved} run(s) de CI (${pctSaved}%).`,
  ].join("\n");
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const since = values.since ?? null;
  const kind = values.kind ?? null;
  const summary = measureMergeTrainCiRuns(process.cwd(), { since, kind });
  if (flags.has("json")) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write(formatMergeTrainCiRunsSummary(summary) + "\n");
  }
}
