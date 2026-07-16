/**
 * test/studio-chat.test.ts (#3556) — cobertura das camadas puras de
 * scripts/studio-ui/studio-chat.ts: validação do corpo de POST /api/chat,
 * o contrato de tradução SDKMessage -> evento de wire (o formato que o
 * front-end consome via SSE), mensagens de erro fail-soft, e o estado de
 * sessão em memória. `runChatTurn` (I/O real do Claude Agent SDK) é
 * exercido separadamente com um `queryFn` mockado — sem spawnar o CLI real
 * nem depender de rede/auth (#633: "a parte de streaming ao vivo do modelo
 * pode ser mockada ou coberta por um teste de contrato do formato de
 * evento" — é exatamente o que este arquivo faz).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  parseChatRequestBody,
  sdkMessageToChatEvents,
  describeChatError,
  getSessionId,
  setSessionId,
  clearSession,
  runChatTurn,
  type ChatWireEvent,
  type QueryFn,
} from "../scripts/studio-ui/studio-chat.ts";

describe("parseChatRequestBody (#3556)", () => {
  it("aceita um corpo válido com só 'message'", () => {
    const result = parseChatRequestBody(JSON.stringify({ message: "oi" }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.message, "oi");
      assert.equal(result.value.sessionId, undefined);
      assert.equal(result.value.reset, false);
    }
  });

  it("aceita sessionId e reset opcionais", () => {
    const result = parseChatRequestBody(JSON.stringify({ message: "oi", sessionId: "abc-123", reset: true }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.sessionId, "abc-123");
      assert.equal(result.value.reset, true);
    }
  });

  it("rejeita JSON inválido", () => {
    const result = parseChatRequestBody("{not json");
    assert.equal(result.ok, false);
  });

  it("rejeita corpo que não é objeto (array, string, número)", () => {
    assert.equal(parseChatRequestBody(JSON.stringify([1, 2])).ok, false);
    assert.equal(parseChatRequestBody(JSON.stringify("oi")).ok, false);
    assert.equal(parseChatRequestBody(JSON.stringify(42)).ok, false);
  });

  it("rejeita 'message' ausente ou vazio", () => {
    assert.equal(parseChatRequestBody(JSON.stringify({})).ok, false);
    assert.equal(parseChatRequestBody(JSON.stringify({ message: "" })).ok, false);
    assert.equal(parseChatRequestBody(JSON.stringify({ message: "   " })).ok, false);
  });

  it("rejeita 'message' de tipo errado", () => {
    assert.equal(parseChatRequestBody(JSON.stringify({ message: 123 })).ok, false);
  });

  it("rejeita 'sessionId'/'reset' de tipo errado quando presentes", () => {
    assert.equal(parseChatRequestBody(JSON.stringify({ message: "oi", sessionId: 5 })).ok, false);
    assert.equal(parseChatRequestBody(JSON.stringify({ message: "oi", reset: "sim" })).ok, false);
  });

  it("corpo vazio (string em branco) é tratado como objeto vazio -> rejeita por falta de message", () => {
    const result = parseChatRequestBody("");
    assert.equal(result.ok, false);
  });
});

describe("sdkMessageToChatEvents (#3556) — contrato de wire", () => {
  it("system/init -> chat-init com sessionId/model/cwd", () => {
    const msg = {
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      model: "claude-sonnet-5",
      cwd: "/repo",
    } as unknown as SDKMessage;
    const events = sdkMessageToChatEvents(msg);
    assert.deepEqual(events, [
      { event: "chat-init", data: { sessionId: "sess-1", model: "claude-sonnet-5", cwd: "/repo" } },
    ]);
  });

  it("stream_event de text_delta -> chat-delta", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "olá" } },
    } as unknown as SDKMessage;
    const events = sdkMessageToChatEvents(msg);
    assert.deepEqual(events, [{ event: "chat-delta", data: { text: "olá" } }]);
  });

  it("stream_event irrelevante (ex: content_block_start) não gera evento", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_start" },
    } as unknown as SDKMessage;
    assert.deepEqual(sdkMessageToChatEvents(msg), []);
  });

  it("stream_event de delta não-texto (ex: input_json_delta de tool_use) não gera evento", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } },
    } as unknown as SDKMessage;
    assert.deepEqual(sdkMessageToChatEvents(msg), []);
  });

  it("assistant com bloco tool_use -> chat-tool status start", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "vou rodar um comando" },
          { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
        ],
      },
    } as unknown as SDKMessage;
    const events = sdkMessageToChatEvents(msg);
    assert.deepEqual(events, [
      { event: "chat-tool", data: { toolUseId: "tu-1", name: "Bash", status: "start", input: { command: "ls" } } },
    ]);
  });

  it("assistant com múltiplos tool_use -> um evento chat-tool por bloco", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu-1", name: "Read", input: {} },
          { type: "tool_use", id: "tu-2", name: "Grep", input: {} },
        ],
      },
    } as unknown as SDKMessage;
    const events = sdkMessageToChatEvents(msg);
    assert.equal(events.length, 2);
    assert.equal((events[0] as { data: { toolUseId: string } }).data.toolUseId, "tu-1");
    assert.equal((events[1] as { data: { toolUseId: string } }).data.toolUseId, "tu-2");
  });

  it("assistant sem tool_use (só texto) não gera chat-tool", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "oi" }] },
    } as unknown as SDKMessage;
    assert.deepEqual(sdkMessageToChatEvents(msg), []);
  });

  it("user com tool_result -> chat-tool status end", () => {
    const msg = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: false, content: "ok" }],
      },
    } as unknown as SDKMessage;
    const events = sdkMessageToChatEvents(msg);
    assert.deepEqual(events, [{ event: "chat-tool", data: { toolUseId: "tu-1", status: "end", isError: false } }]);
  });

  it("user com tool_result de erro marca isError true", () => {
    const msg = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: true, content: "falhou" }],
      },
    } as unknown as SDKMessage;
    const events = sdkMessageToChatEvents(msg);
    assert.deepEqual(events, [{ event: "chat-tool", data: { toolUseId: "tu-1", status: "end", isError: true } }]);
  });

  it("result de sucesso -> chat-done com result preenchido", () => {
    const msg = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "tudo certo",
      session_id: "sess-1",
    } as unknown as SDKMessage;
    const events = sdkMessageToChatEvents(msg);
    assert.deepEqual(events, [
      { event: "chat-done", data: { sessionId: "sess-1", isError: false, result: "tudo certo" } },
    ]);
  });

  it("result de erro -> chat-done com isError true e result null", () => {
    const msg = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "sess-1",
    } as unknown as SDKMessage;
    const events = sdkMessageToChatEvents(msg);
    assert.deepEqual(events, [{ event: "chat-done", data: { sessionId: "sess-1", isError: true, result: null } }]);
  });

  it("system/permission_denied -> chat-tool status denied com motivo", () => {
    const msg = {
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "tu-9",
      message: "Permissão para \"Bash\" exigiria confirmação interativa...",
    } as unknown as SDKMessage;
    const events = sdkMessageToChatEvents(msg);
    assert.deepEqual(events, [
      {
        event: "chat-tool",
        data: {
          toolUseId: "tu-9",
          name: "Bash",
          status: "denied",
          reason: "Permissão para \"Bash\" exigiria confirmação interativa...",
        },
      },
    ]);
  });

  it("tipo de mensagem desconhecido/irrelevante não gera evento nem lança", () => {
    const msg = { type: "prompt_suggestion", suggestion: "tente X" } as unknown as SDKMessage;
    assert.deepEqual(sdkMessageToChatEvents(msg), []);
  });
});

describe("describeChatError (#3556) — fail-soft", () => {
  it("ENOENT do spawn -> mensagem sobre CLI não encontrado", () => {
    const msg = describeChatError(new Error("spawn claude ENOENT"));
    assert.match(msg, /CLI do Claude Code não encontrado/);
  });

  it("erro de autenticação -> mensagem sobre re-autenticar", () => {
    const msg = describeChatError(new Error("authentication_failed: invalid token"));
    assert.match(msg, /não autenticada/);
  });

  it("rate limit -> mensagem específica", () => {
    const msg = describeChatError(new Error("rate_limit exceeded, try later"));
    assert.match(msg, /rate limit/);
  });

  it("sessão de resume não encontrada -> mensagem sobre iniciar nova conversa, NÃO sobre CLI ausente", () => {
    const msg = describeChatError(new Error("session not found for id sess-stale-123"));
    assert.match(msg, /sessão anterior não foi encontrada/);
    assert.doesNotMatch(msg, /CLI do Claude Code não encontrado/);
  });

  it("regressão (#3556 self-review): 'not found' genérico não é mais confundido com CLI ausente", () => {
    // Antes do fix, qualquer mensagem contendo "not found" (sem ser ENOENT/spawn)
    // caía no branch de "CLI não encontrado" — diagnóstico errado pro editor.
    const msg = describeChatError(new Error("resume target not found"));
    assert.doesNotMatch(msg, /CLI do Claude Code não encontrado/);
  });

  it("erro genérico -> mensagem cai no fallback com a mensagem original embutida", () => {
    const msg = describeChatError(new Error("algo inesperado aconteceu"));
    assert.match(msg, /chat indisponível: algo inesperado aconteceu/);
  });

  it("valor não-Error (string crua lançada) não quebra — vira string via String()", () => {
    const msg = describeChatError("string crua");
    assert.match(msg, /chat indisponível: string crua/);
  });
});

describe("sessão em memória por rootDir (#3556)", () => {
  const ROOT_A = "/tmp/root-a";
  const ROOT_B = "/tmp/root-b";

  beforeEach(() => {
    clearSession(ROOT_A);
    clearSession(ROOT_B);
  });

  it("getSessionId retorna undefined quando não há sessão setada", () => {
    assert.equal(getSessionId(ROOT_A), undefined);
  });

  it("setSessionId + getSessionId round-trip", () => {
    setSessionId(ROOT_A, "sess-xyz");
    assert.equal(getSessionId(ROOT_A), "sess-xyz");
  });

  it("sessões de rootDirs diferentes não se misturam", () => {
    setSessionId(ROOT_A, "sess-a");
    setSessionId(ROOT_B, "sess-b");
    assert.equal(getSessionId(ROOT_A), "sess-a");
    assert.equal(getSessionId(ROOT_B), "sess-b");
  });

  it("clearSession remove só o rootDir indicado", () => {
    setSessionId(ROOT_A, "sess-a");
    setSessionId(ROOT_B, "sess-b");
    clearSession(ROOT_A);
    assert.equal(getSessionId(ROOT_A), undefined);
    assert.equal(getSessionId(ROOT_B), "sess-b");
  });
});

describe("runChatTurn (#3556) — com queryFn mockado (sem SDK real)", () => {
  it("traduz cada SDKMessage emitida em eventos de wire, em ordem", async () => {
    const fakeMessages: SDKMessage[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: "/repo" } as unknown as SDKMessage,
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "oi" } },
      } as unknown as SDKMessage,
      { type: "result", subtype: "success", is_error: false, result: "fim", session_id: "s1" } as unknown as SDKMessage,
    ];
    const fakeQuery: QueryFn = () => {
      async function* gen() {
        for (const m of fakeMessages) yield m;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };

    const received: ChatWireEvent[] = [];
    await runChatTurn({
      message: "oi",
      cwd: "/repo",
      queryFn: fakeQuery,
      onEvent: (e) => received.push(e),
    });

    assert.equal(received.length, 3);
    assert.equal(received[0].event, "chat-init");
    assert.equal(received[1].event, "chat-delta");
    assert.equal(received[2].event, "chat-done");
  });

  it("fail-soft: queryFn que lança vira um único evento chat-error, nunca propaga", async () => {
    const throwingQuery: QueryFn = () => {
      throw new Error("spawn claude ENOENT");
    };
    const received: ChatWireEvent[] = [];
    await assert.doesNotReject(
      runChatTurn({
        message: "oi",
        cwd: "/repo",
        queryFn: throwingQuery,
        onEvent: (e) => received.push(e),
      }),
    );
    assert.equal(received.length, 1);
    assert.equal(received[0].event, "chat-error");
    if (received[0].event === "chat-error") {
      assert.match(received[0].data.message, /CLI do Claude Code não encontrado/);
    }
  });

  it("fail-soft: generator que lança no meio do stream vira chat-error após os eventos já emitidos", async () => {
    const fakeQuery: QueryFn = () => {
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: "/repo" } as unknown as SDKMessage;
        throw new Error("rate_limit exceeded");
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
    const received: ChatWireEvent[] = [];
    await runChatTurn({
      message: "oi",
      cwd: "/repo",
      queryFn: fakeQuery,
      onEvent: (e) => received.push(e),
    });
    assert.equal(received.length, 2);
    assert.equal(received[0].event, "chat-init");
    assert.equal(received[1].event, "chat-error");
  });
});
