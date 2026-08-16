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
 * **Os números acima são de uma amostra datada (300 transcripts, harness
 * 2.1.233, 16/08/2026) — re-derivar antes de citar**, mesma disciplina do
 * #1172. Se uma versão futura do harness passar a gravar `isSidechain`, o
 * código já lida com isso sozinho (`subagentTokensIn` deixa de ser `null`);
 * é este parágrafo que vira prosa desatualizada, não o comportamento.
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
 *
 * Confirmado ao vivo no #5413: filtrando por este id, a edição 260814 saiu de
 * 1.001M pra 708M tokens, batendo stage a stage com a análise manual feita
 * por outro caminho (S4 581→424, S5 175→75, S6 62→35). Não é suposição sobre
 * o formato — o número fecha.
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
 * Heurística pra decidir se uma linha que falhou `JSON.parse` é (a) uma linha
 * de evento real do transcript CORTADA no meio por escrita concorrente — ex:
 * `capture-stage-usage.ts` lendo o mesmo arquivo que o harness ainda está
 * gravando (#5423) — ou (b) lixo/formato que nunca foi um evento JSON pra
 * começar (linha vazia truncada de outro jeito, artefato de escrita
 * corrompida sem relação com o esquema do transcript). O writer emite JSON
 * da esquerda pra direita, então uma linha truncada no meio da escrita ainda
 * preserva o prefixo correto — só falta o fechamento. Toda linha real de
 * transcript (`assistant`, `user`, `system`, `file-history-snapshot`, ...)
 * começa com o mesmo prefixo `{"type":"`; se falhar o parse mas começar
 * assim, é (a) — anômalo, merece contagem. Caso contrário é (b) — esperado,
 * pula silencioso, comportamento pré-#5423 preservado.
 */
function looksLikeTruncatedTranscriptEvent(line: string): boolean {
  return /^\s*\{"type":"/.test(line);
}

/** Resultado de `parseTranscriptFile` — entradas extraídas + diagnóstico. */
export interface ParsedTranscriptFile {
  entries: UsageEntry[];
  /**
   * Linhas que pareciam começar como um evento JSON válido (`{"type":"...`)
   * mas falharam `JSON.parse` — sinal de truncamento por escrita concorrente,
   * não de "linha de controle sem usage" (essa é JSON válido, só cai no
   * `!usage continue` abaixo, nunca chega no `catch`). Ver
   * `looksLikeTruncatedTranscriptEvent` (#5423).
   */
  parseErrors: number;
}

/**
 * Parseia um único arquivo `.jsonl` de transcript, extraindo toda entrada
 * `type: "assistant"` com `message.usage` presente. Tolera linhas sem usage —
 * pula silenciosamente (transcript tem MUITOS tipos de linha que não
 * carregam usage: `user`, `system`, `file-history-snapshot`, etc. — todas
 * JSON válido, nunca contam como erro). Linhas que falham `JSON.parse` são
 * classificadas por `looksLikeTruncatedTranscriptEvent`: as que parecem
 * truncamento real incrementam `parseErrors`; lixo genérico continua pulado
 * sem contar, como sempre foi.
 */
export function parseTranscriptFile(filePath: string): ParsedTranscriptFile {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return { entries: [], parseErrors: 0 };
  }
  const entries: UsageEntry[] = [];
  let parseErrors = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj: RawTranscriptLine;
    try {
      obj = JSON.parse(line);
    } catch {
      if (looksLikeTruncatedTranscriptEvent(line)) parseErrors++;
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
  return { entries, parseErrors };
}

/**
 * Lista todos os `.jsonl` de um diretório de transcripts (não-recursivo).
 * Diretório ausente é o caso ESPERADO (sessão cloud/worktree efêmero sem
 * `~/.claude/projects/`) — retorna `[]` sem logar. `readdirSync` falhar num
 * diretório que `existsSync` acabou de confirmar (permissão, corrida de FS)
 * é ANÔMALO — loga antes de degradar pra `[]`, em vez de virar o mesmo
 * silêncio do caso esperado (#5423 F4).
 */
export function listTranscriptFiles(transcriptsDir: string): string[] {
  if (!existsSync(transcriptsDir)) return [];
  try {
    return readdirSync(transcriptsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(transcriptsDir, f));
  } catch (err) {
    console.error(
      `session-transcript: readdirSync falhou em ${transcriptsDir} (existsSync confirmou que o diretório existia) — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

/**
 * Qual filtro de sessão valeu — união discriminada de propósito: torna
 * `{ sessionFilter: "current_session", filterReason: ... }` (um estado que
 * não existe) irrepresentável, em vez de depender de o produtor acertar dois
 * campos independentes. `all_sessions` SEMPRE carrega o motivo.
 */
export type SessionFilterMode = "current_session" | "all_sessions";
export type SessionFilterReason = "no_session_id" | "session_file_not_found";

export type SessionFilterOutcome =
  | { sessionFilter: "current_session" }
  | { sessionFilter: "all_sessions"; filterReason: SessionFilterReason };

interface UsageWindowBase {
  entries: UsageEntry[];
  sessionsScanned: number;
  tokensIn: number;
  tokensOut: number;
  models: string[];
  /**
   * Quantos OUTROS transcripts tinham turnos nesta mesma janela e ficaram de
   * fora. `0` sob `all_sessions` (nada foi excluído). Sob `current_session`,
   * um valor alto é o sinal de quanta contaminação existiria sem o filtro.
   */
  sessionsExcluded: number;
  /**
   * Tokens de subagente (`Agent()`) na janela. `null` = nenhum turno
   * sidechain observado — o que foi o caso em toda a amostra checada no
   * #5413 (300 transcripts, harness 2.1.233). `null` significa "não
   * registrado", NUNCA "custou zero".
   */
  subagentTokensIn: number | null;
  subagentTokensOut: number | null;
  /**
   * Soma de `parseErrors` (#5423) de TODOS os arquivos varridos no
   * diretório — não escopado à janela de tempo nem ao filtro de sessão,
   * porque uma linha que falhou `JSON.parse` não tem timestamp legível pra
   * comparar contra `[startIso, endIso]`. `0` é o caso normal; qualquer
   * valor > 0 é sinal de escrita concorrente cortando uma linha no meio
   * (ver `looksLikeTruncatedTranscriptEvent`), nunca de "transcript vazio".
   */
  parseErrors: number;
}

/**
 * Distribuído à mão (`(Base & A) | (Base & B)`) em vez de
 * `Base & (A | B)` — TypeScript não estreita por discriminante quando a
 * união está dentro de uma interseção, então a forma curta compila mas
 * obriga o consumidor a castear pra ler `filterReason`.
 */
export type UsageWindowResult =
  | (UsageWindowBase & { sessionFilter: "current_session" })
  | (UsageWindowBase & { sessionFilter: "all_sessions"; filterReason: SessionFilterReason });

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
 * Agrega usage das entradas que caem dentro de `[startIso, endIso]`
 * (inclusive).
 *
 * **Quais arquivos entram depende de `opts.sessionId` (#5413):** com um id
 * que casa com um transcript do diretório, só ELE é somado
 * (`sessionFilter: "current_session"`) — é o caminho default em produção,
 * resolvido pelo CLI via `currentSessionId()`. Sem id, ou com um id que não
 * casa com arquivo nenhum, varre TODOS os `.jsonl` do diretório
 * (`sessionFilter: "all_sessions"` + `filterReason`), que é o comportamento
 * pré-#5413 e pode misturar sessões Claude Code concorrentes no mesmo repo.
 * `sessionsExcluded` diz quantos transcritos tinham turnos nesta janela e
 * ficaram de fora.
 *
 * `tokensIn` = soma de input + cache_creation + cache_read (convenção
 * "billed input tokens" — todos os 3 são cobrados no request, mesmo que a
 * taxas diferentes; ver `scripts/lib/pricing.ts` pra como isso vira custo).
 * `tokensOut` = soma de output. `models` = lista de model strings distintos
 * observados.
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
  // Construído numa expressão só: a união discriminada não deixa os dois
  // campos saírem de sincronia, mas isso só vale se o valor nascer inteiro em
  // vez de montado por `let`s independentes.
  const outcome: SessionFilterOutcome = !wanted
    ? { sessionFilter: "all_sessions", filterReason: "no_session_id" }
    : files.includes(wanted)
      ? { sessionFilter: "current_session" }
      : { sessionFilter: "all_sessions", filterReason: "session_file_not_found" };

  const entries: UsageEntry[] = [];
  const excluded = new Set<string>();
  let parseErrors = 0;
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    for (const file of files) {
      const keep = outcome.sessionFilter === "all_sessions" || file === wanted;
      const parsed = parseTranscriptFile(file);
      // Somado incondicionalmente (não só pros arquivos `keep`) — mesma
      // convenção de `sessionsScanned`, que também conta o diretório inteiro
      // independente do filtro de sessão.
      parseErrors += parsed.parseErrors;
      for (const entry of parsed.entries) {
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
    ...outcome,
    sessionsExcluded: excluded.size,
    subagentTokensIn: sawSidechain ? subIn : null,
    subagentTokensOut: sawSidechain ? subOut : null,
    parseErrors,
  };
}
