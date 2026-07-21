/**
 * studio-chat.ts (#3556, fatia 2 do epic "Studio UI" #3554)
 *
 * Fundação do chat drawer: uma sessão Claude real (Claude Agent SDK) embutida
 * no studio-server, com streaming de tokens + visibilidade de tool calls pro
 * browser via SSE (mesmo transporte de `/api/events`, ver `sse.ts`).
 *
 * Dividido em 3 camadas, na mesma disciplina de `studio-issues.ts` (#3562):
 *   - funções PURAS, testáveis sem tocar o SDK real: `parseChatRequestBody`
 *     (validação do corpo de `POST /api/chat`), `sdkMessageToChatEvents`
 *     (contrato de tradução SDKMessage -> evento de wire simplificado),
 *     `describeChatError` (mensagens fail-soft legíveis).
 *   - estado de sessão em memória por `rootDir` (`getSessionId`/`setSessionId`/
 *     `clearSession`) — 1 sessão "ad-hoc" por processo do studio-server,
 *     igual ao esboço do #3554 ("1 sessão persistente por dia de trabalho").
 *     Persistência via `resume` do próprio SDK (a sessão sobrevive num
 *     arquivo JSONL do Claude Code) — o valor guardado aqui é só o ponteiro
 *     (session_id) pro turno seguinte; se o processo do studio-server reiniciar,
 *     o cliente reenvia o `sessionId` que guardou (localStorage) e o SDK
 *     resolve o resume normalmente.
 *   - `runChatTurn` — I/O real: invoca `query()` do Claude Agent SDK e traduz
 *     cada mensagem em eventos de wire via `onEvent`. `queryFn` é injetável
 *     (mesmo padrão de `ghRun` em studio-issues.ts) pra testes rodarem sem
 *     spawnar o CLI de verdade.
 *
 * Fail-soft (#738/CLAUDE.md): qualquer erro do SDK (binário do Claude Code
 * ausente, sessão não-autenticada, rate limit, abort) vira um evento
 * `chat-error` no stream — nunca derruba o processo do studio-server nem a
 * request HTTP.
 *
 * #3687 (contexto do painel): o chat drawer é injetado em toda página do
 * Studio, mas até aqui a sessão SDK não sabia qual edição/arquivo/aba
 * estavam abertos no painel ao lado — referências implícitas do editor
 * ("passe a Clarice nesse texto") não resolviam sozinhas. `ChatPanelContext`
 * (edição/arquivo/aba, todos opcionais) chega no corpo de `POST /api/chat`
 * (`ChatRequest.context`, populado client-side por `chat-drawer.js`
 * `setContext` — chamado pelas páginas que têm esse estado, ex: `revisao.js`
 * a cada `renderTabs()`) e `buildChatPrompt` o serializa como um bloco
 * `[Contexto do painel Studio: ...]` prefixado ANTES da mensagem do editor
 * no `prompt` enviado ao SDK — nunca na bolha visível do chat (a UI mostra
 * só o texto que o editor digitou). Como o contexto viaja em CADA turno (não
 * só na abertura da sessão), atualiza dinamicamente conforme o editor troca
 * de edição/arquivo/aba entre mensagens, sem exigir um evento de
 * sincronização à parte.
 *
 * #3557 (gates): qualquer tool call que exigiria um prompt interativo (ou
 * seja, não já pré-aprovado por `.claude/settings.json`/`allowedTools`)
 * continua NEGADA — EXCETO `AskUserQuestion`, escopo estrito desta fatia.
 * Quando o modelo chama `AskUserQuestion`, `makeInteractiveCanUseTool`
 * (abaixo) NÃO nega: serializa `questions[]` num evento de wire
 * `chat-permission-request`, guarda a Promise de resolução do `canUseTool`
 * num Map em memória (por `rootDir`, chaveado por `toolUseID` — o mesmo id
 * já usado pelos eventos `chat-tool`) e a devolve PENDENTE — sem timeout,
 * mesma semântica bloqueante de `AskUserQuestion` no terminal
 * (`askUserQuestionTimeout` do SDK, não setado aqui, default é `never`). A
 * rota `POST /api/chat/answer` (`server.ts`) resolve essa Promise chamando
 * `resolvePendingPermissionRequest`, que devolve `{behavior:'allow',
 * updatedInput}` — `updatedInput` espelha o shape de `AskUserQuestionOutput`
 * (`questions` ecoado + `answers`/`response`), a única forma documentada no
 * `.d.ts` do SDK de casar uma resposta headless a essa tool call
 * (`PermissionResult.updatedInput`; ver `buildAskUserQuestionUpdatedInput`).
 * Qualquer OUTRA tool call (Bash, Edit, etc.) permanece negada sempre —
 * ampliar esse escopo é fora desta issue (ver corpo do #3557).
 */

import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

// ─── contrato de wire (testável sem SDK real) ──────────────────────────────

export interface ChatInitEvent {
  event: "chat-init";
  data: { sessionId: string; model: string; cwd: string };
}
export interface ChatDeltaEvent {
  event: "chat-delta";
  data: { text: string };
}
export interface ChatToolStartEvent {
  event: "chat-tool";
  data: { toolUseId: string; name: string; status: "start"; input: unknown };
}
export interface ChatToolEndEvent {
  event: "chat-tool";
  data: { toolUseId: string; status: "end"; isError: boolean };
}
export interface ChatToolDeniedEvent {
  event: "chat-tool";
  data: { toolUseId: string; name: string; status: "denied"; reason: string };
}
export interface ChatPermissionOption {
  label: string;
  description: string;
  preview?: string;
}
export interface ChatPermissionQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: ChatPermissionOption[];
}
/** #3557: emitido quando o modelo chama `AskUserQuestion` — o browser
 * renderiza `data.questions` como form/cards (single/multi-select + campo
 * livre "Other") e responde via `POST /api/chat/answer` com `toolUseId`. Sem
 * timeout por design (ver doc-comment do módulo); `askedAt` (epoch ms) deixa
 * o cliente calcular "esperando há Xmin" localmente. */
export interface ChatPermissionRequestEvent {
  event: "chat-permission-request";
  data: { toolUseId: string; questions: ChatPermissionQuestion[]; askedAt: number };
}
/** #3804 (follow-up do #3557): emitido quando a sessão do drawer chama uma
 * tool que NÃO é `AskUserQuestion` e que não está pré-aprovada por
 * `.claude/settings.json`/`allowedTools` (ex: um `Bash` com sintaxe fora dos
 * padrões do allowlist — o caso que travava `/diaria-edicao` rodado pelo
 * drawer). Em vez de negar direto (comportamento do #3557), o browser
 * renderiza um card aprovar/negar mostrando `toolName` + um preview legível
 * de `input`, e responde via `POST /api/chat/tool-decision`. Sem timeout,
 * mesma semântica bloqueante do gate de `AskUserQuestion`. */
export interface ChatToolPermissionRequestEvent {
  event: "chat-tool-permission-request";
  data: { toolUseId: string; toolName: string; input: unknown; askedAt: number };
}
export interface ChatDoneEvent {
  event: "chat-done";
  data: { sessionId: string | null; isError: boolean; result: string | null };
}
export interface ChatErrorEvent {
  event: "chat-error";
  data: { message: string };
}

export type ChatWireEvent =
  | ChatInitEvent
  | ChatDeltaEvent
  | ChatToolStartEvent
  | ChatToolEndEvent
  | ChatToolDeniedEvent
  | ChatPermissionRequestEvent
  | ChatToolPermissionRequestEvent
  | ChatDoneEvent
  | ChatErrorEvent;

// ─── contexto do painel (#3687) ─────────────────────────────────────────────

/**
 * Estado do painel Studio no momento do turno — edição/arquivo/aba ativos,
 * tal como o header da página os mostra (ver `revisao.js` `renderTabs()`).
 * Todos os campos são opcionais: uma página sem esse conceito (ex:
 * triagem/apoios/rodada, que não abrem uma edição) simplesmente não chama
 * `setContext` no cliente, e o turno segue sem bloco de contexto — nunca um
 * requisito bloqueante pro chat funcionar.
 */
export interface ChatPanelContext {
  /** AAMMDD da edição aberta (ex: "260720") — como aparece no header "Edição". */
  edition?: string;
  /** Arquivo do stage selecionado (ex: "02-reviewed.md") — como aparece no header "Arquivo". */
  file?: string;
  /** Rótulo da aba ativa (ex: "02 — Newsletter") — como aparece nos botões de aba. */
  tab?: string;
}

const CHAT_CONTEXT_KEYS = ["edition", "file", "tab"] as const;

// ─── parsing do corpo de POST /api/chat (puro) ─────────────────────────────

export interface ChatRequest {
  message: string;
  /** Quando omitido, o server usa a sessão corrente em memória (se houver). */
  sessionId?: string;
  /** `true` força uma sessão nova mesmo que exista uma em memória — botão
   * "nova conversa" do drawer. */
  reset?: boolean;
  /** Estado do painel (edição/arquivo/aba) no momento deste turno (#3687) —
   * ver `buildChatPrompt`. Reenviado a CADA turno pelo cliente (não só na
   * abertura da sessão), então acompanha o editor trocando de edição/arquivo/
   * aba entre mensagens. */
  context?: ChatPanelContext;
}

export type ParsedChatRequest =
  | { ok: true; value: ChatRequest }
  | { ok: false; error: string };

/** Valida + normaliza o corpo cru (string JSON) de `POST /api/chat`. Pura —
 * nunca lança, sempre retorna um resultado tagged. */
export function parseChatRequestBody(raw: string): ParsedChatRequest {
  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `corpo não é JSON válido: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "corpo deve ser um objeto JSON" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.message !== "string" || obj.message.trim() === "") {
    return { ok: false, error: "campo 'message' é obrigatório (string não-vazia)" };
  }
  if (obj.sessionId !== undefined && typeof obj.sessionId !== "string") {
    return { ok: false, error: "'sessionId' deve ser string quando presente" };
  }
  if (obj.reset !== undefined && typeof obj.reset !== "boolean") {
    return { ok: false, error: "'reset' deve ser boolean quando presente" };
  }
  let context: ChatPanelContext | undefined;
  if (obj.context !== undefined) {
    if (typeof obj.context !== "object" || obj.context === null || Array.isArray(obj.context)) {
      return { ok: false, error: "'context' deve ser um objeto quando presente" };
    }
    const ctxObj = obj.context as Record<string, unknown>;
    const parsedContext: ChatPanelContext = {};
    for (const key of CHAT_CONTEXT_KEYS) {
      if (ctxObj[key] === undefined) continue;
      if (typeof ctxObj[key] !== "string") {
        return { ok: false, error: `'context.${key}' deve ser string quando presente` };
      }
      parsedContext[key] = ctxObj[key] as string;
    }
    context = parsedContext;
  }
  return {
    ok: true,
    value: {
      message: obj.message,
      sessionId: obj.sessionId as string | undefined,
      reset: obj.reset === true,
      context,
    },
  };
}

// ─── montagem do prompt com o bloco de contexto (#3687, pura) ─────────────

/**
 * Serializa `ChatPanelContext` num bloco de UMA linha pra prefixar o prompt
 * — nunca a bolha visível do chat (ver `handleApiChat`/`chat-drawer.js`, que
 * mostram só o texto cru do editor). Campos ausentes/vazios são omitidos;
 * sem NENHUM campo preenchido, retorna string vazia (nenhum bloco é
 * emitido). Pura — usada tanto por `buildChatPrompt` quanto testável
 * isoladamente.
 */
export function formatChatContextBlock(context: ChatPanelContext | undefined): string {
  if (!context) return "";
  const parts: string[] = [];
  if (context.edition && context.edition.trim()) parts.push(`edição ${context.edition.trim()}`);
  if (context.file && context.file.trim()) parts.push(`arquivo ${context.file.trim()}`);
  if (context.tab && context.tab.trim()) parts.push(`aba "${context.tab.trim()}"`);
  if (parts.length === 0) return "";
  return `[Contexto do painel Studio: ${parts.join(" · ")}]`;
}

/**
 * Monta o `prompt` final enviado ao SDK: o bloco de contexto (se houver
 * algum campo preenchido) numa linha, uma linha em branco, e a mensagem cru
 * do editor — igual ao formato que `describeChatError`/o resto do módulo já
 * usa pra texto legível. Sem contexto (nenhum campo preenchido), devolve
 * `message` inalterada — é o que garante que sessões de páginas sem esse
 * conceito (triagem/apoios/rodada) continuem funcionando exatamente como
 * antes do #3687.
 */
export function buildChatPrompt(message: string, context: ChatPanelContext | undefined): string {
  const block = formatChatContextBlock(context);
  return block ? `${block}\n\n${message}` : message;
}

// ─── parsing do corpo de POST /api/chat/answer (puro, #3557) ───────────────

export interface ChatAnswerRequest {
  toolUseId: string;
  /** question text -> resposta escolhida (labels selecionados, comma-separated
   * pra multiSelect) OU texto livre quando o editor usou "Other". Mesmo
   * shape de `AskUserQuestionOutput.answers` do SDK. */
  answers: Record<string, string>;
  /** Texto livre digitado pelo editor em vez de escolher uma opção
   * estruturada — só presente quando fizer sentido (1 pergunta, resposta
   * livre única). Opcional, espelha `AskUserQuestionOutput.response`. */
  response?: string;
}

export type ParsedChatAnswerRequest =
  | { ok: true; value: ChatAnswerRequest }
  | { ok: false; error: string };

/** Valida + normaliza o corpo cru (string JSON) de `POST /api/chat/answer`
 * (#3557). Pura — nunca lança, sempre retorna um resultado tagged, mesmo
 * padrão de `parseChatRequestBody`. */
export function parseChatAnswerRequestBody(raw: string): ParsedChatAnswerRequest {
  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `corpo não é JSON válido: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "corpo deve ser um objeto JSON" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.toolUseId !== "string" || obj.toolUseId.trim() === "") {
    return { ok: false, error: "campo 'toolUseId' é obrigatório (string não-vazia)" };
  }
  if (typeof obj.answers !== "object" || obj.answers === null || Array.isArray(obj.answers)) {
    return { ok: false, error: "campo 'answers' é obrigatório (objeto question -> resposta)" };
  }
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj.answers as Record<string, unknown>)) {
    if (typeof value !== "string") {
      return { ok: false, error: `resposta de "${key}" precisa ser string` };
    }
    answers[key] = value;
  }
  if (Object.keys(answers).length === 0) {
    return { ok: false, error: "'answers' precisa ter ao menos 1 resposta" };
  }
  if (obj.response !== undefined && typeof obj.response !== "string") {
    return { ok: false, error: "'response' deve ser string quando presente" };
  }
  return {
    ok: true,
    value: { toolUseId: obj.toolUseId, answers, response: obj.response as string | undefined },
  };
}

// ─── parsing do corpo de POST /api/chat/tool-decision (puro, #3804) ────────

/** Decisão do editor sobre um gate de tool (não-`AskUserQuestion`): rodar uma
 * vez (`allow`), rodar e não perguntar de novo por esta tool nesta sessão
 * (`always` — adiciona `toolName` ao allowlist em memória do `rootDir`, ver
 * `resolvePendingToolPermission`), ou negar (`deny`). */
export type ChatToolDecision = "allow" | "always" | "deny";

const TOOL_DECISIONS: readonly ChatToolDecision[] = ["allow", "always", "deny"];

export interface ChatToolDecisionRequest {
  toolUseId: string;
  decision: ChatToolDecision;
}

export type ParsedChatToolDecisionRequest =
  | { ok: true; value: ChatToolDecisionRequest }
  | { ok: false; error: string };

/** Valida + normaliza o corpo cru (string JSON) de `POST /api/chat/tool-decision`
 * (#3804). Pura — nunca lança, sempre retorna um resultado tagged, mesmo
 * padrão de `parseChatAnswerRequestBody`. */
export function parseChatToolDecisionRequestBody(raw: string): ParsedChatToolDecisionRequest {
  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `corpo não é JSON válido: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "corpo deve ser um objeto JSON" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.toolUseId !== "string" || obj.toolUseId.trim() === "") {
    return { ok: false, error: "campo 'toolUseId' é obrigatório (string não-vazia)" };
  }
  if (typeof obj.decision !== "string" || !TOOL_DECISIONS.includes(obj.decision as ChatToolDecision)) {
    return { ok: false, error: "campo 'decision' deve ser 'allow', 'always' ou 'deny'" };
  }
  return { ok: true, value: { toolUseId: obj.toolUseId, decision: obj.decision as ChatToolDecision } };
}

// ─── AskUserQuestion: parsing do input + montagem do updatedInput (#3557) ──

/** Extrai + normaliza `questions[]` do input cru (`Record<string, unknown>`,
 * sem tipagem forte em runtime) de uma tool call `AskUserQuestion`, pro
 * contrato serializável do evento `chat-permission-request`. Defensivo:
 * `AskUserQuestionInput` é validado pelo lado do modelo antes de chegar
 * aqui, mas este módulo não confia cegamente — retorna `null` (nunca lança)
 * se o shape não bater, pra `makeInteractiveCanUseTool` negar com mensagem
 * clara em vez de emitir um evento malformado pro browser. */
export function parseAskUserQuestionInput(input: Record<string, unknown>): ChatPermissionQuestion[] | null {
  const raw = input?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: ChatPermissionQuestion[] = [];
  for (const q of raw) {
    if (typeof q !== "object" || q === null) return null;
    const qq = q as Record<string, unknown>;
    if (typeof qq.question !== "string" || typeof qq.header !== "string") return null;
    if (!Array.isArray(qq.options) || qq.options.length < 2) return null;
    const options: ChatPermissionOption[] = [];
    for (const o of qq.options) {
      if (typeof o !== "object" || o === null) return null;
      const oo = o as Record<string, unknown>;
      if (typeof oo.label !== "string" || typeof oo.description !== "string") return null;
      const option: ChatPermissionOption = { label: oo.label, description: oo.description };
      if (typeof oo.preview === "string") option.preview = oo.preview;
      options.push(option);
    }
    questions.push({
      question: qq.question,
      header: qq.header,
      multiSelect: qq.multiSelect === true,
      options,
    });
  }
  return questions;
}

/**
 * Monta o `updatedInput` devolvido em `{behavior:'allow', updatedInput}`
 * quando o editor responde uma `AskUserQuestion` (#3557). O `.d.ts` do SDK
 * não documenta um campo dedicado "resultado da tool call" no
 * `PermissionResult` — só `updatedInput` (que normalmente substitui os
 * PARÂMETROS de entrada antes da tool executar). Pra `AskUserQuestion`
 * especificamente, a forma mais fiel ao contrato observável do SDK
 * (`AskUserQuestionOutput`, que ecoa `questions` de volta e adiciona
 * `answers`/`response`) é ecoar o input original + as respostas: se a tool
 * "executar" com esse input já resolvido, o resultado que produzir já
 * carrega a resposta certa. Pura — sem I/O. */
export function buildAskUserQuestionUpdatedInput(
  originalInput: Record<string, unknown>,
  answer: { answers: Record<string, string>; response?: string },
): Record<string, unknown> {
  const updated: Record<string, unknown> = { ...originalInput, answers: answer.answers };
  if (answer.response !== undefined) updated.response = answer.response;
  return updated;
}

// ─── tradução SDKMessage -> eventos de wire (pura) ─────────────────────────

interface ContentBlockLike {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

function contentBlocks(message: unknown): ContentBlockLike[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as ContentBlockLike[]) : [];
}

/**
 * Traduz UMA `SDKMessage` (do stream de `query()`) em zero ou mais eventos de
 * wire simplificados pro browser. Cobre só o subconjunto de tipos relevante
 * pro chat drawer (a união completa de `SDKMessage` tem dezenas de subtypes
 * de introspecção/controle que não interessam a este consumidor):
 *
 *   - `system` (subtype `init`) -> `chat-init` (session_id real + modelo).
 *   - `stream_event` com `content_block_delta`/`text_delta` -> `chat-delta`
 *     (o streaming de token-a-token que é o requisito central da #3556).
 *   - `assistant` completo -> `chat-tool` (start) pra cada bloco `tool_use`
 *     em `message.content` (visibilidade "nome + status" do critério de
 *     aceite).
 *   - `user` (as tool_result que o CLI reinjeta, não a mensagem do editor)
 *     -> `chat-tool` (end) pra cada bloco `tool_result`.
 *   - `system` (subtype `permission_denied`) -> `chat-tool` (denied) — o
 *     `canUseTool` fixo desta fatia (ver `makeDenyAllCanUseTool`) nega toda
 *     tool call que chegaria a um prompt interativo; este é o sinal com o
 *     motivo legível pro browser (chega antes do `tool_result` de erro).
 *   - `result` -> `chat-done`.
 *
 * Pura e determinística — sem I/O, sem depender do SDK real rodando; testável
 * com fixtures sintéticas que espelham só os campos usados.
 */
export function sdkMessageToChatEvents(msg: SDKMessage): ChatWireEvent[] {
  const anyMsg = msg as unknown as Record<string, unknown>;

  if (anyMsg.type === "system" && anyMsg.subtype === "init") {
    return [
      {
        event: "chat-init",
        data: {
          sessionId: String(anyMsg.session_id ?? ""),
          model: String(anyMsg.model ?? ""),
          cwd: String(anyMsg.cwd ?? ""),
        },
      },
    ];
  }

  if (anyMsg.type === "system" && anyMsg.subtype === "permission_denied") {
    // Emitido pelo SDK quando o `canUseTool` deste módulo (ver
    // `makeDenyAllCanUseTool`) — ou uma regra de settings.json — nega uma
    // tool call sem prompt interativo. Sem este mapeamento, a única pista no
    // wire seria o `tool_result` de erro em `user` (abaixo), sem o motivo
    // legível; este evento chega ANTES daquele e carrega a mensagem certa.
    return [
      {
        event: "chat-tool",
        data: {
          toolUseId: String(anyMsg.tool_use_id ?? ""),
          name: String(anyMsg.tool_name ?? ""),
          status: "denied",
          reason: String(anyMsg.message ?? "permissão negada"),
        },
      },
    ];
  }

  if (anyMsg.type === "stream_event") {
    const streamEvent = anyMsg.event as
      | { type?: string; delta?: { type?: string; text?: string } }
      | undefined;
    if (streamEvent?.type === "content_block_delta" && streamEvent.delta?.type === "text_delta") {
      const text = streamEvent.delta.text;
      if (typeof text === "string" && text.length > 0) {
        return [{ event: "chat-delta", data: { text } }];
      }
    }
    return [];
  }

  if (anyMsg.type === "assistant") {
    const events: ChatWireEvent[] = [];
    for (const block of contentBlocks(anyMsg.message)) {
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        events.push({
          event: "chat-tool",
          data: { toolUseId: block.id, name: block.name, status: "start", input: block.input ?? {} },
        });
      }
    }
    return events;
  }

  if (anyMsg.type === "user") {
    const events: ChatWireEvent[] = [];
    for (const block of contentBlocks(anyMsg.message)) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        events.push({
          event: "chat-tool",
          data: { toolUseId: block.tool_use_id, status: "end", isError: block.is_error === true },
        });
      }
    }
    return events;
  }

  if (anyMsg.type === "result") {
    const isError = anyMsg.is_error === true;
    const result = anyMsg.subtype === "success" ? (anyMsg.result as string | undefined) ?? null : null;
    return [
      {
        event: "chat-done",
        data: { sessionId: (anyMsg.session_id as string | undefined) ?? null, isError, result },
      },
    ];
  }

  return [];
}

// ─── mensagens de erro legíveis (puro) ─────────────────────────────────────

/** Traduz uma exceção do SDK/spawn num texto legível pro editor, sem vazar
 * stack trace cru na UI. Fail-soft: sempre retorna string, nunca lança. */
export function describeChatError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  // #3556 self-review: o antigo `/not found|não encontrado/i` era amplo
  // demais e rodava ANTES dos outros checks — um erro de `resume` com
  // sessionId obsoleto (algo como "session not found") caía aqui e mostrava
  // "CLI não encontrado", diagnóstico errado. `ENOENT` sozinho (ou o padrão
  // de spawn falho do Node, "spawn ... ENOENT"/"command not found" de shell)
  // é o sinal específico de binário ausente — não generalizar por "not found".
  if (/ENOENT/.test(message) || /spawn\s+\S*claude\S*\s+(ENOENT|failed)/i.test(message)) {
    return "chat indisponível: CLI do Claude Code não encontrado no PATH deste processo. Rode `claude` no terminal uma vez pra confirmar a instalação.";
  }
  if (/authentication|unauthenticated|not logged in|oauth/i.test(message)) {
    return "chat indisponível: sessão do Claude Code não autenticada neste ambiente. Rode `claude` no terminal uma vez pra autenticar, depois reabra o drawer.";
  }
  if (/rate.?limit/i.test(message)) {
    return "chat indisponível no momento: rate limit da conta Claude atingido. Tente de novo em alguns minutos.";
  }
  if (/session.*not found|no session found|resume.*not found/i.test(message)) {
    return "chat indisponível: a sessão anterior não foi encontrada (pode ter expirado ou sido limpa). Clique em \"nova conversa\" e tente de novo.";
  }
  return `chat indisponível: ${message}`;
}

// ─── estado de sessão em memória (1 por rootDir, #3554 "1 sessão ad-hoc") ──

const sessionIdByRoot = new Map<string, string>();

export function getSessionId(rootDir: string): string | undefined {
  return sessionIdByRoot.get(rootDir);
}

export function setSessionId(rootDir: string, sessionId: string): void {
  sessionIdByRoot.set(rootDir, sessionId);
}

export function clearSession(rootDir: string): void {
  sessionIdByRoot.delete(rootDir);
  clearSessionToolAllowlist(rootDir); // #3804: "nova conversa" também zera tools "sempre permitir".
}

// ─── gates pendentes: fila de AskUserQuestion aguardando resposta (#3557) ──
//
// 1 Map por `rootDir` (mesmo padrão de `sessionIdByRoot` acima — múltiplos
// `StudioServer` no mesmo processo, ex: testes, não devem vazar estado entre
// si). Chave interna é `toolUseID` (já único por tool call dentro de uma
// mensagem do assistente, e é o mesmo id que os eventos `chat-tool`
// start/end usam — o browser correlaciona o card de pergunta com o chip de
// tool call pelo mesmo id).

interface PendingPermissionRequest {
  /** `"question"` = gate de `AskUserQuestion` (#3557, resolve com
   * `{behavior:'allow', updatedInput}`); `"tool"` = gate de tool genérica
   * (#3804, resolve com `{behavior:'allow'}` ou `{behavior:'deny'}`). */
  kind: "question" | "tool";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Preenchido só quando `kind === "question"`; `[]` pros gates de tool. */
  questions: ChatPermissionQuestion[];
  askedAt: number;
  resolve: (result: PermissionResult) => void;
}

const pendingByRoot = new Map<string, Map<string, PendingPermissionRequest>>();

// #3804: allowlist EM MEMÓRIA por `rootDir` de tools que o editor mandou
// "sempre permitir nesta sessão" (decisão `always` de um gate de tool). É
// consultada no topo de `makeInteractiveCanUseTool` antes de emitir qualquer
// gate novo — aprovar `Bash` uma vez com "sempre" faz o resto dos Bash do
// turno/sessão rodarem sem re-perguntar (necessário pra rodar um pipeline
// inteiro pelo drawer sem dezenas de cliques). Escopo estrito: só vale nesta
// instância do processo (some no restart do studio-server), nunca é
// persistido em disco nem toca `.claude/settings.json` — o editor reautoriza
// a cada dia de trabalho, de propósito (o Studio é exposto via túnel).
const sessionAllowByRoot = new Map<string, Set<string>>();

function sessionAllowFor(rootDir: string): Set<string> {
  let s = sessionAllowByRoot.get(rootDir);
  if (!s) {
    s = new Set();
    sessionAllowByRoot.set(rootDir, s);
  }
  return s;
}

/** Limpa a allowlist em memória de tools "sempre permitir" do `rootDir`
 * (#3804). Chamado por `clearSession` — "nova conversa" no drawer zera também
 * as aprovações permanentes da sessão anterior, pra uma conversa nova nunca
 * herdar um `Bash` liberado sem o editor reautorizar. */
export function clearSessionToolAllowlist(rootDir: string): void {
  sessionAllowByRoot.delete(rootDir);
}

function pendingMapFor(rootDir: string): Map<string, PendingPermissionRequest> {
  let m = pendingByRoot.get(rootDir);
  if (!m) {
    m = new Map();
    pendingByRoot.set(rootDir, m);
  }
  return m;
}

export interface PendingPermissionSummary {
  /** #3804: `"question"` (AskUserQuestion) ou `"tool"` (gate de Bash/etc.). */
  kind: "question" | "tool";
  toolUseId: string;
  toolName: string;
  askedAt: number;
  /** Texto da 1ª pergunta — só pra preview/tooltip do badge global, não o
   * form completo (esse chega via `chat-permission-request`). `null` pros
   * gates de tool (#3804), que não têm perguntas. */
  firstQuestion: string | null;
}

/** Lista os gates (`AskUserQuestion`) pendentes de resposta pro `rootDir`
 * dado — usado pelo badge global (`studio-state.ts`/`buildStudioState`) e
 * por `resolvePendingPermissionRequest`. Ordenado do mais antigo pro mais
 * novo (o gate esperando há mais tempo aparece primeiro). */
export function listPendingPermissionRequests(rootDir: string): PendingPermissionSummary[] {
  return [...pendingMapFor(rootDir).values()]
    .sort((a, b) => a.askedAt - b.askedAt)
    .map((p) => ({
      kind: p.kind,
      toolUseId: p.toolUseId,
      toolName: p.toolName,
      askedAt: p.askedAt,
      firstQuestion: p.questions[0]?.question ?? null,
    }));
}

/** Payload COMPLETO de um gate pendente — mesmo shape de
 * `ChatPermissionRequestEvent.data`, pra `GET /api/chat/pending` (#3617)
 * conseguir reidratar o card no cliente sem depender de estar "no meio" do
 * stream SSE que originou a pergunta (a lacuna que causava o bug #3617: gate
 * pendente inalcançável depois de fechar/recarregar/navegar, já que
 * `chatPermissionsPending`/`PendingPermissionSummary` só expõe `firstQuestion`,
 * resumo insuficiente pra renderizar o form). */
export interface PendingPermissionFull {
  /** #3804: `"question"` (AskUserQuestion) ou `"tool"` (gate de Bash/etc.). */
  kind: "question" | "tool";
  toolUseId: string;
  toolName: string;
  askedAt: number;
  /** Preenchido só pros gates de `AskUserQuestion` (`kind === "question"`);
   * `[]` pros gates de tool. */
  questions: ChatPermissionQuestion[];
  /** Input cru da tool (ex: `{command: "..."}` de um `Bash`) — preenchido só
   * pros gates de tool (`kind === "tool"`, #3804), pro cliente reidratar o
   * card mostrando o mesmo preview do fluxo ao vivo. `undefined` pros gates
   * de pergunta. */
  input?: unknown;
}

/** Mesma fonte de `listPendingPermissionRequests` (o Map em memória de
 * `pendingByRoot` — não duplica estado), só que serializando `questions[]`
 * completo em vez do resumo `firstQuestion`. Consumido por
 * `GET /api/chat/pending` (server.ts) e, no cliente, por `chat-drawer.js`
 * pra montar o mesmo card que o evento `chat-permission-request` ao vivo
 * renderiza. */
export function listPendingPermissionRequestsFull(rootDir: string): PendingPermissionFull[] {
  return [...pendingMapFor(rootDir).values()]
    .sort((a, b) => a.askedAt - b.askedAt)
    .map((p) => ({
      kind: p.kind,
      toolUseId: p.toolUseId,
      toolName: p.toolName,
      askedAt: p.askedAt,
      questions: p.questions,
      ...(p.kind === "tool" ? { input: p.input } : {}),
    }));
}

/** Resolve a Promise de `canUseTool` pendente pro `toolUseId` dado, com
 * `{behavior:'allow', updatedInput}` montado por `buildAskUserQuestionUpdatedInput`
 * (#3557). Chamado pelo handler HTTP de `POST /api/chat/answer`. Idempotente
 * por construção: a entry é removida do Map antes de resolver, então uma 2ª
 * chamada com o mesmo `toolUseId` sempre retorna o erro "não encontrado" em
 * vez de resolver a Promise duas vezes. */
export function resolvePendingPermissionRequest(
  rootDir: string,
  toolUseId: string,
  answer: { answers: Record<string, string>; response?: string },
): { ok: true } | { ok: false; error: string } {
  const map = pendingMapFor(rootDir);
  const pending = map.get(toolUseId);
  if (!pending) {
    return {
      ok: false,
      error: `nenhum gate pendente com toolUseId "${toolUseId}" — pode já ter sido respondido, ou a sessão foi reiniciada/abortada.`,
    };
  }
  if (pending.kind !== "question") {
    // #3804: gate de tool (Bash/etc.) não se resolve por resposta de
    // pergunta — o cliente deve usar `POST /api/chat/tool-decision`. Não
    // consome a entry (retorna erro sem `map.delete`) pra não deixar a
    // Promise pendurada sem resolução.
    return {
      ok: false,
      error: `gate "${toolUseId}" é de tool (${pending.toolName}), não de AskUserQuestion — responda via /api/chat/tool-decision.`,
    };
  }
  map.delete(toolUseId);
  pending.resolve({
    behavior: "allow",
    updatedInput: buildAskUserQuestionUpdatedInput(pending.input, answer),
  });
  return { ok: true };
}

/** Resolve um gate de TOOL pendente (não-`AskUserQuestion`, #3804) pro
 * `toolUseId` dado, com a decisão do editor:
 *   - `allow`  → `{behavior:'allow'}` (roda a tool com o input original);
 *   - `always` → idem, e adiciona `toolName` ao allowlist em memória do
 *     `rootDir` (`sessionAllowByRoot`), pra próximas chamadas da mesma tool
 *     nesta sessão rodarem sem re-perguntar;
 *   - `deny`   → `{behavior:'deny', message}` (a tool não roda; o modelo
 *     recebe o motivo e segue).
 * Chamado pelo handler de `POST /api/chat/tool-decision`. Idempotente por
 * construção (remove a entry antes de resolver — 2ª chamada cai no
 * "não encontrado"). Rejeita com erro se o gate for de pergunta
 * (`kind === "question"`), simétrico ao guard em `resolvePendingPermissionRequest`. */
export function resolvePendingToolPermission(
  rootDir: string,
  toolUseId: string,
  decision: ChatToolDecision,
): { ok: true } | { ok: false; error: string } {
  const map = pendingMapFor(rootDir);
  const pending = map.get(toolUseId);
  if (!pending) {
    return {
      ok: false,
      error: `nenhum gate pendente com toolUseId "${toolUseId}" — pode já ter sido respondido, ou a sessão foi reiniciada/abortada.`,
    };
  }
  if (pending.kind !== "tool") {
    return {
      ok: false,
      error: `gate "${toolUseId}" é de AskUserQuestion, não de tool — responda via /api/chat/answer.`,
    };
  }
  map.delete(toolUseId);
  if (decision === "deny") {
    pending.resolve({
      behavior: "deny",
      message: `Editor negou "${pending.toolName}" pelo card do chat drawer.`,
    });
    return { ok: true };
  }
  if (decision === "always") {
    sessionAllowFor(rootDir).add(pending.toolName);
  }
  pending.resolve({ behavior: "allow" });
  return { ok: true };
}

/** Remove uma entry pendente SEM resolver a Promise — usado só pra limpeza
 * de fim de turno (`runChatTurn`, `finally`) quando o turno termina em
 * erro/abort antes do editor responder: a Promise fica sem consumidor (a
 * stream que a aguardava já foi encerrada), então mantê-la no Map vazaria
 * memória indefinidamente e o badge global mostraria um gate "morto" que
 * nunca mais será respondido. Idempotente (no-op se já não existir). */
function clearPendingPermissionRequestIfUnresolved(rootDir: string, toolUseId: string): void {
  pendingByRoot.get(rootDir)?.delete(toolUseId);
}

export interface PendingPermissionWatchHandle {
  close: () => void;
}

/** Observa a lista de gates pendentes do `rootDir` e chama `onChange`
 * sempre que o CONJUNTO de `toolUseId`s pendentes mudar (nova pergunta
 * chegou OU uma foi respondida) — usado por `handleApiEvents` (server.ts)
 * pra re-emitir `GET /api/state` via SSE assim que o badge global precisa
 * atualizar, sem esperar o próximo evento de run-log/plan.json (#3557
 * critério de aceite "badge global de gates pendentes"). Polling simples,
 * mesmo padrão de `run-log-tail.ts`/`plan-watch.ts` — não há evento nativo
 * de "Map mudou" pra observar. */
export function watchPendingChatPermissions(
  rootDir: string,
  onChange: (pending: PendingPermissionSummary[]) => void,
  opts: { pollIntervalMs?: number } = {},
): PendingPermissionWatchHandle {
  let lastKey = JSON.stringify(listPendingPermissionRequests(rootDir).map((p) => p.toolUseId));
  const interval = setInterval(() => {
    const current = listPendingPermissionRequests(rootDir);
    const key = JSON.stringify(current.map((p) => p.toolUseId));
    if (key !== lastKey) {
      lastKey = key;
      onChange(current);
    }
  }, opts.pollIntervalMs ?? 1000);
  return { close: () => clearInterval(interval) };
}

// ─── invocação real do SDK (I/O, injetável) ────────────────────────────────

export type QueryFn = (params: { prompt: string; options?: Options }) => Query;

function defaultQueryFn(params: { prompt: string; options?: Options }): Query {
  return sdkQuery(params);
}

/**
 * #3557 + #3804 — a peça que a issue-mãe (#3554) descreve como "interceptar
 * AskUserQuestion / permission prompts -> form clicável na UI". Qualquer tool
 * call que chegaria a um prompt interativo (ou seja, NÃO já resolvida
 * allow/deny por `.claude/settings.json`/`allowedTools` — essas nunca invocam
 * este callback) vira um gate clicável na UI, em vez de ser negada de cara:
 *
 *   - `AskUserQuestion` (#3557): parseia `questions[]` via
 *     `parseAskUserQuestionInput` (nega com mensagem clara se o shape vier
 *     malformado), emite `chat-permission-request` e espera a resposta via
 *     `POST /api/chat/answer` (`resolvePendingPermissionRequest`).
 *   - qualquer OUTRA tool (#3804 — Bash, Edit, etc.): emite
 *     `chat-tool-permission-request` com `{toolName, input}` e espera a
 *     decisão do editor (`allow`/`always`/`deny`) via
 *     `POST /api/chat/tool-decision` (`resolvePendingToolPermission`). É o que
 *     destrava rodar `/diaria-edicao` pelo drawer, cujo playbook usa Bash com
 *     sintaxe fora dos padrões do allowlist (variável/`$(...)`/condicional).
 *
 * Curto-circuito (#3804): tools que o editor já mandou "sempre permitir nesta
 * sessão" (decisão `always`, em `sessionAllowByRoot`) são aprovadas
 * imediatamente aqui, sem emitir gate nem esperar — pra um pipeline inteiro
 * não exigir um clique por comando. Ambos os tipos de gate registram a
 * Promise em `pendingByRoot` (chaveada por `toolUseID`) + `turnPermissionIds`
 * (limpeza de fim-de-turno, ver `runChatTurn`); sem timeout, mesma semântica
 * bloqueante do terminal.
 */
function makeInteractiveCanUseTool(
  rootDir: string,
  onEvent: (event: ChatWireEvent) => void,
  turnPermissionIds: Set<string>,
): CanUseTool {
  return async (toolName, input, options) => {
    const toolUseId = options.toolUseID;
    const askedAt = Date.now();

    if (toolName === "AskUserQuestion") {
      const questions = parseAskUserQuestionInput(input);
      if (!questions) {
        return {
          behavior: "deny",
          message:
            "AskUserQuestion chegou com input malformado — não foi possível renderizar o form no chat drawer.",
        };
      }
      turnPermissionIds.add(toolUseId);
      onEvent({ event: "chat-permission-request", data: { toolUseId, questions, askedAt } });
      return new Promise<PermissionResult>((resolve) => {
        pendingMapFor(rootDir).set(toolUseId, {
          kind: "question",
          toolUseId,
          toolName,
          input,
          questions,
          askedAt,
          resolve,
        });
      });
    }

    // #3804: tool genérica. Curto-circuito se já foi "sempre permitida" nesta
    // sessão — roda sem gate nem espera.
    if (sessionAllowFor(rootDir).has(toolName)) {
      return { behavior: "allow" };
    }

    turnPermissionIds.add(toolUseId);
    onEvent({ event: "chat-tool-permission-request", data: { toolUseId, toolName, input, askedAt } });
    return new Promise<PermissionResult>((resolve) => {
      pendingMapFor(rootDir).set(toolUseId, {
        kind: "tool",
        toolUseId,
        toolName,
        input,
        questions: [],
        askedAt,
        resolve,
      });
    });
  };
}

export interface RunChatTurnOptions {
  message: string;
  /** Sessão a retomar (se houver) — omitido = conversa nova. */
  sessionId?: string;
  /** cwd da sessão do Agent SDK — sempre a raiz do repo (`rootDir` do studio-server),
   * pra carregar CLAUDE.md/skills/MCPs locais igual ao terminal. */
  cwd: string;
  /** Estado do painel (edição/arquivo/aba) no momento deste turno (#3687) —
   * prefixado ao `message` via `buildChatPrompt` antes de virar o `prompt`
   * enviado ao SDK. Omitido = comportamento idêntico ao pré-#3687. */
  context?: ChatPanelContext;
  onEvent: (event: ChatWireEvent) => void;
  queryFn?: QueryFn;
  /** Repassado direto pro `Options.abortController` do SDK — o caller (o
   * handler HTTP) já cria um `AbortController` pra abortar no `close` da
   * request; passar o mesmo objeto evita indireção de wrap-outro-controller
   * só pra encaminhar um `signal`. */
  abortController?: AbortController;
}

/**
 * Conduz UM turno de chat: chama `query()` do Claude Agent SDK e traduz cada
 * `SDKMessage` emitida em eventos de wire via `onEvent`, em ordem. Fail-soft:
 * qualquer exceção (spawn do CLI falhou, sessão inválida, abort) vira um
 * `chat-error` em vez de propagar — o caller HTTP nunca precisa de try/catch
 * próprio em volta desta chamada.
 */
export async function runChatTurn(opts: RunChatTurnOptions): Promise<void> {
  const runQuery = opts.queryFn ?? defaultQueryFn;
  // #3557: ids de gates (AskUserQuestion) abertos DURANTE este turno — num
  // turno bem-sucedido, o `for await` abaixo já garante que cada um foi
  // resolvido antes da stream avançar (é o próprio contrato de `canUseTool`:
  // a tool call não "acontece" até a Promise resolver), então o Map já
  // estará vazio dessas entries no `finally`. Só importa no caminho de
  // erro/abort: o `finally` varre esta lista e remove qualquer entry que
  // ainda esteja pendente (turno morreu antes da resposta chegar) — sem
  // isso, uma sessão abortada com pergunta em aberto vazaria a entry pra
  // sempre (Promise nunca resolvida, nunca mais será).
  const turnPermissionIds = new Set<string>();
  try {
    const stream = runQuery({
      prompt: buildChatPrompt(opts.message, opts.context),
      options: {
        cwd: opts.cwd,
        resume: opts.sessionId,
        // 'project' carrega CLAUDE.md + .claude/settings.json (allowedTools) —
        // sem isso a sessão do drawer perderia as regras editoriais e as
        // permissões já configuradas pro terminal (#3556 critério de aceite
        // "/diaria-log ... funciona igual ao terminal").
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
        permissionMode: "default",
        canUseTool: makeInteractiveCanUseTool(opts.cwd, opts.onEvent, turnPermissionIds),
        abortController: opts.abortController,
      },
    });

    for await (const msg of stream) {
      for (const wireEvent of sdkMessageToChatEvents(msg)) {
        opts.onEvent(wireEvent);
      }
    }
  } catch (e) {
    opts.onEvent({ event: "chat-error", data: { message: describeChatError(e) } });
  } finally {
    for (const toolUseId of turnPermissionIds) {
      clearPendingPermissionRequestIfUnresolved(opts.cwd, toolUseId);
    }
  }
}
