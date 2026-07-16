/**
 * session-transcript.ts (#3441)
 *
 * Captura REAL de token usage por stage, via parsing pós-hoc do transcript
 * da sessão Claude Code local (Opção 1 da issue #3441 "Opções a avaliar").
 *
 * O harness Claude Code grava o transcript de toda sessão em
 * `~/.claude/projects/{encoded-cwd}/{sessionId}.jsonl` — cada linha
 * `type: "assistant"` carrega `message.usage` com `input_tokens`,
 * `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`
 * e `message.model` (verificado manualmente inspecionando um transcript real
 * em 260716 durante a implementação desta issue — ver PR body). Isso é dado
 * REAL, não estimado: os números vêm de `usage` retornado pela API, não de
 * contagem de tool calls nem de médias por tier.
 *
 * `{encoded-cwd}` = `cwd.replace(/[:\\/]/g, "-")` — mesmo esquema usado pelo
 * harness pra nomear o diretório de projeto (confirmado empiricamente:
 * `C:\Users\x\Projects\diaria-studio` → `C--Users-x-Projects-diaria-studio`).
 *
 * Limitação honesta (documentada, não escondida — mesma disciplina de
 * `coordinator_tokens_estimate`/`subagent_metrics` do overnight/develop,
 * #3453/#3454): subagentes despachados via `Agent()` SEM `isolation:
 * "worktree"` escrevem no MESMO diretório de projeto (mesmo cwd) — suas
 * sessões aparecem como arquivos `.jsonl` adicionais nesse diretório, dentro
 * da mesma janela de tempo do stage, e SÃO capturados por
 * `collectUsageInWindow` (que varre TODOS os arquivos do diretório, não só o
 * da sessão corrente). Subagentes com `isolation: "worktree"` escrevem num
 * cwd diferente → diretório de projeto diferente → NÃO capturados (gap
 * conhecido, documentado no PR). Sessões concorrentes não relacionadas ao
 * pipeline que rodarem no MESMO diretório de projeto durante a mesma janela
 * (ex: editor abre um terminal Claude Code separado no repo enquanto uma
 * edição roda) inflam o número — mitigado mas não eliminado pela janela de
 * tempo estreita (start/end do próprio stage).
 *
 * Requer `~/.claude/projects/` — só existe em sessão LOCAL (não em
 * cloud/worktree efêmero), consistente com o label `local` da issue #3441
 * (ver CLAUDE.md § Label `local`).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UsageEntry {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  sessionFile: string;
}

/** `~/.claude/projects` — raiz de todos os diretórios de projeto do harness. */
export function claudeProjectsDir(homeDir: string = homedir()): string {
  return join(homeDir, ".claude", "projects");
}

/**
 * Codifica um path de cwd no nome de diretório que o harness usa sob
 * `~/.claude/projects/` — substitui `:`, `\` e `/` por `-`.
 * Ex: `C:\Users\x\Projects\diaria-studio` → `C--Users-x-Projects-diaria-studio`.
 */
export function encodeProjectDirName(cwd: string): string {
  return cwd.replace(/[:\\/]/g, "-");
}

/** Resolve o diretório de transcripts pra um cwd (default: `process.cwd()`). */
export function resolveTranscriptsDir(
  cwd: string = process.cwd(),
  homeDir: string = homedir(),
): string {
  return join(claudeProjectsDir(homeDir), encodeProjectDirName(cwd));
}

interface RawTranscriptLine {
  type?: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/**
 * Parseia um único arquivo `.jsonl` de transcript, extraindo toda entrada
 * `type: "assistant"` com `message.usage` presente. Tolera linhas corrompidas
 * (JSON.parse falho) e linhas sem usage — pula silenciosamente (transcript
 * tem MUITOS tipos de linha que não carregam usage: `user`, `system`,
 * `file-history-snapshot`, etc.).
 */
export function parseTranscriptFile(filePath: string): UsageEntry[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const entries: UsageEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj: RawTranscriptLine;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const usage = obj.message?.usage;
    if (!usage) continue;
    const timestamp = obj.timestamp;
    if (!timestamp) continue;
    entries.push({
      timestamp,
      model: obj.message?.model ?? "unknown",
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      sessionFile: filePath,
    });
  }
  return entries;
}

/** Lista todos os `.jsonl` de um diretório de transcripts (não-recursivo). */
export function listTranscriptFiles(transcriptsDir: string): string[] {
  if (!existsSync(transcriptsDir)) return [];
  try {
    return readdirSync(transcriptsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(transcriptsDir, f));
  } catch {
    return [];
  }
}

export interface UsageWindowResult {
  entries: UsageEntry[];
  sessionsScanned: number;
  tokensIn: number;
  tokensOut: number;
  models: string[];
}

/**
 * Agrega usage de TODOS os arquivos `.jsonl` do diretório cujas entradas
 * caem dentro de `[startIso, endIso]` (inclusive). `tokensIn` = soma de
 * input + cache_creation + cache_read (convenção "billed input tokens" —
 * todos os 3 são cobrados no request, mesmo que a taxas diferentes; ver
 * `scripts/lib/pricing.ts` pra como isso vira custo). `tokensOut` = soma de
 * output. `models` = lista de model strings distintos observados.
 */
export function collectUsageInWindow(
  transcriptsDir: string,
  startIso: string,
  endIso: string,
): UsageWindowResult {
  const files = listTranscriptFiles(transcriptsDir);
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();

  const entries: UsageEntry[] = [];
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    for (const file of files) {
      for (const entry of parseTranscriptFile(file)) {
        const ts = new Date(entry.timestamp).getTime();
        if (!Number.isFinite(ts)) continue;
        if (ts >= startMs && ts <= endMs) entries.push(entry);
      }
    }
  }

  let tokensIn = 0;
  let tokensOut = 0;
  const modelSet = new Set<string>();
  for (const e of entries) {
    tokensIn += e.inputTokens + e.cacheCreationInputTokens + e.cacheReadInputTokens;
    tokensOut += e.outputTokens;
    modelSet.add(e.model);
  }

  return {
    entries,
    sessionsScanned: files.length,
    tokensIn,
    tokensOut,
    models: [...modelSet],
  };
}
