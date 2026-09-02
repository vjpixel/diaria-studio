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
 * ## Duas limitações, medidas no #5413 (16/08/2026) — uma delas fechada no #7084
 *
 * A versão original deste módulo afirmava que subagentes despachados via
 * `Agent()` sem `isolation: "worktree"` ERAM capturados por
 * `collectUsageInWindow`. **Isso era falso** no harness 2.1.233: varredura
 * dos 300 `.jsonl` do diretório de projeto não achou UM único turno com
 * `isSidechain: true` — a edição 260814 teve 44 dispatches de `Agent()` cujo
 * custo não aparecia em número algum.
 *
 * 1. **Conta a menos — fechada no #7084 (02/09/2026).** O harness passou a
 *    gravar o transcript de CADA subagente em arquivo próprio,
 *    `{transcriptsDir}/{sessionId}/subagents/agent-{agentId}.jsonl`
 *    (companheiro `.meta.json` com `agentType`/`model`/`spawnDepth` — não lido
 *    por este módulo), com `isSidechain: true` desde a 1ª linha e
 *    `message.usage` por turno no MESMO formato do transcript principal —
 *    confirmado ao vivo inspecionando os subagentes desta própria rodada.
 *    `collectUsageInWindow` nunca olhava esse subdiretório (só listava os
 *    `.jsonl` soltos na raiz de `transcriptsDir`), por isso
 *    `subagentTokensIn/Out` saíam sempre `null` mesmo com o dado já
 *    existindo em disco — não era um buraco de instrumentação do harness, e
 *    sim um glob incompleto deste parser. Agora `listSubagentTranscriptFiles`
 *    varre esse subdiretório pra cada sessão escaneada (a "dona" — a mesma
 *    decidida por `sessionFilter` — decide se as entradas do subagente
 *    entram como `keep` ou como excluídas, igual ao arquivo-pai) e as
 *    entradas somam em `subagentTokensIn/Out` pela MESMA lógica de sempre
 *    (`entry.isSidechain`, que já vinha `true` nesses arquivos — nenhuma
 *    mudança no parser). `subagentTokensIn/Out` continuam `null` só quando
 *    a janela do stage genuinamente não teve nenhum turno de subagente (sem
 *    dispatch de `Agent()`, ou dispatch fora da janela) — não mais "nunca
 *    registrado pelo harness".
 *
 *    **Achado colateral, contradiz a frase de baixo desta seção pré-#7084:**
 *    subagentes com `isolation: "worktree"` TAMBÉM aparecem em
 *    `{sessionId}/subagents/` do coordenador — o harness grava o transcript
 *    do lado do processo que despachou, não do cwd onde o filho roda; os
 *    `.meta.json` desses arquivos carregam `worktreePath`/
 *    `spawnedWithWorktree: true` junto com `isSidechain: true` no `.jsonl`
 *    irmão (confirmado ao vivo, 304 exemplos no diretório de projeto local
 *    nesta máquina em 02/09/2026). Isolamento de worktree deixou de ser
 *    motivo de não-captura.
 *
 *    **Não confundir com `subagent_tokens` do bloco `<usage>` reportado pelo
 *    harness ao FIM de um dispatch `Agent()`** (consumido por
 *    `scripts/aggregate-session-tokens.ts`/`scripts/lib/edition-cost.ts`,
 *    caminho overnight/develop) — as duas fontes medem coisas parecidas mas
 *    não idênticas, então não é esperado que batam: `subagent_tokens`
 *    **inclui `cache_read`** mas é uma APROXIMAÇÃO do turno FINAL do
 *    subagente, não a soma de todos os turnos internos (confirmado
 *    empiricamente no #6633/#7082). `subagentTokensIn/Out` deste módulo é a
 *    SOMA real de `input + cache_creation + cache_read` de TODOS os turnos
 *    do arquivo do subagente na janela — tende a ficar IGUAL ou MAIOR que o
 *    `subagent_tokens` do harness pro mesmo dispatch (maior sempre que o
 *    subagente teve mais de 1 turno), nunca menor por definição. Divergência
 *    entre os dois nunca é bug de um dos dois — é a mesma distinção de
 *    "aproximação do turno final" vs. "soma de todos os turnos".
 *
 * 2. **Conta a mais (corrigida no #5413, sem relação com o #7084 acima):**
 *    varrer TODOS os arquivos do diretório faz a janela de tempo do stage
 *    capturar qualquer sessão Claude Code concorrente no mesmo repo. Medido
 *    na 260814: dos 1.001M tokens atribuídos, 303M (29%) vieram de 5 sessões
 *    humanas paralelas, duas delas em branches de feature. O default é
 *    filtrar pela sessão corrente (`CLAUDE_CODE_SESSION_ID`, exposto pelo
 *    harness no ambiente do Bash tool); o comportamento antigo continua
 *    alcançável via `sessionId: null` explícito, e o resultado sempre diz
 *    qual dos dois valeu (`sessionFilter`) e quantas sessões foram ignoradas
 *    (`sessionsExcluded`).
 *
 * **O número de amostra do #7084 acima (304 arquivos worktree, harness
 * 2.1.258, 02/09/2026) é datado — re-derivar antes de citar**, mesma
 * disciplina do #1172. Se uma versão futura do harness mudar o path
 * (`subagents/`) ou o formato, é este parágrafo que vira prosa
 * desatualizada — `listSubagentTranscriptFiles`/`parseTranscriptFile` é
 * onde ajustar.
 *
 * Requer `~/.claude/projects/` — só existe em sessão LOCAL (não em
 * cloud/worktree efêmero), consistente com o label `local` da issue #3441
 * (ver CLAUDE.md § Label `local`).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface UsageEntry {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  sessionFile: string;
  /**
   * `true` = turno de subagente (`Agent()`). Desde o #7084, o caso comum é
   * uma entrada lida de `{sessionId}/subagents/agent-{agentId}.jsonl` (o
   * harness marca `isSidechain: true` desde a 1ª linha desses arquivos); o
   * caso de uma entrada `isSidechain: true` gravada INLINE dentro do
   * transcript principal (hipótese original deste campo, nunca observada no
   * harness 2.1.233 — ver #5413 no cabeçalho) continua lido do mesmo jeito,
   * sem tratamento especial — os dois caminhos convergem no mesmo campo.
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
 * preserva o prefixo correto — só falta o fechamento.
 *
 * **Não ancorado à posição exata de `"type"`** (self-review: o header deste
 * módulo documenta os CAMPOS de uma linha de evento — `type`, `timestamp`,
 * `isSidechain`, `message` — mas nunca a ORDEM em que o harness os grava;
 * exigir `{"type":"` logo no início do objeto seria frágil contra qualquer
 * reordenação real, ex: `uuid`/`parentUuid`/`sessionId` antes de `type`).
 * Em vez disso, checa objeto (`{` no início) + substring `"type":"` em
 * qualquer posição visível na parte não cortada da linha — sinal mais fraco
 * de posição, mas resiliente a ordem de campo, e ainda distingue de lixo que
 * nunca foi um evento JSON (não abre `{`, ou não tem `type` nenhum).
 */
function looksLikeTruncatedTranscriptEvent(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("{") && /"type"\s*:\s*"/.test(trimmed);
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
 * Lista os transcripts de subagente (`Agent()`) despachados por UMA sessão —
 * `{transcriptsDir}/{sessionId}/subagents/*.jsonl` (#7084). Cada subagente
 * ganha arquivo próprio (`agent-{agentId}.jsonl` + `.meta.json` companheiro,
 * este último não lido aqui), `isSidechain: true` desde a 1ª linha, no MESMO
 * formato de linha que `parseTranscriptFile` já sabe ler — não precisou de
 * nenhuma mudança no parser, só descobrir o arquivo. Cobre subagentes com
 * `isolation: "worktree"` também — o harness grava esse transcript do lado
 * do processo que despachou, não do cwd onde o filho roda (achado do #7084,
 * ver cabeçalho do módulo).
 *
 * Diretório ausente é o caso comum (sessão sem nenhum dispatch de `Agent()`,
 * ou sessão de um harness anterior ao #7084) — `[]` sem logar, delegado a
 * `listTranscriptFiles` (mesma convenção: só readdirSync falhando num path
 * que existsSync confirmou existir é anômalo e loga).
 */
export function listSubagentTranscriptFiles(transcriptsDir: string, sessionId: string): string[] {
  return listTranscriptFiles(join(transcriptsDir, sessionId, "subagents"));
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
   * Tokens de subagente (`Agent()`) na janela — soma de TODOS os turnos
   * marcados `isSidechain: true`, tanto os lidos de
   * `{sessionId}/subagents/*.jsonl` (caso comum desde o #7084) quanto um
   * eventual turno sidechain gravado inline no transcript principal (nunca
   * observado até hoje, ver #5413 no cabeçalho — o parser trata os dois
   * igual). `null` = nenhum turno sidechain observado NESTA JANELA — sem
   * dispatch de `Agent()` no stage, ou dispatch fora do intervalo `[start,
   * end]`. `null` significa "sem subagente nesta janela", NUNCA "custou
   * zero" nem "harness não registra".
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
 * ficaram de fora. **Desde o #7084, cada `.jsonl` de sessão escaneado
 * (pertença ao dono ou a uma sessão excluída) também puxa junto
 * `{esse sessionId}/subagents/*.jsonl`** (`listSubagentTranscriptFiles`) —
 * essas entradas herdam o mesmo `keep`/exclusão do arquivo-pai, então um
 * subagente de uma sessão CONCORRENTE excluída continua excluído, nunca
 * conta como uma exclusão A MAIS em `sessionsExcluded` (a contagem é por
 * sessão, não por arquivo escaneado).
 *
 * `tokensIn` = soma de input + cache_creation + cache_read (convenção
 * "billed input tokens" — todos os 3 são cobrados no request, mesmo que a
 * taxas diferentes; ver `scripts/lib/pricing.ts` pra como isso vira custo).
 * `tokensOut` = soma de output. `models` = lista de model strings distintos
 * observados. `subagentTokensIn/Out` é a fatia desses totais que veio de
 * turno `isSidechain` (ver doc do campo) — decomposição, não exclusão: já
 * está dentro de `tokensIn`/`tokensOut`, não soma por fora.
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
  // `parseErrors` (#5423) não é escopado à janela de tempo — uma linha
  // truncada não tem timestamp legível pra comparar contra
  // `[startIso, endIso]` (ver doc de `UsageWindowBase.parseErrors` acima).
  // Por isso a contagem roda incondicionalmente, mesmo quando os
  // timestamps de janela são inválidos; só a filtragem de `entries` por
  // `[startMs, endMs]` (que SIM depende de janela válida) fica atrás do
  // guard `Number.isFinite`.
  const windowValid = Number.isFinite(startMs) && Number.isFinite(endMs);
  for (const file of files) {
    const keep = outcome.sessionFilter === "all_sessions" || file === wanted;
    // #7084: os transcripts de subagente da SESSÃO DONA de `file` (mesmo
    // sessionId, arquivo `{sessionId}.jsonl` → diretório irmão
    // `{sessionId}/subagents/`) escalam junto com `file` — mesmo `keep`.
    // No `excluded.add(file)` abaixo, a chave é sempre o arquivo-pai `file`
    // do loop externo, NUNCA `scanFile` (que pode ser um `.jsonl` de
    // subagente) — senão uma sessão excluída com N subagentes contaria como
    // N sessões excluídas em vez de 1.
    const sessionIdForFile = basename(file, ".jsonl");
    const subagentFiles = listSubagentTranscriptFiles(transcriptsDir, sessionIdForFile);
    for (const scanFile of [file, ...subagentFiles]) {
      const parsed = parseTranscriptFile(scanFile);
      // Somado incondicionalmente (não só pros arquivos `keep`) — mesma
      // convenção de `sessionsScanned`, que também conta o diretório inteiro
      // independente do filtro de sessão.
      parseErrors += parsed.parseErrors;
      if (!windowValid) continue;
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
