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
 * ## Duas limitações, medidas no #5413 (16/08/2026) — corrigido o que dava
 *
 * A versão original deste módulo afirmava que subagentes despachados via
 * `Agent()` sem `isolation: "worktree"` ERAM capturados por
 * `collectUsageInWindow`. **Isso é falso** no harness 2.1.233: varredura dos
 * 300 `.jsonl` do diretório de projeto não achou UM único turno com
 * `isSidechain: true`. O custo de subagente não está registrado em transcript
 * nenhum — a edição 260814 teve 44 dispatches de `Agent()` cujo custo não
 * aparece em número algum.
 *
 * 1. **Conta a menos (não corrigível aqui):** subagente não é registrado.
 *    Em vez de deixar o buraco somido dentro de um número rotulado como
 *    custo do stage, `collectUsageInWindow` agora devolve
 *    `subagentTokensIn/Out` explicitamente — `null` quando nenhum turno
 *    sidechain foi observado. Se o harness voltar a gravá-los, o campo passa
 *    a somar sozinho (a leitura já está no parser).
 *
 * 2. **Conta a mais (corrigida):** varrer TODOS os arquivos do diretório faz
 *    a janela de tempo do stage capturar qualquer sessão Claude Code
 *    concorrente no mesmo repo. Medido na 260814: dos 1.001M tokens
 *    atribuídos, 303M (29%) vieram de 5 sessões humanas paralelas, duas
 *    delas em branches de feature. Agora o default é filtrar pela sessão
 *    corrente (`CLAUDE_CODE_SESSION_ID`, exposto pelo harness no ambiente do
 *    Bash tool); o comportamento antigo continua alcançável via `sessionId:
 *    null` explícito, e o resultado sempre diz qual dos dois valeu
 *    (`sessionFilter`) e quantas sessões foram ignoradas
 *    (`sessionsExcluded`).
 *
 * Subagentes com `isolation: "worktree"` escrevem num cwd diferente →
 * diretório de projeto diferente → também não capturados.
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
  /**
   * `true` = turno de subagente (`Agent()`) gravado dentro do transcript do
   * pai. Nunca observado no harness 2.1.233 (ver #5413 no cabeçalho); a
   * leitura existe para o dia em que voltar a ser gravado.
   */
  isSidechain: boolean;
}

/**
 * Id da sessão Claude Code corrente, exposto pelo harness no ambiente de todo
 * comando do Bash tool. É o nome do arquivo de transcript (`{id}.jsonl`), o
 * que permite a um script rodado de dentro da sessão saber qual transcript é
 * o seu. `null` quando ausente (sessão não-Claude, teste, harness antigo).
 */
export function currentSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.CLAUDE_CODE_SESSION_ID;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
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
  isSidechain?: boolean;
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
      isSidechain: obj.isSidechain === true,
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
  /**
   * `current_session` = só o transcript da sessão pedida entrou na conta.
   * `all_sessions` = TODOS os arquivos do diretório entraram — o número pode
   * incluir sessões Claude Code concorrentes no mesmo repo (#5413).
   */
  sessionFilter: "current_session" | "all_sessions";
  /** Por que caiu em `all_sessions`. Ausente quando o filtro valeu. */
  filterReason?: "no_session_id" | "session_file_not_found";
  /**
   * Quantos OUTROS transcripts tinham turnos nesta mesma janela e ficaram de
   * fora. `0` sob `all_sessions` (nada foi excluído). Sob `current_session`,
   * um valor alto é o sinal de quanta contaminação existiria sem o filtro.
   */
  sessionsExcluded: number;
  /**
   * Tokens de subagente (`Agent()`) na janela. `null` = nenhum turno
   * sidechain observado — que é o caso em 100% dos transcripts do harness
   * 2.1.233. `null` significa "não registrado", NUNCA "custou zero" (#5413).
   */
  subagentTokensIn: number | null;
  subagentTokensOut: number | null;
}

export interface CollectUsageOptions {
  /**
   * Restringe a conta ao transcript `{sessionId}.jsonl`. `null`/omitido varre
   * o diretório inteiro (comportamento pré-#5413, sujeito a contaminação por
   * sessão concorrente). O CLI resolve isto via `currentSessionId()`; o núcleo
   * não lê env, pra continuar testável.
   */
  sessionId?: string | null;
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
  opts: CollectUsageOptions = {},
): UsageWindowResult {
  const files = listTranscriptFiles(transcriptsDir);
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();

  // Resolve o alvo do filtro ANTES de ler qualquer arquivo. Um sessionId que
  // não corresponde a nenhum transcript cai em `all_sessions` com motivo
  // explícito — nunca devolve vazio silencioso (seria indistinguível de
  // "stage sem atividade") nem volta ao comportamento antigo sem avisar.
  const wanted = opts.sessionId ? join(transcriptsDir, `${opts.sessionId}.jsonl`) : null;
  let sessionFilter: UsageWindowResult["sessionFilter"] = "all_sessions";
  let filterReason: UsageWindowResult["filterReason"];
  if (!wanted) {
    filterReason = "no_session_id";
  } else if (files.includes(wanted)) {
    sessionFilter = "current_session";
  } else {
    filterReason = "session_file_not_found";
  }

  const entries: UsageEntry[] = [];
  const excluded = new Set<string>();
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    for (const file of files) {
      const keep = sessionFilter === "all_sessions" || file === wanted;
      for (const entry of parseTranscriptFile(file)) {
        const ts = new Date(entry.timestamp).getTime();
        if (!Number.isFinite(ts)) continue;
        if (ts < startMs || ts > endMs) continue;
        if (keep) entries.push(entry);
        else excluded.add(file);
      }
    }
  }

  let tokensIn = 0;
  let tokensOut = 0;
  let subIn = 0;
  let subOut = 0;
  let sawSidechain = false;
  const modelSet = new Set<string>();
  for (const e of entries) {
    const billedIn = e.inputTokens + e.cacheCreationInputTokens + e.cacheReadInputTokens;
    tokensIn += billedIn;
    tokensOut += e.outputTokens;
    modelSet.add(e.model);
    if (e.isSidechain) {
      sawSidechain = true;
      subIn += billedIn;
      subOut += e.outputTokens;
    }
  }

  return {
    entries,
    sessionsScanned: files.length,
    tokensIn,
    tokensOut,
    models: [...modelSet],
    sessionFilter,
    ...(filterReason ? { filterReason } : {}),
    sessionsExcluded: excluded.size,
    subagentTokensIn: sawSidechain ? subIn : null,
    subagentTokensOut: sawSidechain ? subOut : null,
  };
}
