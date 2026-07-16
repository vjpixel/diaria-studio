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
 * Escopo desta fatia (ver corpo do PR "Decisões de design" para o detalhe):
 * permission prompts interativos (cards clicáveis na UI) são o gancho do
 * #3557 — aqui, qualquer tool call que exigiria um prompt interativo (ou
 * seja, não já pré-aprovado por `.claude/settings.json`/`allowedTools`) é
 * NEGADO com uma mensagem clara em vez de travar a stream esperando resposta
 * que a UI ainda não sabe renderizar. Ver `TODO(#3557)` abaixo.
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
  | ChatDoneEvent
  | ChatErrorEvent;

// ─── parsing do corpo de POST /api/chat (puro) ─────────────────────────────

export interface ChatRequest {
  message: string;
  /** Quando omitido, o server usa a sessão corrente em memória (se houver). */
  sessionId?: string;
  /** `true` força uma sessão nova mesmo que exista uma em memória — botão
   * "nova conversa" do drawer. */
  reset?: boolean;
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
  return {
    ok: true,
    value: {
      message: obj.message,
      sessionId: obj.sessionId as string | undefined,
      reset: obj.reset === true,
    },
  };
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
  if (/ENOENT/.test(message) || /not found|não encontrado/i.test(message)) {
    return "chat indisponível: CLI do Claude Code não encontrado no PATH deste processo. Rode `claude` no terminal uma vez pra confirmar a instalação.";
  }
  if (/authentication|unauthenticated|not logged in|oauth/i.test(message)) {
    return "chat indisponível: sessão do Claude Code não autenticada neste ambiente. Rode `claude` no terminal uma vez pra autenticar, depois reabra o drawer.";
  }
  if (/rate.?limit/i.test(message)) {
    return "chat indisponível no momento: rate limit da conta Claude atingido. Tente de novo em alguns minutos.";
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
}

// ─── invocação real do SDK (I/O, injetável) ────────────────────────────────

export type QueryFn = (params: { prompt: string; options?: Options }) => Query;

function defaultQueryFn(params: { prompt: string; options?: Options }): Query {
  return sdkQuery(params);
}

/**
 * TODO(#3557): esta é a peça-chave que a issue-mãe (#3554) descreve como
 * "interceptar AskUserQuestion / permission prompts -> form clicável na UI".
 * Nesta fatia (fundação), qualquer tool call que chegaria a um prompt
 * interativo (ou seja, NÃO já resolvido allow/deny por
 * `.claude/settings.json`/`allowedTools` — essas nunca invocam este
 * callback) é negado com uma mensagem explicativa: a stream SSE de uma
 * request HTTP não tem pra onde mandar um prompt bloqueante ainda. O #3557
 * troca este `deny` fixo por: emitir um evento `chat-permission-request` pro
 * browser, aguardar a resposta do editor (form/card) e resolver a Promise
 * deste callback com o resultado — sem mudar mais nada da mecânica de
 * streaming já construída aqui.
 */
function makeDenyAllCanUseTool(): CanUseTool {
  return async (toolName) => {
    const denial: PermissionResult = {
      behavior: "deny",
      message:
        `Permissão para "${toolName}" exigiria confirmação interativa — o chat drawer ainda não ` +
        `suporta permission prompts (gancho pro #3557). Rode essa ação pelo terminal, ou aprove a ` +
        `ferramenta em .claude/settings.json se for segura pra automatizar.`,
    };
    return denial;
  };
}

export interface RunChatTurnOptions {
  message: string;
  /** Sessão a retomar (se houver) — omitido = conversa nova. */
  sessionId?: string;
  /** cwd da sessão do Agent SDK — sempre a raiz do repo (`rootDir` do studio-server),
   * pra carregar CLAUDE.md/skills/MCPs locais igual ao terminal. */
  cwd: string;
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
  try {
    const stream = runQuery({
      prompt: opts.message,
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
        canUseTool: makeDenyAllCanUseTool(),
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
  }
}
