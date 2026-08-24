#!/usr/bin/env npx tsx
/**
 * scripts/continuo-cost-summary.ts (#5293 item 6, correção #5344 Parte B0)
 *
 * `/diaria-continuo` roda o coordenador (`model: sonnet`, `effort: high`)
 * indefinidamente — sem o fim de rodada que `/diaria-overnight` tem (~8h,
 * depois encerra), é o maior consumidor de token por sessão de qualquer
 * fluxo deste repo (#3453 já tinha identificado isso pro overnight, que ao
 * menos tem fim). "Sem limites" é o mandato explícito (#2039/#5293), mas o
 * editor precisa do NÚMERO real acumulado pra decidir se quer impor um teto
 * — hoje esta skill não tem nenhum.
 *
 * Este script agrega DUAS categorias de token através de todos os dias
 * rotacionados de uma sessão `/diaria-continuo`:
 *
 * 1. **Coordenador** — eventos `coordinator_tokens_estimate` (`agent:
 *    "continuo"`), emitidos pelo coordenador ao fim de cada transição de
 *    fase relevante do loop (`.claude/skills/diaria-continuo/SKILL.md`,
 *    bullet "Emissão de coordinator_tokens_estimate é OBRIGATÓRIA").
 * 2. **Implementação** — eventos `subagent_metrics` (também `agent:
 *    "continuo"` — é o coordenador quem emite, com `details.subagent_tokens`
 *    vindo do `harness_usage` do subagente que ele despachou), a mesma
 *    convenção já usada por `/diaria-overnight`/`/diaria-develop`
 *    (`.claude/skills/diaria-overnight/SKILL.md`, Fase 1 passo 5,
 *    "Instrumentação de token por unidade #4815"). `/diaria-continuo` herda
 *    essa emissão **verbatim** ao reusar a Fase 1 de implementação do
 *    overnight (ver bullet "Reusa a Fase 1 de implementação" do SKILL.md —
 *    a troca obrigatória `--agent overnight` → `--agent continuo` cobre
 *    TODA citação de `log-event.ts` dentro dessa fase, `subagent_metrics`
 *    incluso, não só `coordinator_tokens_estimate`).
 *
 * **Achado #5344 Parte B0**: antes desta correção, este script somava só a
 * categoria 1 — ignorando `subagent_tokens`, que é o grosso do gasto real
 * de qualquer unidade de implementação (a mesma categoria que motivou a
 * seção "Custo em tokens" mandatória do overnight, #4815). O número
 * reportado subestimava a sessão por uma margem desconhecida. Correção:
 * somar as duas categorias, reportadas separadamente E combinadas
 * (`totalTokens`), pro mesmo motivo que o overnight reporta "Coordenador"
 * e "Implementação" como linhas distintas na Fase 2 — são gastos de
 * natureza diferente (1 sessão vs. N subagentes por unidade).
 *
 * **Instrumentação em si continua fora do escopo desta correção** — se o
 * coordenador não estiver de fato emitindo `subagent_metrics`/
 * `coordinator_tokens_estimate` (regressão de disciplina, não de código),
 * este script reporta silenciosamente `eventCount: 0`/`totalTokens: 0` para
 * a categoria ausente. `scripts/check-continuo-token-instrumentation.ts`
 * (#5344 Parte B0, irmão de `check-overnight-token-instrumentation.ts`
 * #5009) fecha essa lacuna de PRESENÇA — este script soma o VALOR; as duas
 * checagens são complementares, não substitutas.
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
 * @see scripts/check-continuo-token-instrumentation.ts (irmão — presença,
 *      não soma; escopo de 1 dia rotacionado, não do ciclo inteiro)
 * @see scripts/check-overnight-token-instrumentation.ts (mesmo padrão do
 *      lado overnight/develop — fonte da convenção `subagent_metrics`)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolveRunLogPath } from "./lib/run-log.ts";
import { listContinuoDays } from "./lib/continuo-plan-rotation.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

export interface ContinuoCostSummary {
  editions: string[];
  /** `coordinatorTokens + implementationTokens` — o gasto combinado da sessão. */
  totalTokens: number;
  /** Soma de `coordinator_tokens_estimate` (categoria 1 — coordenador). */
  coordinatorTokens: number;
  /** Soma de `subagent_metrics.details.subagent_tokens` (categoria 2 — implementação). */
  implementationTokens: number;
  /** Eventos `coordinator_tokens_estimate` com `tokens: null` (harness não expôs) — contados à parte, nunca somados como 0. */
  unavailableCount: number;
  /** Eventos `subagent_metrics` com `subagent_tokens: null` (harness não expôs por invocação) — mesmo tratamento. */
  implementationUnavailableCount: number;
  /**
   * Total de eventos `coordinator_tokens_estimate` reconhecidos, independente
   * de `source`/`tokens` — NÃO é a soma de `bySource` particionada por
   * `unavailableCount` vs. o resto (as duas dimensões são ortogonais: um
   * evento com `source: "harness_usage"` E `tokens: null` conta em ambos
   * `bySource["harness_usage"]` e `unavailableCount`, não é uma 3ª categoria).
   */
  eventCount: number;
  /** Total de eventos `subagent_metrics` reconhecidos, independente de `source`/`subagent_tokens`. */
  implementationEventCount: number;
  /** Soma combinada (coordenador + implementação) por dia rotacionado. */
  perEdition: Record<string, number>;
  /** Breakdown por `source` dos eventos `coordinator_tokens_estimate` apenas (categoria 1). */
  bySource: Record<string, number>;
}

interface CoordinatorTokensEvent {
  agent?: string;
  edition?: string;
  message?: string;
  details?: { tokens?: number | null; source?: string; subagent_tokens?: number | null };
}

/**
 * Pure: soma `details.tokens` dos eventos `coordinator_tokens_estimate` E
 * `details.subagent_tokens` dos eventos `subagent_metrics`, ambos do agent
 * `"continuo"`, cuja `edition` está em `editions`. Linhas malformadas ou de
 * outro agent/message são ignoradas silenciosamente (mesmo padrão de
 * `countTokenInstrumentationEvents`, #5009) — não é validação de formato do
 * log inteiro, só extração do que é reconhecível.
 */
export function sumContinuoTokenEstimates(lines: string[], editions: Set<string>): ContinuoCostSummary {
  const perEdition: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let coordinatorTokens = 0;
  let implementationTokens = 0;
  let unavailableCount = 0;
  let implementationUnavailableCount = 0;
  let eventCount = 0;
  let implementationEventCount = 0;

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
    if (!event.edition || !editions.has(event.edition)) continue;

    if (event.message === "coordinator_tokens_estimate") {
      eventCount += 1;
      const tokens = event.details?.tokens;
      const source = event.details?.source ?? "unknown";
      bySource[source] = (bySource[source] ?? 0) + 1;

      if (tokens === null || tokens === undefined) {
        unavailableCount += 1;
        continue;
      }
      coordinatorTokens += tokens;
      perEdition[event.edition] = (perEdition[event.edition] ?? 0) + tokens;
      continue;
    }

    if (event.message === "subagent_metrics") {
      implementationEventCount += 1;
      const tokens = event.details?.subagent_tokens;

      if (tokens === null || tokens === undefined) {
        implementationUnavailableCount += 1;
        continue;
      }
      implementationTokens += tokens;
      perEdition[event.edition] = (perEdition[event.edition] ?? 0) + tokens;
    }
  }

  return {
    editions: [...editions].sort(),
    totalTokens: coordinatorTokens + implementationTokens,
    coordinatorTokens,
    implementationTokens,
    unavailableCount,
    implementationUnavailableCount,
    eventCount,
    implementationEventCount,
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
    `  Tokens acumulados (total): ~${summary.totalTokens.toLocaleString("pt-BR")}`,
    `    Coordenador: ~${summary.coordinatorTokens.toLocaleString("pt-BR")} (${summary.eventCount} evento(s), ${summary.unavailableCount} sem valor — harness não expôs)`,
    `    Implementação: ~${summary.implementationTokens.toLocaleString("pt-BR")} (${summary.implementationEventCount} evento(s), ${summary.implementationUnavailableCount} sem valor — harness não expôs)`,
  ];
  const sourceParts = Object.entries(summary.bySource).map(([src, n]) => `${src}: ${n}`);
  if (sourceParts.length > 0) lines.push(`  Fontes (coordenador): ${sourceParts.join(", ")}`);
  if (Object.keys(summary.perEdition).length > 0) {
    lines.push("  Por dia (combinado):");
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
