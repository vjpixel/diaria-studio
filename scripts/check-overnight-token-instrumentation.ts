#!/usr/bin/env npx tsx
/**
 * check-overnight-token-instrumentation.ts (#5009)
 *
 * Checagem DETERMINÍSTICA (não-LLM) de que o coordenador de uma rodada
 * `/diaria-overnight`/`/diaria-develop` de fato emitiu a instrumentação de
 * token mandatada pelo `SKILL.md` (#3453 Rec 1, #4815) — os eventos
 * `subagent_metrics` (fim de cada unidade, Fase 1 passo 5),
 * `coordinator_tokens_estimate` (fim de cada fase, #3453 Rec 1) e
 * `review_metrics` (fim de cada review pós-rodada, Fase 1.5).
 *
 * **Por que existe:** a rodada 260811 terminou com 0 eventos
 * `subagent_metrics`/`coordinator_tokens_estimate` e só 1 `review_metrics` —
 * o coordenador simplesmente esqueceu de rodar os `Bash` calls de
 * `log-event.ts` nos checkpoints previstos. O relatório final escreveu
 * `unavailable` na seção "Custo em tokens" (Fase 2, mandatória desde #4815),
 * que é EXATAMENTE o mesmo texto que apareceria se o harness não expusesse
 * `usage`/token count programaticamente — as duas causas são indistinguíveis
 * pra quem lê o relatório depois. Este script fecha essa ambiguidade: conta
 * os eventos de fato gravados em `data/run-log.jsonl` pra edição/rodada
 * dada e devolve um veredito (`ok`/`warning`) que o coordenador cola
 * verbatim na seção "Custo em tokens" do relatório (Fase 2) — nunca mais
 * silenciosamente "esquecido".
 *
 * **Não é gate.** Roda em foreground na Fase 2 (compilação do relatório),
 * sempre imprime uma seção — não bloqueia merge nem falha a rodada; é
 * puramente informativo (advisory), exit 0 sempre que a leitura do
 * `run-log.jsonl` for bem-sucedida (mesmo com `warning`).
 *
 * Uso:
 *   npx tsx scripts/check-overnight-token-instrumentation.ts --edition 260811
 *   npx tsx scripts/check-overnight-token-instrumentation.ts --run-dir data/overnight/260811
 *
 * `--run-dir` é um atalho: a edição é derivada do basename do path (ex:
 * `data/overnight/260811/` → edição `260811`) — útil quando o coordenador já
 * tem o path da rodada em mãos e não quer repetir o AAMMDD.
 *
 * @see .claude/skills/diaria-overnight/SKILL.md (Fase 2 — "Custo em tokens")
 * @see scripts/log-event.ts (emissor dos 3 tipos de evento checados aqui)
 * @see scripts/lib/run-log.ts (resolveRunLogPath — mesma resolução de path)
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveRunLogPath } from "./lib/run-log.ts";

/** Os 3 tipos de evento mandatados pelo SKILL.md (#3453 Rec 1, #4815). */
export const TRACKED_TOKEN_INSTRUMENTATION_MESSAGES = [
  "subagent_metrics",
  "coordinator_tokens_estimate",
  "review_metrics",
] as const;

export type TrackedTokenInstrumentationMessage = (typeof TRACKED_TOKEN_INSTRUMENTATION_MESSAGES)[number];

export type TokenInstrumentationCounts = Record<TrackedTokenInstrumentationMessage, number>;

export type TokenInstrumentationVerdict =
  | { status: "ok" }
  | { status: "warning"; missing: TrackedTokenInstrumentationMessage[] };

export interface TokenInstrumentationResult {
  edition: string;
  counts: TokenInstrumentationCounts;
  verdict: TokenInstrumentationVerdict;
  /** Texto markdown pronto pra colar na seção "Custo em tokens" do relatório (Fase 2). */
  section: string;
}

function zeroCounts(): TokenInstrumentationCounts {
  return {
    subagent_metrics: 0,
    coordinator_tokens_estimate: 0,
    review_metrics: 0,
  };
}

function isTrackedMessage(msg: unknown): msg is TrackedTokenInstrumentationMessage {
  return (
    typeof msg === "string" &&
    (TRACKED_TOKEN_INSTRUMENTATION_MESSAGES as readonly string[]).includes(msg)
  );
}

/**
 * Pure: conta, por tipo, quantos eventos `run-log.jsonl` (já lido como array
 * de linhas) batem `edition === edition` entre os 3 tipos rastreados. Linhas
 * malformadas (JSON inválido, ou sem os campos esperados) são ignoradas —
 * nunca lança; o objetivo é contar o que É reconhecível, não validar o
 * formato inteiro do log.
 */
export function countTokenInstrumentationEvents(lines: string[], edition: string): TokenInstrumentationCounts {
  const counts = zeroCounts();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    if (rec.edition !== edition) continue;
    if (isTrackedMessage(rec.message)) {
      counts[rec.message] += 1;
    }
  }
  return counts;
}

/**
 * Pure: veredito a partir das contagens. `ok` só quando os 3 tipos têm pelo
 * menos 1 evento; caso contrário `warning` nomeando exatamente os tipos
 * ausentes (nunca "tudo ou nada" — uma rodada pode ter emitido 2 dos 3).
 */
export function resolveTokenInstrumentationVerdict(counts: TokenInstrumentationCounts): TokenInstrumentationVerdict {
  const missing = TRACKED_TOKEN_INSTRUMENTATION_MESSAGES.filter((m) => counts[m] === 0);
  if (missing.length === 0) return { status: "ok" };
  return { status: "warning", missing };
}

/**
 * Pure: seção markdown pronta pra colar na seção "Custo em tokens" do
 * relatório final (Fase 2). Em `warning`, usa a frase explícita mandatada
 * pela issue #5009 — nunca o `unavailable` ambíguo que motivou a issue.
 */
export function buildTokenInstrumentationSection(
  edition: string,
  counts: TokenInstrumentationCounts,
  verdict: TokenInstrumentationVerdict,
): string {
  const countsSummary = TRACKED_TOKEN_INSTRUMENTATION_MESSAGES.map((m) => `${m}: ${counts[m]}`).join(", ");
  if (verdict.status === "ok") {
    return (
      `Instrumentação de token (checagem automática, edição ${edition}): OK — ` +
      `${countsSummary}.`
    );
  }
  const missingList = verdict.missing.join(", ");
  return (
    `Instrumentação de token (checagem automática, edição ${edition}): ` +
    `instrumentação de token não foi emitida nesta rodada (coordenador esqueceu os checkpoints) — ` +
    `tipo(s) ausente(s): ${missingList} (${countsSummary}).`
  );
}

/**
 * Deriva a edição/rodada (`AAMMDD`) a partir dos args CLI: `--edition` tem
 * prioridade; `--run-dir` é um atalho que usa o basename do path (tolera
 * barra final). Retorna `null` se nenhum dos dois foi passado.
 */
export function resolveEditionFromArgs(values: Record<string, string>): string | null {
  if (values.edition) return values.edition;
  if (values["run-dir"]) {
    const cleaned = values["run-dir"].replace(/[\\/]+$/, "");
    const base = basename(cleaned);
    return base || null;
  }
  return null;
}

/**
 * Orquestração fail-soft: `run-log.jsonl` ausente é tratado como "0 eventos"
 * (nunca lança) — uma rodada que nunca gravou nada no log é o caso mais
 * extremo de "instrumentação não emitida", coberto pelo mesmo `warning`.
 */
export function checkOvernightTokenInstrumentation(
  edition: string,
  rootDir: string = process.cwd(),
): TokenInstrumentationResult {
  const logPath = resolveRunLogPath(rootDir);
  const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [];
  const counts = countTokenInstrumentationEvents(lines, edition);
  const verdict = resolveTokenInstrumentationVerdict(counts);
  const section = buildTokenInstrumentationSection(edition, counts, verdict);
  return { edition, counts, verdict, section };
}

// ---------------------------------------------------------------------------
// CLI guard: só executa como main module, importável sem efeito colateral.
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const edition = resolveEditionFromArgs(values);
  if (!edition) {
    console.error(
      "[check-overnight-token-instrumentation] uso: --edition {AAMMDD} ou --run-dir {path}",
    );
    process.exit(2);
  }
  const result = checkOvernightTokenInstrumentation(edition, resolve(process.cwd()));
  console.log(result.section);
  // Advisory — nunca falha a rodada; o veredito vai pro relatório, não pro exit code.
  process.exit(0);
}
