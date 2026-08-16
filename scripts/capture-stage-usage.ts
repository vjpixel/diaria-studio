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
 * local, sem entradas de usage na janela) imprime `source: "unavailable"` +
 * `reason` e sai com status 0 — NUNCA escreve zero/null como se fosse dado
 * real, e nunca bloqueia o pipeline.
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
  session_filter?: UsageWindowResult["sessionFilter"];
  session_filter_reason?: UsageWindowResult["filterReason"];
  /** Sessões concorrentes com turnos na mesma janela que ficaram de fora. */
  sessions_excluded?: number;
  /**
   * `null` = custo de subagente NÃO REGISTRADO pelo harness, não zero. Campo
   * explícito de propósito: antes do #5413 esse buraco ficava somido dentro
   * de `tokens_in`, que era lido como "o custo do stage".
   */
  subagent_tokens_in?: number | null;
  subagent_tokens_out?: number | null;
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
  opts: CollectUsageOptions = {},
): CaptureResult {
  if (!start || !end) {
    return { source: "unavailable", reason: "missing_stage_timestamps" };
  }
  if (!existsSync(transcriptsDir)) {
    return { source: "unavailable", reason: "no_local_transcripts_dir" };
  }
  const window = collectUsageInWindow(transcriptsDir, start, end, opts);
  if (window.entries.length === 0) {
    return {
      source: "unavailable",
      reason: "no_usage_records_in_window",
      sessions_scanned: window.sessionsScanned,
      session_filter: window.sessionFilter,
      ...(window.filterReason ? { session_filter_reason: window.filterReason } : {}),
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
    session_filter: window.sessionFilter,
    ...(window.filterReason ? { session_filter_reason: window.filterReason } : {}),
    sessions_excluded: window.sessionsExcluded,
    subagent_tokens_in: window.subagentTokensIn,
    subagent_tokens_out: window.subagentTokensOut,
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

  const result = captureUsageForWindow(transcriptsDir, start, end, editionId, { sessionId });
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
