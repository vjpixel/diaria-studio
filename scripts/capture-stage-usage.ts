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
 * que fica como gap conhecido (subagentes com `isolation: "worktree"`).
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
import { collectUsageInWindow, resolveTranscriptsDir } from "./lib/session-transcript.ts";
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
): CaptureResult {
  if (!start || !end) {
    return { source: "unavailable", reason: "missing_stage_timestamps" };
  }
  if (!existsSync(transcriptsDir)) {
    return { source: "unavailable", reason: "no_local_transcripts_dir" };
  }
  const window = collectUsageInWindow(transcriptsDir, start, end);
  if (window.entries.length === 0) {
    return {
      source: "unavailable",
      reason: "no_usage_records_in_window",
      sessions_scanned: window.sessionsScanned,
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
  };
}

async function main(): Promise<void> {
  const { values, flags } = parseArgsLib(process.argv.slice(2));
  const editionDirRaw = values["edition-dir"];
  const stageRaw = values["stage"];
  if (!editionDirRaw || !stageRaw) {
    console.error(
      "Uso: npx tsx scripts/capture-stage-usage.ts --edition-dir <path> --stage N " +
        "[--start ISO] [--end ISO] [--transcripts-dir <path>] [--dry-run]",
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

  const start = values["start"] ?? row?.start;
  const end = values["end"] ?? row?.end;
  const transcriptsDir = values["transcripts-dir"] ?? resolveTranscriptsDir(process.cwd());

  const result = captureUsageForWindow(transcriptsDir, start, end, editionId);
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
        status: row?.status ?? "done", // preserva status existente — este script nunca transiciona stage
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
