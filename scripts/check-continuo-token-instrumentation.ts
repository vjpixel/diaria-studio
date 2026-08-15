#!/usr/bin/env npx tsx
/**
 * check-continuo-token-instrumentation.ts (#5344 Parte B0)
 *
 * Checagem DETERMINÍSTICA (não-LLM) de que o coordenador de uma sessão
 * `/diaria-continuo` de fato emitiu a instrumentação de token mandatada pelo
 * `SKILL.md` (bullets "Emissão de `coordinator_tokens_estimate` é
 * OBRIGATÓRIA" e "Emissão de `subagent_metrics` é OBRIGATÓRIA aqui também")
 * para um dia rotacionado (`AAMMDD` de `data/continuo/{AAMMDD}/`).
 *
 * Irmão de `scripts/check-overnight-token-instrumentation.ts` (#5009) — MESMO
 * problema, escopo diferente: lá a checagem é "por rodada" (o overnight
 * termina em ~8h e escreve 1 `plan.json`); aqui é "por dia rotacionado" (o
 * `continuo` nunca termina — `scripts/lib/continuo-plan-rotation.ts`, item 5
 * — então "a rodada" não é um conceito que termina, mas cada dia civil já é
 * uma unidade de tempo fechada o bastante pra checar). Sem isso, um
 * coordenador que parasse de emitir os checkpoints faria
 * `continuo-cost-summary.ts` (#5293 item 6, corrigido em #5344 Parte B0)
 * reportar `0` em silêncio — indistinguível de "sessão não fez nada hoje".
 *
 * **Não é gate.** Puramente informativo (advisory) — exit 0 sempre que a
 * leitura do `run-log.jsonl` for bem-sucedida (mesmo com `warning`); nunca
 * bloqueia o loop do `continuo`. Reusa a mesma taxonomia de eventos do
 * irmão (`subagent_metrics`, `coordinator_tokens_estimate`) mas filtra por
 * `agent === "continuo"` (nunca `"overnight"`) — mesma troca obrigatória
 * documentada em todo o resto desta skill. `review_metrics` fica fora do
 * escopo aqui: a Fase 1.5 de review consolidado que o `continuo` reusa não
 * tem cadência fixa por dia (roda quando o coordenador decide consolidar,
 * não uma vez por dia rotacionado necessariamente) — checar isso junto
 * produziria falso-`warning` em dias sem review, então fica de fora até
 * haver um sinal melhor de "quando esperar 1".
 *
 * Uso:
 *   npx tsx scripts/check-continuo-token-instrumentation.ts --edition 260815
 *
 * @see .claude/skills/diaria-continuo/SKILL.md ("Reuso da maquinaria" —
 *      bullets de emissão obrigatória)
 * @see scripts/continuo-cost-summary.ts (consumidor do VALOR; este script
 *      checa só a PRESENÇA)
 * @see scripts/check-overnight-token-instrumentation.ts (mesmo padrão,
 *      escopo "rodada" em vez de "dia rotacionado")
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveRunLogPath } from "./lib/run-log.ts";

/** Os 2 tipos de evento mandatados pelo SKILL.md do `continuo` (escopo diário — ver docstring). */
export const TRACKED_CONTINUO_TOKEN_INSTRUMENTATION_MESSAGES = [
  "coordinator_tokens_estimate",
  "subagent_metrics",
] as const;

export type TrackedContinuoTokenInstrumentationMessage =
  (typeof TRACKED_CONTINUO_TOKEN_INSTRUMENTATION_MESSAGES)[number];

export type ContinuoTokenInstrumentationCounts = Record<TrackedContinuoTokenInstrumentationMessage, number>;

export type ContinuoTokenInstrumentationVerdict =
  | { status: "ok" }
  | { status: "warning"; missing: TrackedContinuoTokenInstrumentationMessage[] };

export interface ContinuoTokenInstrumentationResult {
  edition: string;
  counts: ContinuoTokenInstrumentationCounts;
  verdict: ContinuoTokenInstrumentationVerdict;
  /** Texto pronto pra colar num relatório/status de sessão. */
  section: string;
}

function zeroCounts(): ContinuoTokenInstrumentationCounts {
  return {
    coordinator_tokens_estimate: 0,
    subagent_metrics: 0,
  };
}

function isTrackedMessage(msg: unknown): msg is TrackedContinuoTokenInstrumentationMessage {
  return (
    typeof msg === "string" &&
    (TRACKED_CONTINUO_TOKEN_INSTRUMENTATION_MESSAGES as readonly string[]).includes(msg)
  );
}

/**
 * Pure: conta, por tipo, quantos eventos `run-log.jsonl` (já lido como array
 * de linhas) batem `agent === "continuo"` E `edition === edition` entre os 2
 * tipos rastreados. Linhas malformadas (JSON inválido, ou sem os campos
 * esperados) são ignoradas — nunca lança; o objetivo é contar o que É
 * reconhecível, não validar o formato inteiro do log.
 */
export function countContinuoTokenInstrumentationEvents(
  lines: string[],
  edition: string,
): ContinuoTokenInstrumentationCounts {
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
    if (rec.agent !== "continuo") continue;
    if (rec.edition !== edition) continue;
    if (isTrackedMessage(rec.message)) {
      counts[rec.message] += 1;
    }
  }
  return counts;
}

/**
 * Pure: veredito a partir das contagens. `ok` só quando os 2 tipos têm pelo
 * menos 1 evento; caso contrário `warning` nomeando exatamente os tipos
 * ausentes (uma sessão pode ter emitido 1 dos 2 — ex: dia inteiro parado no
 * passo 6, aguardando resposta, sem nenhuma unidade dispatchada, então
 * `subagent_metrics` ficaria legitimamente em 0; o veredito ainda reporta
 * isso como `warning`, deixando pro humano/coordenador decidir se é
 * esperado — o script não tenta adivinhar a causa).
 */
export function resolveContinuoTokenInstrumentationVerdict(
  counts: ContinuoTokenInstrumentationCounts,
): ContinuoTokenInstrumentationVerdict {
  const missing = TRACKED_CONTINUO_TOKEN_INSTRUMENTATION_MESSAGES.filter((m) => counts[m] === 0);
  if (missing.length === 0) return { status: "ok" };
  return { status: "warning", missing };
}

/**
 * Pure: seção de texto pronta pra colar num relatório/status de sessão. Em
 * `warning`, usa a mesma frase explícita mandatada pelo irmão overnight
 * (#5009) — nunca o `unavailable` ambíguo que motivou aquela issue.
 */
export function buildContinuoTokenInstrumentationSection(
  edition: string,
  counts: ContinuoTokenInstrumentationCounts,
  verdict: ContinuoTokenInstrumentationVerdict,
): string {
  const countsSummary = TRACKED_CONTINUO_TOKEN_INSTRUMENTATION_MESSAGES.map((m) => `${m}: ${counts[m]}`).join(", ");
  if (verdict.status === "ok") {
    return (
      `Instrumentação de token continuo (checagem automática, dia ${edition}): OK — ` +
      `${countsSummary}.`
    );
  }
  const missingList = verdict.missing.join(", ");
  return (
    `Instrumentação de token continuo (checagem automática, dia ${edition}): ` +
    `instrumentação de token não foi emitida neste dia (coordenador esqueceu os checkpoints, ` +
    `ou o dia não teve a fase correspondente — confirmar manualmente) — ` +
    `tipo(s) ausente(s): ${missingList} (${countsSummary}).`
  );
}

/**
 * Orquestração fail-soft: `run-log.jsonl` ausente é tratado como "0
 * eventos" (nunca lança) — um dia que nunca gravou nada no log é o caso mais
 * extremo de "instrumentação não emitida", coberto pelo mesmo `warning`.
 */
export function checkContinuoTokenInstrumentation(
  edition: string,
  rootDir: string = process.cwd(),
): ContinuoTokenInstrumentationResult {
  const logPath = resolveRunLogPath(rootDir);
  const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [];
  const counts = countContinuoTokenInstrumentationEvents(lines, edition);
  const verdict = resolveContinuoTokenInstrumentationVerdict(counts);
  const section = buildContinuoTokenInstrumentationSection(edition, counts, verdict);
  return { edition, counts, verdict, section };
}

// ---------------------------------------------------------------------------
// CLI guard: só executa como main module, importável sem efeito colateral.
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const edition = values.edition ?? null;
  if (!edition) {
    console.error("[check-continuo-token-instrumentation] uso: --edition {AAMMDD}");
    process.exit(2);
  }
  const result = checkContinuoTokenInstrumentation(edition, resolve(process.cwd()));
  console.log(result.section);
  // Advisory — nunca falha a sessão; o veredito é informativo.
  process.exit(0);
}
