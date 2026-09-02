#!/usr/bin/env npx tsx
/**
 * coordinator-usage-estimate.ts (#6634)
 *
 * Fecha o buraco que motivou a #6634: o evento `coordinator_tokens_estimate`
 * (contrato #3453 Rec 1/#4815) saiu `unavailable` em 9/9 ocorrências reais
 * porque a emissão dependia de o coordenador (LLM) derivar um número que o
 * harness não entrega por tool call nenhuma — e o fallback `context_size_proxy`
 * previsto no SKILL.md nunca tinha implementação.
 *
 * Este script é a implementação do fallback. Ele não pergunta nada ao
 * harness: lê o transcript LOCAL da própria sessão coordenadora
 * (`~/.claude/projects/{cwd}/{sessionId}.jsonl`, mesma fonte real que
 * `capture-stage-usage.ts` usa pra kind "edicao" desde o #3441 — os turnos
 * `type: "assistant"` carregam `message.usage` com input/output/cache) e
 * soma o usage da janela. **É a MAIOR fatia da rodada que o painel mostrava
 * como `-`**: input re-billing + cache_read a cada turno do coordenador
 * (#6634 item 1).
 *
 * ## Semântica do número emitido (delta, não cumulativo)
 *
 * O evento é emitido ao fim de CADA fase/onda/transição, e o
 * `aggregate-session-tokens.ts` SOMA os eventos da categoria — então o
 * `tokens` gravado é o DELTA desde o último evento com número da mesma
 * (edition, agent), não o total acumulado (cumulativo somaria N vezes o
 * mesmo contexto). A base vem do próprio `data/run-log.jsonl` (último
 * `coordinator_tokens_estimate` com `tokens` finito para a mesma edition +
 * agent). Detalhes, todos documentados no `details` do evento:
 * - `cumulative_tokens` — o total da sessão até o checkpoint (o que o painel
 *   da #6634 chama de contexto acumulado; fica no evento pra leitura direta
 *   sem re-somar deltas).
 * - Sessão reiniciada entre checkpoints (crash/resume, novo transcript):
 *   `cumulative < base` → o delta emitido é o `cumulative` da sessão nova
 *   (o gasto da sessão anterior até o último checkpoint já foi contado; o
 *   intervalo entre checkpoint e crash não é recuperável — subestima, nunca
 *   inventa).
 * - `source: "context_size_proxy"` — nome do contrato (#3453), mas o número
 *   é usage REAL da API via transcript, não estimativa por chars/4; o
 *   "proxy" é por ser pós-hoc e limitado ao que o transcript registra
 *   (exclui subagentes, #5413 — que têm evento próprio, `subagent_metrics`).
 *
 * ## Fail-soft (mesma disciplina do capture-stage-usage #6170)
 *
 * Qualquer condição impeditiva — `CLAUDE_CODE_SESSION_ID` ausente, transcript
 * da sessão não encontrado, zero entradas de usage na janela — grava o evento
 * com `{"tokens": null, "source": "unavailable", "reason": ...}` e sai 0:
 * a LACUNA vira telemetria (`n/d` no painel) em vez de buraco silencioso,
 * que é exatamente o item 2 da #6634. NUNCA grava zero como se fosse consumo
 * real, NUNCA contamina com sessão concorrente (transcript filtrado por
 * sessionId; `session_file_not_found` → unavailable, nunca fallback
 * `all_sessions`), NUNCA lança.
 *
 * Uso (um comando por checkpoint — nada pra derivar, é isso que fecha o
 * "coordenador esquece/erra a deriva" da causa raiz):
 *   npx tsx scripts/coordinator-usage-estimate.ts --edition 260902 --agent overnight --phase fase_0
 *   npx tsx scripts/coordinator-usage-estimate.ts --edition 260902 --agent develop --phase "onda w3" \
 *     --since 2026-09-02T03:00:00Z   # janela explícita (default: sessão inteira)
 *   npx tsx scripts/coordinator-usage-estimate.ts ... --dry-run   # imprime, não grava
 *
 * `--agent` aceita só overnight|develop|continuo (kinds com coordenador —
 * `edicao` não emite este evento, tem `capture-stage-usage.ts`).
 *
 * @see .claude/skills/diaria-overnight/SKILL.md (Fase 0 passo 1 — contrato)
 * @see scripts/lib/session-transcript.ts (leitura de usage do transcript)
 * @see scripts/lib/run-log.ts (append do evento)
 * @see scripts/aggregate-session-tokens.ts (consumidor — categoria coordinator)
 */

import { existsSync, readFileSync } from "node:fs";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { logEvent, resolveRunLogPath } from "./lib/run-log.ts";
import {
  collectUsageInWindow,
  currentSessionId,
  resolveTranscriptsDir,
} from "./lib/session-transcript.ts";

/** Kinds que têm coordenador e emitem `coordinator_tokens_estimate`. */
export const COORDINATOR_KINDS = ["overnight", "develop", "continuo"] as const;
export type CoordinatorKind = (typeof COORDINATOR_KINDS)[number];

export const COORDINATOR_ESTIMATE_MESSAGE = "coordinator_tokens_estimate";

/** Detalhes que o evento carrega — sobrenome de cada via, consumido pelo aggregate. */
export interface CoordinatorEstimateDetails {
  phase: string;
  /** Delta desde o último evento com número; `null` = não foi possível medir. */
  tokens: number | null;
  source: "context_size_proxy" | "unavailable";
  /** Só em `ok`: total da sessão até o checkpoint (in+out, billed input inclui cache). */
  cumulative_tokens?: number;
  /** Só em `unavailable`: por que não mediu. */
  reason?: "no_session_id" | "session_file_not_found" | "no_usage_entries";
}

export type CoordinatorEstimate =
  | {
      status: "ok";
      /** Delta a ser gravado em `details.tokens`. */
      tokens: number;
      /** Total da sessão até o checkpoint. */
      cumulativeTokens: number;
      sessionId: string;
    }
  | {
      status: "unavailable";
      reason: NonNullable<CoordinatorEstimateDetails["reason"]>;
    };

/**
 * Pure: delta a gravar a partir do cumulativo atual e da base lida do
 * run-log (último evento da mesma edition+agent com `tokens` finito; `null`
 * se não há nenhum). `cumulative < base` = sessão reiniciou entre os
 * checkpoints — o delta honesto disponível é o cumulativo da sessão nova
 * (ver docstring, nunca negativo).
 */
export function computeCheckpointDelta(cumulative: number, lastFiniteTokens: number | null): number {
  if (lastFiniteTokens === null) return cumulative;
  if (cumulative >= lastFiniteTokens) return cumulative - lastFiniteTokens;
  return cumulative;
}

/**
 * Pure: último `tokens` finito entre os eventos `coordinator_tokens_estimate`
 * da mesma edition + agent (varre de trás pra frente — o mais recente vence).
 * Linhas malformadas são ignoradas, mesmo padrão de
 * `countTokenInstrumentationEvents`. `null` = nenhum evento numerado ainda.
 */
export function lastFiniteCoordinatorTokens(
  lines: string[],
  edition: string,
  agent: CoordinatorKind,
): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    if (rec.message !== COORDINATOR_ESTIMATE_MESSAGE) continue;
    if (rec.edition !== edition) continue;
    if (rec.agent !== agent) continue;
    const details = rec.details as { tokens?: unknown } | null | undefined;
    // `Number(null)` é 0 — um evento `unavailable` ({tokens: null}) seria lido
    // como base 0 e o próximo delta viraria o cumulativo inteiro de novo.
    // Só um `number` finito conta como base (mesmo critério do aggregate).
    const raw = details?.tokens;
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    return raw;
  }
  return null;
}

/**
 * Orquestração pura de decisão: dado o resultado do `collectUsageInWindow`,
 * da sessão e da base do run-log, decide o estimate. Separada do I/O pra
 * teste não precisar de transcript real.
 */
export function decideEstimate(
  input: {
    sessionId: string | null;
    sessionFilter: "current_session" | "all_sessions";
    filterReason?: "no_session_id" | "session_file_not_found";
    usageEntries: number;
    tokensIn: number;
    tokensOut: number;
    lastFiniteTokens: number | null;
  },
): CoordinatorEstimate {
  if (!input.sessionId) return { status: "unavailable", reason: "no_session_id" };
  if (input.sessionFilter !== "current_session") {
    // `session_file_not_found`: a sessão não persistiu transcript (agendado
    // com --no-session-persistence, cloud) — medir "all_sessions" aqui
    // contamina com sessão concorrente (#5413/#6170). Unavailable, nunca.
    return { status: "unavailable", reason: "session_file_not_found" };
  }
  if (input.usageEntries === 0) return { status: "unavailable", reason: "no_usage_entries" };
  const cumulative = input.tokensIn + input.tokensOut;
  return {
    status: "ok",
    tokens: computeCheckpointDelta(cumulative, input.lastFiniteTokens),
    cumulativeTokens: cumulative,
    sessionId: input.sessionId,
  };
}

export function estimateToDetails(estimate: CoordinatorEstimate, phase: string): CoordinatorEstimateDetails {
  if (estimate.status === "ok") {
    return {
      phase,
      tokens: estimate.tokens,
      source: "context_size_proxy",
      cumulative_tokens: estimate.cumulativeTokens,
    };
  }
  return { phase, tokens: null, source: "unavailable", reason: estimate.reason };
}

/**
 * Roda o estimate completo (leitura de transcript + run-log) e devolve o
 * resultado pronto pra virar evento. `rootDir`/`cwd`/`homeDir`/`env`
 * injetáveis pra teste; defaults = produção.
 */
export function estimateCoordinatorUsage(opts: {
  edition: string;
  agent: CoordinatorKind;
  sinceIso?: string;
  sessionId?: string | null;
  rootDir?: string;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): CoordinatorEstimate {
  const { edition, agent, sinceIso } = opts;
  const rootDir = opts.rootDir ?? process.cwd();
  const env = opts.env ?? process.env;
  const sessionId = opts.sessionId !== undefined ? opts.sessionId : currentSessionId(env);

  const logPath = resolveRunLogPath(rootDir);
  const lastFiniteTokens = lastFiniteCoordinatorTokens(
    existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [],
    edition,
    agent,
  );

  if (!sessionId) return { status: "unavailable", reason: "no_session_id" };
  const transcriptsDir = resolveTranscriptsDir(opts.cwd ?? rootDir, opts.homeDir);
  const endIso = (opts.now ?? new Date()).toISOString();
  const startIso = sinceIso ?? "1970-01-01T00:00:00Z";
  let window: ReturnType<typeof collectUsageInWindow>;
  try {
    window = collectUsageInWindow(transcriptsDir, startIso, endIso, { sessionId });
  } catch {
    return { status: "unavailable", reason: "session_file_not_found" };
  }
  return decideEstimate({
    sessionId,
    sessionFilter: window.sessionFilter,
    filterReason: window.sessionFilter === "all_sessions" ? window.filterReason : undefined,
    usageEntries: window.entries.length,
    tokensIn: window.tokensIn,
    tokensOut: window.tokensOut,
    lastFiniteTokens,
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const edition = values.edition;
  const agent = values.agent as CoordinatorKind;
  if (!edition || !agent || !(COORDINATOR_KINDS as readonly string[]).includes(agent)) {
    console.error(
      `[coordinator-usage-estimate] uso: --edition {AAMMDD} --agent {${COORDINATOR_KINDS.join("|")}} --phase {nome} [--since ISO] [--session-id UUID] [--dry-run]`,
    );
    process.exit(2);
  }
  const phase = values.phase ?? "checkpoint";
  const result = estimateCoordinatorUsage({
    edition,
    agent,
    sinceIso: values.since,
    sessionId: values["session-id"] ?? undefined,
  });
  const details = estimateToDetails(result, phase);
  if (flags.has("dry-run")) {
    console.log(JSON.stringify({ edition, agent, message: COORDINATOR_ESTIMATE_MESSAGE, details }, null, 2));
    return;
  }
  logEvent({
    edition,
    stage: null,
    agent,
    level: "info",
    message: COORDINATOR_ESTIMATE_MESSAGE,
    details,
  });
  console.log(
    result.status === "ok"
      ? `✓ ${COORDINATOR_ESTIMATE_MESSAGE} gravado: phase="${phase}" tokens=${details.tokens} (cumulativo ${details.cumulative_tokens}, source ${details.source})`
      : `✓ ${COORDINATOR_ESTIMATE_MESSAGE} gravado: phase="${phase}" tokens=null (${details.reason}, source ${details.source})`,
  );
  // ok e unavailable são telemetria válida — a lacuna virou evento (#6634 item 2).
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main();
}
