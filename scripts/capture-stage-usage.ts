/**
 * capture-stage-usage.ts (#3441)
 *
 * Fecha o gap de instrumentação descrito em #3441: popula `cost_usd`/
 * `tokens_in`/`tokens_out`/`models` em `_internal/stage-status.json` com
 * dados REAIS, capturados via parsing pós-hoc do transcript da sessão Claude
 * Code local (`scripts/lib/session-transcript.ts`) — não estimativa, não
 * placeholder.
 *
 * Chamado pelo orchestrator logo APÓS marcar um stage `done` (o `--end` já
 * precisa estar gravado em `stage-status.json` — este script lê a janela
 * `[start, end]` do próprio stage e agrega todo `usage` de assistant message
 * dentro dela). Idempotente: re-rodar recomputa e sobrescreve os mesmos
 * campos; não toca `status`/`start`/`end`/`duration_ms`.
 *
 * Uso:
 *   npx tsx scripts/capture-stage-usage.ts --edition-dir data/editions/260508 --stage 1
 *   npx tsx scripts/capture-stage-usage.ts --edition-dir data/editions/260508 --stage 1 --dry-run
 *   # override explícito de janela (default: lê start/end do próprio row):
 *   npx tsx scripts/capture-stage-usage.ts --edition-dir ... --stage 1 \
 *     --start 2026-05-08T08:30:00Z --end 2026-05-08T08:48:00Z
 *   # análise pós-hoc de uma sessão que não é a corrente:
 *   npx tsx scripts/capture-stage-usage.ts --edition-dir ... --stage 1 --session-id <uuid>
 *   # comportamento pré-#5413 (soma TODAS as sessões da janela):
 *   npx tsx scripts/capture-stage-usage.ts --edition-dir ... --stage 1 --all-sessions
 *
 * #5413 — por default conta só a sessão que invocou o script
 * (`CLAUDE_CODE_SESSION_ID`). Antes somava toda sessão Claude Code ativa no
 * mesmo repo dentro da janela do stage: medido na edição 260814, isso inflou
 * o total em 29% (303M de 1.001M vieram de 5 sessões paralelas). O resultado
 * agora sempre carrega `session_filter` e `sessions_excluded` — e
 * `subagent_tokens_in: null`, que significa NÃO REGISTRADO pelo harness, não
 * "custou zero".
 *
 * Fail-soft (#738-adjacent, mesma disciplina de `update-stage-status.ts`):
 * qualquer condição impeditiva (sem timestamps, sem diretório de transcripts
 * local, sem entradas de usage na janela, fallback `all_sessions` por
 * `session_file_not_found` sem `--all-sessions` explícito — #6170 item 3)
 * imprime `source: "unavailable"` + `reason` e sai com status 0 — NUNCA
 * escreve zero/null nem custo de sessão alheia como se fosse dado real do
 * stage, e nunca bloqueia o pipeline.
 *
 * #6170 — `session_filter_reason` (`no_session_id` | `session_file_not_found`)
 * agora sobrevive ao persist em `stage-status.json` (item 1) e, quando o
 * motivo é `session_file_not_found` (a sessão tem id mas NUNCA escreveu
 * transcript — comprovado ao vivo nas edições 260826/260827, causado por
 * `claude --print --no-session-persistence` no runner agendado, ver
 * `scripts/overnight/run-scheduled-edicao.ts`), o script não grava mais o
 * agregado contaminado — degrada pra `source: "unavailable"` (item 3), a
 * menos que `--all-sessions` tenha sido pedido explicitamente. `no_session_id`
 * (env var ausente, sem sinal de qual sessão é a nossa) continua com o
 * best-effort de sempre — mais ambíguo, sem confirmação ao vivo de que é
 * sempre 100% alheio.
 *
 * Requer sessão LOCAL — `~/.claude/projects/` não existe (ou não reflete a
 * sessão corrente) em ambiente cloud/worktree efêmero. Ver
 * `scripts/lib/session-transcript.ts` pro detalhe do que é capturável vs o
 * que fica como gap conhecido (custo de subagente, em qualquer modo de
 * isolamento, não é gravado em transcript nenhum — #5413).
 *
 * Output: JSON em stdout — `{ source: "session_transcript", ... }` em
 * sucesso, `{ source: "unavailable", reason, ... }` quando não há dado real
 * a capturar.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";
import { loadDoc, saveDoc, applyUpdate, type StageRow } from "./update-stage-status.ts";
import {
  collectUsageInWindow,
  currentSessionId,
  resolveTranscriptsDir,
  type CollectUsageOptions,
  type SessionFilterMode,
  type SessionFilterReason,
  type UsageWindowResult,
} from "./lib/session-transcript.ts";
import { editionDateMs, estimateCallCostUsd, shortModelName } from "./lib/pricing.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface CaptureResult {
  source: "session_transcript" | "unavailable";
  reason?: string;
  path?: string;
  stage?: number;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  cost_partial?: boolean;
  models?: string[];
  sessions_scanned?: number;
  entries_matched?: number;
  /** `current_session` | `all_sessions` — ver #5413. */
  session_filter?: SessionFilterMode;
  session_filter_reason?: SessionFilterReason;
  /** Sessões concorrentes com turnos na mesma janela que ficaram de fora. */
  sessions_excluded?: number;
  /**
   * `null` = custo de subagente NÃO REGISTRADO pelo harness, não zero. Campo
   * explícito de propósito: antes do #5413 esse custo não tinha campo nenhum
   * — ficava simplesmente ausente, e `tokens_in` era lido como se já fosse o
   * total do stage. O buraco não inflava o número, tornava-o incompleto sem
   * deixar rastro.
   */
  subagent_tokens_in?: number | null;
  subagent_tokens_out?: number | null;
  /**
   * Linhas de transcript que pareciam um evento JSON válido mas falharam
   * `JSON.parse` (#5423) — sinal de truncamento por escrita concorrente, não
   * escopado à janela do stage (linha malformada não tem timestamp legível).
   * `0` é o caso normal.
   */
  parse_errors?: number;
}

/**
 * Campos de diagnóstico do #5413, num só lugar — os dois retornos de
 * `captureUsageForWindow` (sucesso e `no_usage_records_in_window`) precisam
 * carregar exatamente o mesmo conjunto. Duplicar isso à mão foi o que fez o
 * `sessions_excluded` sumir do branch vazio na primeira versão desta issue.
 */
function describeWindowFilter(
  window: UsageWindowResult,
): Pick<
  CaptureResult,
  | "session_filter"
  | "session_filter_reason"
  | "sessions_excluded"
  | "subagent_tokens_in"
  | "subagent_tokens_out"
  | "parse_errors"
> {
  return {
    session_filter: window.sessionFilter,
    ...(window.sessionFilter === "all_sessions"
      ? { session_filter_reason: window.filterReason }
      : {}),
    sessions_excluded: window.sessionsExcluded,
    subagent_tokens_in: window.subagentTokensIn,
    subagent_tokens_out: window.subagentTokensOut,
    parse_errors: window.parseErrors,
  };
}

/**
 * Núcleo puro: dado a janela [start, end] + diretório de transcripts +
 * edition id (pra resolver pricing intro/standard), retorna o resultado
 * agregado — SEM tocar disco de `stage-status.json`. Separado do CLI pra ser
 * testável sem fixtures de stage-status.
 */
export function captureUsageForWindow(
  transcriptsDir: string,
  start: string | undefined,
  end: string | undefined,
  editionId: string,
  opts: CollectUsageOptions & {
    /**
     * `true` só quando o chamador pediu `--all-sessions` explicitamente
     * (análise pós-hoc deliberada) — nesse caso o fallback pra `all_sessions`
     * é o comportamento PEDIDO, não um acidente de sessão não-identificável,
     * e o guard de `session_file_not_found` abaixo (#6170) não se aplica.
     * `false`/omitido (default, caminho automático do pipeline) é onde o
     * guard vale.
     */
    explicitAllSessions?: boolean;
  } = {},
): CaptureResult {
  if (!start || !end) {
    return { source: "unavailable", reason: "missing_stage_timestamps" };
  }
  if (!existsSync(transcriptsDir)) {
    return { source: "unavailable", reason: "no_local_transcripts_dir" };
  }
  const window = collectUsageInWindow(transcriptsDir, start, end, opts);

  // #6170 item 3 — `session_file_not_found` prova que a sessão-alvo (via
  // `CLAUDE_CODE_SESSION_ID` ou `--session-id`) NUNCA escreveu transcript
  // nenhum: o arquivo procurado simplesmente não existe no diretório. Isso
  // significa que 0% das entradas somadas em `all_sessions` podem ser dela —
  // sempre 100% de sessões concorrentes, nunca uma mistura. Diferente de
  // `no_session_id` (variável de ambiente ausente — mais ambíguo, ocorre em
  // invocação manual/CLI standalone; preserva o best-effort de sempre) e
  // diferente de `--all-sessions` explícito (`opts.explicitAllSessions`,
  // pedido deliberado de análise agregada pós-hoc — o chamador SABE que está
  // pedindo a soma de tudo), aqui há certeza de contaminação total. Gravar
  // esse número seria "pior que zero" — mesma disciplina do #5475
  // (`no_usage_records_in_window` abaixo já trata isso pro caso de sessão
  // corretamente identificada mas sem turnos na janela).
  //
  // Achado ao vivo que motivou este guard: edições 260826 e 260827 — Stage 0
  // e Stage 1 rodados via `claude --print --no-session-persistence`
  // (`scripts/overnight/run-scheduled-edicao.ts`, um spawn novo por stage
  // pra contexto limpo) nunca persistem transcript em `~/.claude/projects/`.
  // `session_filter_reason` bateu `session_file_not_found` nas duas edições
  // (não `no_session_id` — a hipótese original da issue); o Stage 1 de
  // 260826 atribuiu 14,08M de tokens de duas sessões alheias antes deste fix.
  if (
    !opts.explicitAllSessions &&
    window.sessionFilter === "all_sessions" &&
    window.filterReason === "session_file_not_found"
  ) {
    return {
      source: "unavailable",
      reason: "session_filter_fallback_session_file_not_found",
      sessions_scanned: window.sessionsScanned,
      ...describeWindowFilter(window),
    };
  }

  if (window.entries.length === 0) {
    // `sessions_excluded` importa MAIS aqui do que no caminho de sucesso: a
    // sessão corrente sem turno na janela + uma concorrente COM turnos é
    // exatamente o caso em que "custo zero" e "o stage não foi medido" se
    // parecem. Omitir o campo neste branch tornaria os dois indistinguíveis —
    // que é o defeito que esta issue existe pra matar, reintroduzido no lugar
    // onde menos se olharia.
    return {
      source: "unavailable",
      reason: "no_usage_records_in_window",
      sessions_scanned: window.sessionsScanned,
      ...describeWindowFilter(window),
    };
  }

  const fallbackDateMs = editionDateMs(editionId);
  let costUsd = 0;
  let costPartial = false;
  for (const entry of window.entries) {
    const entryDateMs = new Date(entry.timestamp).getTime();
    const dateMs = Number.isFinite(entryDateMs) ? entryDateMs : fallbackDateMs;
    const usage = {
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      cache_creation_input_tokens: entry.cacheCreationInputTokens,
      cache_read_input_tokens: entry.cacheReadInputTokens,
    };
    const callCost = estimateCallCostUsd(usage, entry.model, dateMs);
    if (callCost === null) {
      costPartial = true; // modelo não-Claude (ex: Gemini) — tokens contam, custo não
      continue;
    }
    costUsd += callCost;
  }

  const models = [...new Set(window.models.map(shortModelName))].sort();

  return {
    source: "session_transcript",
    tokens_in: window.tokensIn,
    tokens_out: window.tokensOut,
    cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
    cost_partial: costPartial,
    models,
    sessions_scanned: window.sessionsScanned,
    entries_matched: window.entries.length,
    ...describeWindowFilter(window),
  };
}

async function main(): Promise<void> {
  const { values, flags } = parseArgsLib(process.argv.slice(2));
  const editionDirRaw = values["edition-dir"];
  const stageRaw = values["stage"];
  if (!editionDirRaw || !stageRaw) {
    console.error(
      "Uso: npx tsx scripts/capture-stage-usage.ts --edition-dir <path> --stage N " +
        "[--start ISO] [--end ISO] [--transcripts-dir <path>] [--dry-run] " +
        "[--session-id <id>] [--all-sessions]",
    );
    process.exit(2);
  }
  const stage = parseInt(stageRaw, 10);
  if (isNaN(stage)) {
    console.error("--stage precisa ser um número");
    process.exit(2);
  }

  const editionDir = resolve(ROOT, editionDirRaw);
  const editionId = editionDir.replace(/[/\\]$/, "").split(/[\\/]/).pop() ?? "";
  const doc = loadDoc(editionDir, editionId);
  const row: StageRow | undefined = doc.rows.find((r) => r.stage === stage);

  // `doc.rows` só cobre STAGES (0-6, ver makeInitialDoc) — um --stage fora
  // desse conjunto não tem onde persistir, mesmo que o transcript tenha dado
  // real. Falhar cedo aqui evita reportar `source: "session_transcript"`
  // (sucesso) sem gravar nada, o que seria enganoso pro caller.
  if (!row) {
    console.log(JSON.stringify({ source: "unavailable", reason: "stage_not_tracked", stage }));
    return;
  }

  const start = values["start"] ?? row.start;
  const end = values["end"] ?? row.end;
  const transcriptsDir = values["transcripts-dir"] ?? resolveTranscriptsDir(process.cwd());

  // #5413: por default conta só a sessão que invocou este script — ele roda
  // via Bash tool DE DENTRO da sessão da edição, então `CLAUDE_CODE_SESSION_ID`
  // identifica o transcript certo. `--all-sessions` recupera o comportamento
  // antigo (varre o diretório inteiro) pra uso pontual em análise pós-hoc.
  const sessionId = flags.has("all-sessions")
    ? null
    : (values["session-id"] ?? currentSessionId());

  const result = captureUsageForWindow(transcriptsDir, start, end, editionId, {
    sessionId,
    explicitAllSessions: flags.has("all-sessions"),
  });
  result.stage = stage;

  if (result.source === "unavailable") {
    console.log(JSON.stringify(result));
    return; // fail-soft: nunca bloqueia, nunca escreve dado fabricado
  }

  if (!flags.has("dry-run")) {
    const newDoc = applyUpdate(
      doc,
      {
        stage,
        status: row.status, // preserva status existente — este script nunca transiciona stage
        cost_usd: result.cost_usd,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        models: result.models,
        // #5413: a procedência viaja junto com o número. Sem isso o
        // diagnóstico existiria só no stdout desta invocação e sumiria —
        // quem investigar uma anomalia de custo semanas depois via
        // `aggregate-costs.ts` não teria como saber se o stage foi medido
        // isolado ou somando sessão concorrente.
        session_filter: result.session_filter,
        // #6170: propaga o motivo do fallback pra `all_sessions` até o
        // persist — `StageRow`/`applyUpdate` tratam a presença da chave
        // (mesmo `undefined`) como o sinal pra limpar um motivo de um
        // fallback anterior quando este `session_filter` for `current_session`.
        session_filter_reason: result.session_filter_reason,
        sessions_excluded: result.sessions_excluded,
        subagent_tokens_in: result.subagent_tokens_in,
        subagent_tokens_out: result.subagent_tokens_out,
        parse_errors: result.parse_errors,
      },
      new Date().toISOString(),
    );
    saveDoc(editionDir, newDoc);
    result.path = resolve(editionDir, "_internal", "stage-status.json");
  }

  console.log(JSON.stringify(result));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
