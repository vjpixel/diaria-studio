#!/usr/bin/env npx tsx
/**
 * scripts/continuo-cost-summary.ts (#5293 item 6)
 *
 * `/diaria-continuo` roda o coordenador (`model: sonnet`, `effort: high`)
 * indefinidamente — sem o fim de rodada que `/diaria-overnight` tem (~8h,
 * depois encerra), é o maior consumidor de token por sessão de qualquer
 * fluxo deste repo (#3453 já tinha identificado isso pro overnight, que ao
 * menos tem fim). "Sem limites" é o mandato explícito (#2039/#5293), mas o
 * editor precisa do NÚMERO real acumulado pra decidir se quer impor um teto
 * — hoje esta skill não tem nenhum.
 *
 * Este script agrega os eventos `coordinator_tokens_estimate` que o
 * coordenador **deve** emitir ao fim de cada transição de fase relevante do
 * loop (`.claude/skills/diaria-continuo/SKILL.md`, bullet "Emissão de
 * coordinator_tokens_estimate é OBRIGATÓRIA" em "Reuso da maquinaria" —
 * instrução explícita adicionada no mesmo fleet review que corrigiu esta
 * frase; achado original do #5293 item 6: esta unidade tinha entregue só a
 * AGREGAÇÃO sem nunca instruir a EMISSÃO, o que faria este script sempre
 * reportar zero em silêncio). Reusa `agent === "continuo"` em vez de
 * `"overnight"` — mesma troca obrigatória documentada no SKILL.md pra
 * qualquer citação da Fase 1 do overnight. Filtra `data/run-log.jsonl`
 * **através de TODOS os dias rotacionados**
 * (`scripts/lib/continuo-plan-rotation.ts`, item 5) — não só o dia corrente.
 * **Se o coordenador não estiver de fato emitindo esses eventos (regressão
 * de disciplina, não de código), este script reporta silenciosamente
 * `eventCount: 0`/`totalTokens: 0` — o mesmo tipo de gap que
 * `check-overnight-token-instrumentation.ts` (#5009) existe pra detectar do
 * lado do overnight/develop; nenhum equivalente foi construído aqui ainda.**
 * `scripts/check-overnight-token-instrumentation.ts` (irmão, #5009) só checa
 * PRESENÇA de eventos por edição isolada; este script soma o VALOR
 * (`details.tokens`) através do ciclo inteiro — as duas checagens são
 * complementares, não substitutas uma da outra.
 *
 * Uso:
 *   npx tsx scripts/continuo-cost-summary.ts
 *   npx tsx scripts/continuo-cost-summary.ts --since 260812
 *   npx tsx scripts/continuo-cost-summary.ts --json
 *
 * `--since {AAMMDD}` bound: soma só dias >= o valor dado (default: ciclo
 * inteiro, todos os dias com `plan.json` sob `data/continuo/`). `--json`
 * imprime o resultado estruturado em vez do resumo em texto — útil pra um
 * dashboard/relatório colar sem re-parsear.
 *
 * @see .claude/skills/diaria-continuo/SKILL.md ("Itens 3-6", item 6)
 * @see scripts/check-overnight-token-instrumentation.ts (irmão — presença,
 *      não soma; escopo de 1 edição, não do ciclo inteiro)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolveRunLogPath } from "./lib/run-log.ts";
import { listContinuoDays } from "./lib/continuo-plan-rotation.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

export interface ContinuoCostSummary {
  editions: string[];
  totalTokens: number;
  /** Eventos com `tokens: null` (harness não expôs `usage`) — contados à parte, nunca somados como 0. */
  unavailableCount: number;
  /**
   * Total de eventos `coordinator_tokens_estimate` reconhecidos, independente
   * de `source`/`tokens` — NÃO é a soma de `bySource` particionada por
   * `unavailableCount` vs. o resto (as duas dimensões são ortogonais: um
   * evento com `source: "harness_usage"` E `tokens: null` conta em ambos
   * `bySource["harness_usage"]` e `unavailableCount`, não é uma 3ª categoria).
   */
  eventCount: number;
  perEdition: Record<string, number>;
  bySource: Record<string, number>;
}

interface CoordinatorTokensEvent {
  agent?: string;
  edition?: string;
  message?: string;
  details?: { tokens?: number | null; source?: string };
}

/**
 * Pure: soma `details.tokens` dos eventos `coordinator_tokens_estimate` do
 * agent `"continuo"` cuja `edition` está em `editions`. Linhas malformadas
 * ou de outro agent/message são ignoradas silenciosamente (mesmo padrão de
 * `countTokenInstrumentationEvents`, #5009) — não é validação de formato do
 * log inteiro, só extração do que é reconhecível.
 */
export function sumContinuoTokenEstimates(lines: string[], editions: Set<string>): ContinuoCostSummary {
  const perEdition: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let totalTokens = 0;
  let unavailableCount = 0;
  let eventCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: CoordinatorTokensEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.agent !== "continuo") continue;
    if (event.message !== "coordinator_tokens_estimate") continue;
    if (!event.edition || !editions.has(event.edition)) continue;

    eventCount += 1;
    const tokens = event.details?.tokens;
    const source = event.details?.source ?? "unknown";
    bySource[source] = (bySource[source] ?? 0) + 1;

    if (tokens === null || tokens === undefined) {
      unavailableCount += 1;
      continue;
    }
    totalTokens += tokens;
    perEdition[event.edition] = (perEdition[event.edition] ?? 0) + tokens;
  }

  return {
    editions: [...editions].sort(),
    totalTokens,
    unavailableCount,
    eventCount,
    perEdition,
    bySource,
  };
}

/**
 * Orquestração fail-soft: `run-log.jsonl` ausente (sessão nunca emitiu nada,
 * ou máquina nova) → summary zerado, nunca lança. `data/continuo/` ausente
 * → `editions: []`, mesmo tratamento.
 */
export function computeContinuoCostSummary(
  rootDir: string = process.cwd(),
  since: string | null = null,
): ContinuoCostSummary {
  const allDays = listContinuoDays(rootDir);
  const editions = new Set(since ? allDays.filter((d) => d >= since) : allDays);

  const logPath = resolveRunLogPath(rootDir);
  const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [];

  return sumContinuoTokenEstimates(lines, editions);
}

/** Texto pronto pra colar num relatório/status — não usa unicode decorativo, só fatos. */
export function formatContinuoCostSummary(summary: ContinuoCostSummary): string {
  if (summary.editions.length === 0) {
    return "continuo-cost-summary: nenhum dia de sessão contínua encontrado em data/continuo/.";
  }
  const lines = [
    `continuo-cost-summary: ciclo com ${summary.editions.length} dia(s) — ${summary.editions[0]} a ${summary.editions[summary.editions.length - 1]}`,
    `  Tokens acumulados (coordenador): ~${summary.totalTokens.toLocaleString("pt-BR")}`,
    `  Eventos coordinator_tokens_estimate: ${summary.eventCount} (${summary.unavailableCount} sem valor — harness não expôs)`,
  ];
  const sourceParts = Object.entries(summary.bySource).map(([src, n]) => `${src}: ${n}`);
  if (sourceParts.length > 0) lines.push(`  Fontes: ${sourceParts.join(", ")}`);
  if (Object.keys(summary.perEdition).length > 0) {
    lines.push("  Por dia:");
    for (const [edition, tokens] of Object.entries(summary.perEdition).sort()) {
      lines.push(`    ${edition}: ~${tokens.toLocaleString("pt-BR")}`);
    }
  }
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const since = values.since ?? null;
  const summary = computeContinuoCostSummary(process.cwd(), since);
  if (flags.has("json")) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write(formatContinuoCostSummary(summary) + "\n");
  }
}
