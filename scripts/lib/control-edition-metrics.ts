/**
 * control-edition-metrics.ts (#5547)
 *
 * Extrai as 4 métricas que a #5419 (edição de controle) pede POR STAGE, a
 * partir dos artefatos que uma edição já rodada deixa em disco:
 *
 *   1. **tokens de entrada** — já capturado por `capture-stage-usage.ts`
 *      (#5413) em `_internal/stage-status.json` (`tokens_in`, filtrado pela
 *      sessão da edição desde #5413 — `session_filter`/`sessions_excluded`
 *      viajam junto).
 *   2. **turnos** — NÃO persistido em `stage-status.json` hoje.
 *      `capture-stage-usage.ts` computa esse número em memória
 *      (`entries_matched` = `window.entries.length`, ver `CaptureResult`) mas
 *      descarta antes de gravar — só sobrevive no stdout daquela invocação
 *      específica, perdido depois. Este módulo RE-DERIVA o número chamando
 *      `collectUsageInWindow` de novo sobre o mesmo transcript local, com a
 *      mesma janela `[start, end]` já persistida — não é estimativa, é a
 *      mesma contagem exata, só recomputada porque o valor original não foi
 *      salvo. Ver `achado: turns_not_persisted_upstream` no resultado de
 *      `extractStageMetrics` quando isso se aplica.
 *   3. **contexto médio por turno** — não existe como campo em lugar nenhum;
 *      é sempre derivado (`tokens_in / turns`), nunca uma métrica capturada
 *      separadamente.
 *   4. **`subagent_tokens`** — capturado em `stage-status.json`
 *      (`subagent_tokens_in`/`subagent_tokens_out`, campo introduzido no
 *      #5413; dado real preenchido a partir do #7084, que passou a varrer
 *      `{sessionId}/subagents/*.jsonl` — ver `scripts/lib/session-transcript.ts`).
 *      `null` explícito quando nenhum turno `isSidechain` caiu na janela —
 *      sem dispatch de `Agent()` no stage, ou dispatch fora do intervalo.
 *      Este módulo só repassa o campo — nunca substitui `null` por `0`.
 *
 * `data/run-log.jsonl` foi checado como fonte candidata (citada na #5547) e
 * NÃO carrega nenhuma das 4 métricas — é log operacional por script
 * (paywall/dedup/etc, campos `edition/stage/agent/level/message/details`),
 * sem `usage`/tokens/turnos. A fonte real das 4 métricas é
 * `_internal/stage-status.json` (#5413) + o transcript local (re-derivação
 * de turnos), não o run-log.
 *
 * Requer sessão LOCAL — mesma exigência de `capture-stage-usage.ts`
 * (`~/.claude/projects/`, ver `scripts/lib/session-transcript.ts`). Sem o
 * diretório de transcripts, `turns`/`avg_context_per_turn` saem `null` com
 * `turns_source: "unavailable"` — nunca 0, nunca estimado.
 */

import { collectUsageInWindow, type CollectUsageOptions } from "./session-transcript.ts";
import type { StageRow, StageStatusDoc } from "../update-stage-status.ts";
import { STAGE_LABELS } from "../update-stage-status.ts";
import type { ConcurrentNoiseVerdict } from "./control-edition-guard.ts";

export interface StageControlMetrics {
  stage: number;
  label: string;
  status: string;
  /** `null` = stage nunca capturado (sem `tokens_in` em `stage-status.json`). */
  tokens_in: number | null;
  tokens_out: number | null;
  /**
   * Re-derivado do transcript local (ver docstring do módulo) — não é o
   * mesmo dado persistido de `tokens_in` (que veio de #5413 na hora da
   * captura); é recomputado agora, sobre a MESMA janela `[start, end]`. Pode
   * divergir de `tokens_in` se o transcript mudou entre a captura original e
   * esta extração (ex: sessão retomada escreveu mais linhas na janela) —
   * `turns_tokens_in` carrega essa segunda contagem para permitir o
   * cross-check; ver `token_count_mismatch` no diagnóstico.
   */
  turns: number | null;
  turns_source: "session_transcript_rederived" | "unavailable";
  turns_reason?: string;
  /** Sessão usada para re-derivar `turns` (ver `turns_session_filter`). */
  turns_session_filter: "current_session" | "all_sessions" | null;
  turns_sessions_excluded: number | null;
  /** `tokens_in` recontado durante a re-derivação de turnos — para cross-check
   * contra o `tokens_in` persistido por #5413 (mesma janela, mesmo filtro
   * quando possível). `null` quando `turns` também é `null`. */
  turns_tokens_in: number | null;
  /** `true` quando `tokens_in` (persistido) e `turns_tokens_in` (re-derivado)
   * divergem — sinal de que o transcript mudou entre a captura original e
   * esta extração (sessão retomada, ou filtro de sessão diferente). Nunca
   * silenciado: o comparador deve exibir isto quando `true`. `null` quando a
   * comparação não é possível (algum dos dois é `null`). */
  token_count_mismatch: boolean | null;
  /** `tokens_in / turns`, arredondado. `null` quando faltar qualquer um dos
   * dois insumos, ou `turns === 0` (evita divisão por zero). */
  avg_context_per_turn: number | null;
  /** `null` = sem dispatch de `Agent()` nesta janela — NUNCA "custou zero"
   * (até o #7084, `null` também podia significar "harness não registra
   * custo de subagente"; hoje o dado é capturado quando existe). Repassado
   * sem alteração de `stage-status.json`. */
  subagent_tokens_in: number | null;
  subagent_tokens_out: number | null;
  /** Procedência de `tokens_in`/`tokens_out` (persistidos por #5413). */
  token_session_filter: "current_session" | "all_sessions" | null;
  token_sessions_excluded: number | null;
  parse_errors: number | null;
}

export interface ControlEditionMeasurement {
  edition: string;
  generated_at: string;
  /** Sessão usada para re-derivar turnos — `null` quando não resolvida
   * (fora de sessão local, ou explicitamente `--all-sessions`). */
  session_id_used: string | null;
  transcripts_dir: string;
  transcripts_dir_exists: boolean;
  stages: StageControlMetrics[];
  totals: {
    tokens_in: number | null;
    tokens_out: number | null;
    turns: number | null;
    avg_context_per_turn: number | null;
    subagent_tokens_in: number | null;
    subagent_tokens_out: number | null;
  };
}

/**
 * `ControlEditionMeasurement` + o veredito de contaminação (#5547 item 3) —
 * o shape completo que `measure-control-edition.ts` grava em disco e que o
 * comparador (`control-edition-compare.ts`) consome. Definido aqui (não no
 * CLI) para que módulos de `lib/` que precisem do tipo (o comparador) não
 * importem de fora de `lib/`.
 */
export interface ControlEditionMeasurementWithContamination extends ControlEditionMeasurement {
  contamination: ConcurrentNoiseVerdict;
}

/**
 * Extrai as 4 métricas de UM stage. Puro dado o `transcriptsDir` (I/O
 * encapsulado em `collectUsageInWindow`, já testado por #5413) — testável
 * com fixtures de diretório, sem mockar `process.env`.
 */
export function extractStageMetrics(
  row: StageRow,
  transcriptsDirExists: boolean,
  transcriptsDir: string,
  sessionId: string | null,
): StageControlMetrics {
  const tokensIn = row.tokens_in ?? null;
  const tokensOut = row.tokens_out ?? null;
  const subagentIn = "subagent_tokens_in" in row ? (row.subagent_tokens_in ?? null) : null;
  const subagentOut = "subagent_tokens_out" in row ? (row.subagent_tokens_out ?? null) : null;

  const base: StageControlMetrics = {
    stage: row.stage,
    label: STAGE_LABELS[row.stage] ?? `Stage ${row.stage}`,
    status: row.status,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    turns: null,
    turns_source: "unavailable",
    turns_session_filter: null,
    turns_sessions_excluded: null,
    turns_tokens_in: null,
    token_count_mismatch: null,
    avg_context_per_turn: null,
    subagent_tokens_in: subagentIn,
    subagent_tokens_out: subagentOut,
    token_session_filter: row.session_filter ?? null,
    token_sessions_excluded: row.sessions_excluded ?? null,
    parse_errors: row.parse_errors ?? null,
  };

  if (!row.start || !row.end) {
    return { ...base, turns_reason: "missing_stage_timestamps" };
  }
  if (!transcriptsDirExists) {
    return { ...base, turns_reason: "no_local_transcripts_dir" };
  }

  const opts: CollectUsageOptions = { sessionId };
  const window = collectUsageInWindow(transcriptsDir, row.start, row.end, opts);

  if (window.entries.length === 0) {
    return {
      ...base,
      turns_reason: "no_usage_records_in_window",
      turns_session_filter: window.sessionFilter,
      turns_sessions_excluded: window.sessionsExcluded,
    };
  }

  const turns = window.entries.length;
  const rederivedTokensIn = window.tokensIn;
  const avgContext = turns > 0 ? Math.round(rederivedTokensIn / turns) : null;
  const mismatch = tokensIn == null ? null : tokensIn !== rederivedTokensIn;

  return {
    ...base,
    turns,
    turns_source: "session_transcript_rederived",
    turns_session_filter: window.sessionFilter,
    turns_sessions_excluded: window.sessionsExcluded,
    turns_tokens_in: rederivedTokensIn,
    token_count_mismatch: mismatch,
    // Prefere o tokens_in PERSISTIDO (#5413, procedência já auditada) para o
    // denominador; cai para o re-derivado só quando o persistido está
    // ausente — mismatch continua visível via `token_count_mismatch`.
    avg_context_per_turn:
      tokensIn != null && turns > 0 ? Math.round(tokensIn / turns) : avgContext,
  };
}

function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  return present.reduce((acc, v) => acc + v, 0);
}

export function buildControlEditionMeasurement(
  doc: StageStatusDoc,
  transcriptsDir: string,
  transcriptsDirExists: boolean,
  sessionId: string | null,
  generatedAt: string = new Date().toISOString(),
): ControlEditionMeasurement {
  const stages = doc.rows
    .slice()
    .sort((a, b) => a.stage - b.stage)
    .map((row) => extractStageMetrics(row, transcriptsDirExists, transcriptsDir, sessionId));

  const tokensIn = sumNullable(stages.map((s) => s.tokens_in));
  const tokensOut = sumNullable(stages.map((s) => s.tokens_out));
  const turns = sumNullable(stages.map((s) => s.turns));
  const subagentIn = sumNullable(stages.map((s) => s.subagent_tokens_in));
  const subagentOut = sumNullable(stages.map((s) => s.subagent_tokens_out));
  const avgContext = tokensIn != null && turns != null && turns > 0 ? Math.round(tokensIn / turns) : null;

  return {
    edition: doc.edition,
    generated_at: generatedAt,
    session_id_used: sessionId,
    transcripts_dir: transcriptsDir,
    transcripts_dir_exists: transcriptsDirExists,
    stages,
    totals: {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      turns,
      avg_context_per_turn: avgContext,
      subagent_tokens_in: subagentIn,
      subagent_tokens_out: subagentOut,
    },
  };
}
