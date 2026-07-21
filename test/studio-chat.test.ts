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
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  parseChatRequestBody,
  parseChatAnswerRequestBody,
  parseChatToolDecisionRequestBody,
  parseAskUserQuestionInput,
  buildAskUserQuestionUpdatedInput,
  sdkMessageToChatEvents,
  describeChatError,
  getSessionId,
  setSessionId,
  clearSession,
  runChatTurn,
  listPendingPermissionRequests,
  listPendingPermissionRequestsFull,
  resolvePendingPermissionRequest,
  resolvePendingToolPermission,
  clearSessionToolAllowlist,
  formatChatContextBlock,
  buildChatPrompt,
  type ChatWireEvent,
  type ChatPermissionRequestEvent,
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

describe("parseChatRequestBody — 'context' do painel (#3687)", () => {
  it("aceita 'context' ausente -> value.context fica undefined", () => {
    const result = parseChatRequestBody(JSON.stringify({ message: "oi" }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.context, undefined);
  });

  it("aceita 'context' com edição/arquivo/aba", () => {
    const result = parseChatRequestBody(
      JSON.stringify({ message: "oi", context: { edition: "260720", file: "02-reviewed.md", tab: "02 — Newsletter" } }),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.context, {
        edition: "260720",
        file: "02-reviewed.md",
        tab: "02 — Newsletter",
      });
    }
  });

  it("aceita 'context' parcial (só edição, ex: edicao.js sem aba/arquivo)", () => {
    const result = parseChatRequestBody(JSON.stringify({ message: "oi", context: { edition: "260720" } }));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.context, { edition: "260720" });
  });

  it("aceita 'context' vazio ({}) -> objeto vazio, não erro", () => {
    const result = parseChatRequestBody(JSON.stringify({ message: "oi", context: {} }));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.context, {});
  });

  it("rejeita 'context' de tipo errado (array, string, número)", () => {
    assert.equal(parseChatRequestBody(JSON.stringify({ message: "oi", context: [] })).ok, false);
    assert.equal(parseChatRequestBody(JSON.stringify({ message: "oi", context: "260720" })).ok, false);
    assert.equal(parseChatRequestBody(JSON.stringify({ message: "oi", context: 5 })).ok, false);
  });

  it("rejeita campo de 'context' com tipo errado", () => {
    assert.equal(parseChatRequestBody(JSON.stringify({ message: "oi", context: { edition: 260720 } })).ok, false);
    assert.equal(parseChatRequestBody(JSON.stringify({ message: "oi", context: { file: 5 } })).ok, false);
    assert.equal(parseChatRequestBody(JSON.stringify({ message: "oi", context: { tab: null } })).ok, false);
  });

  it("ignora campos desconhecidos dentro de 'context' (fail-open, não trava a request)", () => {
    const result = parseChatRequestBody(JSON.stringify({ message: "oi", context: { edition: "260720", bogus: "x" } }));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.context, { edition: "260720" });
  });
});

describe("formatChatContextBlock / buildChatPrompt (#3687)", () => {
  it("sem contexto -> bloco vazio, prompt igual à mensagem original", () => {
    assert.equal(formatChatContextBlock(undefined), "");
    assert.equal(buildChatPrompt("passe a Clarice no texto de introdução", undefined), "passe a Clarice no texto de introdução");
  });

  it("contexto vazio ({}) -> bloco vazio, mesmo tratamento de 'sem contexto'", () => {
    assert.equal(formatChatContextBlock({}), "");
    assert.equal(buildChatPrompt("oi", {}), "oi");
  });

  it("contexto completo -> bloco com edição, arquivo e aba, prefixado ao prompt", () => {
    const context = { edition: "260720", file: "02-reviewed.md", tab: "02 — Newsletter" };
    const block = formatChatContextBlock(context);
    assert.equal(block, '[Contexto do painel Studio: edição 260720 · arquivo 02-reviewed.md · aba "02 — Newsletter"]');
    // regressão do cenário REAL da issue #3687: editor com a edição/arquivo
    // abertos digita uma referência implícita ("esse texto") — o prompt que
    // chega ao modelo precisa carregar o bloco de contexto ANTES da
    // mensagem, na mesma ordem que um editor leria.
    const prompt = buildChatPrompt("passe a Clarice no texto de introdução", context);
    assert.equal(
      prompt,
      '[Contexto do painel Studio: edição 260720 · arquivo 02-reviewed.md · aba "02 — Newsletter"]\n\npasse a Clarice no texto de introdução',
    );
  });

  it("contexto parcial (só edição) -> bloco só com o campo presente", () => {
    assert.equal(formatChatContextBlock({ edition: "260720" }), "[Contexto do painel Studio: edição 260720]");
  });

  it("campos com só espaço em branco são tratados como ausentes", () => {
    assert.equal(formatChatContextBlock({ edition: "  ", file: "", tab: undefined }), "");
  });
});

describe("parseChatAnswerRequestBody (#3557)", () => {
  it("aceita um corpo válido com toolUseId + answers", () => {
    const result = parseChatAnswerRequestBody(
      JSON.stringify({ toolUseId: "tu-1", answers: { "Qual biblioteca?": "date-fns" } }),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.toolUseId, "tu-1");
      assert.deepEqual(result.value.answers, { "Qual biblioteca?": "date-fns" });
      assert.equal(result.value.response, undefined);
    }
  });

  it("aceita 'response' opcional (resposta livre)", () => {
    const result = parseChatAnswerRequestBody(
      JSON.stringify({ toolUseId: "tu-1", answers: { "Qual?": "outra coisa" }, response: "outra coisa" }),
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.response, "outra coisa");
  });

  it("rejeita JSON inválido", () => {
    assert.equal(parseChatAnswerRequestBody("{not json").ok, false);
  });

  it("rejeita 'toolUseId' ausente ou vazio", () => {
    assert.equal(parseChatAnswerRequestBody(JSON.stringify({ answers: { a: "b" } })).ok, false);
    assert.equal(parseChatAnswerRequestBody(JSON.stringify({ toolUseId: "", answers: { a: "b" } })).ok, false);
  });

  it("rejeita 'answers' ausente, vazio, ou de tipo errado", () => {
    assert.equal(parseChatAnswerRequestBody(JSON.stringify({ toolUseId: "tu-1" })).ok, false);
    assert.equal(parseChatAnswerRequestBody(JSON.stringify({ toolUseId: "tu-1", answers: {} })).ok, false);
    assert.equal(parseChatAnswerRequestBody(JSON.stringify({ toolUseId: "tu-1", answers: [] })).ok, false);
    assert.equal(
      parseChatAnswerRequestBody(JSON.stringify({ toolUseId: "tu-1", answers: { a: 5 } })).ok,
      false,
    );
  });

  it("rejeita 'response' de tipo errado quando presente", () => {
    assert.equal(
      parseChatAnswerRequestBody(JSON.stringify({ toolUseId: "tu-1", answers: { a: "b" }, response: 5 })).ok,
      false,
    );
  });
});

describe("parseChatToolDecisionRequestBody (#3804)", () => {
  it("aceita as três decisões válidas", () => {
    for (const decision of ["allow", "always", "deny"] as const) {
      const result = parseChatToolDecisionRequestBody(JSON.stringify({ toolUseId: "tu-1", decision }));
      assert.equal(result.ok, true, `decision=${decision} deveria ser aceita`);
      if (result.ok) {
        assert.equal(result.value.toolUseId, "tu-1");
        assert.equal(result.value.decision, decision);
      }
    }
  });

  it("rejeita JSON inválido", () => {
    assert.equal(parseChatToolDecisionRequestBody("{not json").ok, false);
  });

  it("rejeita 'toolUseId' ausente ou vazio", () => {
    assert.equal(parseChatToolDecisionRequestBody(JSON.stringify({ decision: "allow" })).ok, false);
    assert.equal(parseChatToolDecisionRequestBody(JSON.stringify({ toolUseId: "", decision: "allow" })).ok, false);
  });

  it("rejeita 'decision' ausente ou fora do conjunto {allow, always, deny}", () => {
    assert.equal(parseChatToolDecisionRequestBody(JSON.stringify({ toolUseId: "tu-1" })).ok, false);
    assert.equal(parseChatToolDecisionRequestBody(JSON.stringify({ toolUseId: "tu-1", decision: "yes" })).ok, false);
    assert.equal(parseChatToolDecisionRequestBody(JSON.stringify({ toolUseId: "tu-1", decision: 1 })).ok, false);
  });
});

describe("parseAskUserQuestionInput (#3557)", () => {
  const validInput = {
    questions: [
      {
        question: "Qual biblioteca de datas?",
        header: "Biblioteca",
        multiSelect: false,
        options: [
          { label: "date-fns", description: "leve, tree-shakeable" },
          { label: "dayjs", description: "API estilo moment", preview: "dayjs().format()" },
        ],
      },
    ],
  };

  it("parseia um input válido de 1 pergunta com 2 opções", () => {
    const result = parseAskUserQuestionInput(validInput);
    assert.ok(result);
    assert.equal(result?.length, 1);
    assert.equal(result?.[0].question, "Qual biblioteca de datas?");
    assert.equal(result?.[0].header, "Biblioteca");
    assert.equal(result?.[0].multiSelect, false);
    assert.equal(result?.[0].options.length, 2);
    assert.equal(result?.[0].options[1].preview, "dayjs().format()");
  });

  it("multiSelect true é preservado", () => {
    const input = { questions: [{ ...validInput.questions[0], multiSelect: true }] };
    const result = parseAskUserQuestionInput(input);
    assert.equal(result?.[0].multiSelect, true);
  });

  it("até 4 perguntas são aceitas", () => {
    const input = { questions: [validInput.questions[0], validInput.questions[0], validInput.questions[0], validInput.questions[0]] };
    const result = parseAskUserQuestionInput(input);
    assert.equal(result?.length, 4);
  });

  it("retorna null (não lança) quando 'questions' está ausente ou vazio", () => {
    assert.equal(parseAskUserQuestionInput({}), null);
    assert.equal(parseAskUserQuestionInput({ questions: [] }), null);
  });

  it("retorna null quando uma pergunta tem menos de 2 opções", () => {
    const input = { questions: [{ ...validInput.questions[0], options: [validInput.questions[0].options[0]] }] };
    assert.equal(parseAskUserQuestionInput(input), null);
  });

  it("retorna null quando falta 'question'/'header' ou o shape de uma opção está errado", () => {
    assert.equal(parseAskUserQuestionInput({ questions: [{ header: "x", options: validInput.questions[0].options }] }), null);
    assert.equal(
      parseAskUserQuestionInput({ questions: [{ question: "q", header: "h", options: [{ label: "a" }, { label: "b" }] }] }),
      null,
    );
  });
});

describe("buildAskUserQuestionUpdatedInput (#3557)", () => {
  it("ecoa o input original + adiciona 'answers'", () => {
    const original = { questions: [{ question: "q1", header: "h1", multiSelect: false, options: [] }] };
    const result = buildAskUserQuestionUpdatedInput(original, { answers: { q1: "opção A" } });
    assert.deepEqual(result, { questions: original.questions, answers: { q1: "opção A" } });
  });

  it("inclui 'response' quando presente no answer", () => {
    const original = { questions: [] };
    const result = buildAskUserQuestionUpdatedInput(original, { answers: { q1: "livre" }, response: "livre" });
    assert.equal(result.response, "livre");
  });

  it("não inclui 'response' quando ausente", () => {
    const result = buildAskUserQuestionUpdatedInput({}, { answers: { q1: "a" } });
    assert.equal("response" in result, false);
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

  it("regressão (#3687): context do painel chega no 'prompt' enviado ao SDK, prefixado à mensagem", async () => {
    let capturedPrompt: string | undefined;
    const fakeQuery: QueryFn = (params) => {
      capturedPrompt = params.prompt as string;
      async function* gen() {
        yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" } as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
    await runChatTurn({
      message: "passe a Clarice no texto de introdução",
      cwd: "/repo",
      context: { edition: "260720", file: "02-reviewed.md", tab: "02 — Newsletter" },
      queryFn: fakeQuery,
      onEvent: () => {},
    });
    assert.equal(
      capturedPrompt,
      '[Contexto do painel Studio: edição 260720 · arquivo 02-reviewed.md · aba "02 — Newsletter"]\n\npasse a Clarice no texto de introdução',
    );
  });

  it("sem context, o 'prompt' enviado ao SDK é a mensagem crua (comportamento pré-#3687 inalterado)", async () => {
    let capturedPrompt: string | undefined;
    const fakeQuery: QueryFn = (params) => {
      capturedPrompt = params.prompt as string;
      async function* gen() {
        yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" } as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
    await runChatTurn({ message: "oi", cwd: "/repo", queryFn: fakeQuery, onEvent: () => {} });
    assert.equal(capturedPrompt, "oi");
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

describe("runChatTurn (#3557/#3804) — AskUserQuestion e tools viram gates, não denial automática", () => {
  // #633: regressão que prova o mecanismo fim-a-fim descrito no PR —
  // "sessão de brinquedo que chama AskUserQuestion -> form -> resposta ->
  // assert da continuação". O `fakeQuery` abaixo é o único jeito de exercer
  // isso sem spawnar o SDK real: ele chama `options.canUseTool` ele mesmo
  // (a mesma função que o SDK de verdade chamaria), simulando também uma 2ª
  // tool call (Bash) — que no #3804 deixou de ser negada e passou a virar um
  // gate de tool aprovável (critério (d), reescrito).
  it("(a) emite chat-permission-request; (b) resolve via resolvePendingPermissionRequest; (c) a sessão continua; (d) outra tool call vira gate de tool aprovável (#3804)", async () => {
    const ROOT = "/tmp/root-askuserquestion-e2e";
    const askInput = {
      questions: [
        {
          question: "Qual abordagem?",
          header: "Abordagem",
          multiSelect: false,
          options: [
            { label: "A", description: "opção A" },
            { label: "B", description: "opção B" },
          ],
        },
      ],
    };

    const fakeQuery: QueryFn = (params) => {
      async function* gen() {
        const canUseTool = params.options?.canUseTool as CanUseTool;
        yield { type: "system", subtype: "init", session_id: "s1", model: "m", cwd: ROOT } as unknown as SDKMessage;

        const signal = new AbortController().signal;
        const askResult = await canUseTool("AskUserQuestion", askInput, {
          signal,
          toolUseID: "tu-ask-1",
          requestId: "req-1",
        });
        assert.ok(askResult);
        assert.equal(askResult?.behavior, "allow");
        if (askResult?.behavior === "allow") {
          // (c) a AskUserQuestion "executa" com o updatedInput resolvido e
          // devolve um tool_result — exatamente como qualquer outra tool
          // call bem-sucedida; a sessão não terminou nem travou.
          yield {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu-ask-1",
                  is_error: false,
                  content: JSON.stringify(askResult.updatedInput),
                },
              ],
            },
          } as unknown as SDKMessage;
        }

        // (d) #3804: uma 2ª tool call (Bash) NÃO é mais negada de cara — vira
        // um gate de tool que o editor aprova. O generator fica suspenso no
        // await até `resolvePendingToolPermission` resolver com allow.
        const bashResult = await canUseTool("Bash", { command: "ls" }, {
          signal,
          toolUseID: "tu-bash-1",
          requestId: "req-2",
        });
        assert.equal(bashResult?.behavior, "allow");
        yield {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tu-bash-1", is_error: false, content: "ok" }],
          },
        } as unknown as SDKMessage;

        yield { type: "result", subtype: "success", is_error: false, result: "fim", session_id: "s1" } as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };

    const received: ChatWireEvent[] = [];
    const turnPromise = runChatTurn({
      message: "vamos decidir a abordagem",
      cwd: ROOT,
      queryFn: fakeQuery,
      onEvent: (e) => received.push(e),
    });

    // O turno fica bloqueado dentro do `await canUseTool(...)` da
    // AskUserQuestion até alguém resolver — dá um tick pro generator rodar
    // até esse ponto (a Promise interna do canUseTool já registrou tudo
    // sincronamente antes do próprio `await` suspender, mas o `for await` de
    // `runChatTurn` só observa isso depois de um turno de microtask).
    await new Promise((r) => setImmediate(r));

    // (a) evento chat-permission-request chegou com o shape certo.
    const permissionEvent = received.find(
      (e): e is ChatPermissionRequestEvent => e.event === "chat-permission-request",
    );
    assert.ok(permissionEvent, "esperava um evento chat-permission-request");
    assert.equal(permissionEvent.data.toolUseId, "tu-ask-1");
    assert.equal(permissionEvent.data.questions.length, 1);
    assert.equal(permissionEvent.data.questions[0].header, "Abordagem");
    assert.equal(permissionEvent.data.questions[0].options.length, 2);

    // gate visível no snapshot que alimenta o badge global (studio-state.ts).
    const pendingBefore = listPendingPermissionRequests(ROOT);
    assert.equal(pendingBefore.length, 1);
    assert.equal(pendingBefore[0].toolUseId, "tu-ask-1");

    // (b) resolve — a MESMA função que o handler HTTP de
    // POST /api/chat/answer chama.
    const resolveResult = resolvePendingPermissionRequest(ROOT, "tu-ask-1", {
      answers: { "Qual abordagem?": "A" },
    });
    assert.deepEqual(resolveResult, { ok: true });

    // removido da lista de pendentes assim que respondido.
    assert.equal(listPendingPermissionRequests(ROOT).length, 0);

    // #3804: a AskUserQuestion resolvida faz o generator avançar até a 2ª
    // tool call (Bash), que agora emite um gate de tool. Dá um tick pra ele
    // chegar lá e aprova via `resolvePendingToolPermission` (o que
    // POST /api/chat/tool-decision chama).
    await new Promise((r) => setImmediate(r));
    const toolPermEvent = received.find(
      (e): e is Extract<ChatWireEvent, { event: "chat-tool-permission-request" }> =>
        e.event === "chat-tool-permission-request",
    );
    assert.ok(toolPermEvent, "esperava um chat-tool-permission-request pro Bash");
    assert.equal(toolPermEvent.data.toolName, "Bash");
    assert.equal((toolPermEvent.data.input as { command?: string }).command, "ls");
    const bashResolve = resolvePendingToolPermission(ROOT, "tu-bash-1", "allow");
    assert.deepEqual(bashResolve, { ok: true });

    await turnPromise;

    // (c) a sessão prosseguiu: tool_result da AskUserQuestion virou um
    // chat-tool "end" (não "denied"), e o turno terminou sem erro.
    const toolEvents = received.filter((e) => e.event === "chat-tool");
    const askEnd = toolEvents.find(
      (e) => e.event === "chat-tool" && (e.data as { toolUseId?: string }).toolUseId === "tu-ask-1",
    );
    assert.ok(askEnd, "esperava um chat-tool pra tu-ask-1 (a sessão prosseguiu)");
    assert.equal((askEnd?.data as { status?: string }).status, "end");
    const doneEvent = received.find((e): e is Extract<ChatWireEvent, { event: "chat-done" }> => e.event === "chat-done");
    assert.ok(doneEvent);
    assert.equal(doneEvent?.data.isError, false);
    assert.equal(doneEvent?.data.result, "fim");

    // (d) #3804: a 2ª tool call (Bash) foi APROVADA pelo gate e rodou —
    // chegou ao browser como chat-tool "end", não "denied". O escopo do #3557
    // foi deliberadamente ampliado pra qualquer tool via card de decisão.
    const bashEnd = toolEvents.find(
      (e) => e.event === "chat-tool" && (e.data as { toolUseId?: string }).toolUseId === "tu-bash-1",
    );
    assert.ok(bashEnd, "esperava um chat-tool 'end' pra tu-bash-1 (aprovado)");
    assert.equal((bashEnd?.data as { status?: string }).status, "end");
  });

  it("AskUserQuestion com input malformado é negada, sem emitir chat-permission-request", async () => {
    const ROOT = "/tmp/root-askuserquestion-malformed";
    const fakeQuery: QueryFn = (params) => {
      async function* gen() {
        const canUseTool = params.options?.canUseTool as CanUseTool;
        const result = await canUseTool(
          "AskUserQuestion",
          { questions: "não é um array" },
          { signal: new AbortController().signal, toolUseID: "tu-bad-1", requestId: "req-1" },
        );
        assert.equal(result?.behavior, "deny");
        yield { type: "result", subtype: "success", is_error: false, result: "fim", session_id: "s1" } as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
    const received: ChatWireEvent[] = [];
    await runChatTurn({ message: "oi", cwd: ROOT, queryFn: fakeQuery, onEvent: (e) => received.push(e) });
    assert.equal(received.some((e) => e.event === "chat-permission-request"), false);
    assert.equal(listPendingPermissionRequests(ROOT).length, 0);
  });

  it("regressão: turno que morre (erro) ANTES da resposta chegar não vaza a entry pendente (finally de runChatTurn)", async () => {
    const ROOT = "/tmp/root-askuserquestion-abort";
    const askInput = {
      questions: [
        {
          question: "Q?",
          header: "H",
          multiSelect: false,
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
      ],
    };
    const fakeQuery: QueryFn = (params) => {
      async function* gen() {
        const canUseTool = params.options?.canUseTool as CanUseTool;
        // dispara a permission request mas NUNCA aguarda a resolução —
        // simula o turno morrendo enquanto o gate ainda está aberto (ex:
        // browser desconectou, abortController disparou).
        void canUseTool("AskUserQuestion", askInput, {
          signal: new AbortController().signal,
          toolUseID: "tu-orphan-1",
          requestId: "req-1",
        });
        throw new Error("sessão abortada");
        // eslint-disable-next-line no-unreachable
        yield undefined as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
    const received: ChatWireEvent[] = [];
    await runChatTurn({ message: "oi", cwd: ROOT, queryFn: fakeQuery, onEvent: (e) => received.push(e) });
    assert.equal(received.some((e) => e.event === "chat-permission-request"), true);
    assert.equal(received.some((e) => e.event === "chat-error"), true);
    // sem o cleanup em `finally` (`clearPendingPermissionRequestIfUnresolved`),
    // esta entry ficaria pendente pro rootDir pra sempre (Promise nunca
    // resolvida, nunca mais será — a stream que a criou já morreu).
    assert.equal(listPendingPermissionRequests(ROOT).length, 0);
  });
});

describe("listPendingPermissionRequestsFull (#3617) — payload completo pra hidratação", () => {
  const ROOT = "/tmp/root-pending-full-3617";
  const askInput = {
    questions: [
      {
        question: "Qual biblioteca de datas?",
        header: "Biblioteca",
        multiSelect: false,
        options: [
          { label: "date-fns", description: "leve, tree-shakeable" },
          { label: "dayjs", description: "API estilo moment" },
        ],
      },
    ],
  };

  function openGate(root: string, toolUseId: string): void {
    // Mesmo mecanismo do teste de runChatTurn acima (#3557): dispara
    // canUseTool sem aguardar, deixando a entry pendente no Map em memória.
    const fakeQuery: QueryFn = (params) => {
      async function* gen() {
        const canUseTool = params.options?.canUseTool as CanUseTool;
        void canUseTool("AskUserQuestion", askInput, {
          signal: new AbortController().signal,
          toolUseID: toolUseId,
          requestId: `req-${toolUseId}`,
        });
        // nunca resolve — o gate fica pendente de propósito.
        await new Promise(() => {});
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
    void runChatTurn({ message: "oi", cwd: root, queryFn: fakeQuery, onEvent: () => {} });
  }

  it("regressão (#3617): com um gate pendente no servidor, devolve questions[] completo — não só firstQuestion", async () => {
    openGate(ROOT, "tu-full-1");
    // dá um tick pro generator registrar a entry no Map antes de checarmos.
    await new Promise((r) => setImmediate(r));

    const full = listPendingPermissionRequestsFull(ROOT);
    assert.equal(full.length, 1);
    assert.equal(full[0].toolUseId, "tu-full-1");
    assert.equal(full[0].toolName, "AskUserQuestion");
    assert.equal(typeof full[0].askedAt, "number");
    // o ponto central da regressão: questions[] inteiro, com header/options,
    // não um resumo — o que `listPendingPermissionRequests` (a versão antiga,
    // usada pelo badge global) NUNCA expôs.
    assert.equal(full[0].questions.length, 1);
    assert.equal(full[0].questions[0].header, "Biblioteca");
    assert.equal(full[0].questions[0].question, "Qual biblioteca de datas?");
    assert.equal(full[0].questions[0].options.length, 2);
    assert.equal(full[0].questions[0].options[0].label, "date-fns");

    // responder via o mesmo mecanismo que POST /api/chat/answer usa resolve
    // a mesma Promise — provando que o payload de hidratação e o fluxo ao
    // vivo compartilham o MESMO estado, não uma cópia.
    const resolved = resolvePendingPermissionRequest(ROOT, "tu-full-1", { answers: { "Qual biblioteca de datas?": "date-fns" } });
    assert.deepEqual(resolved, { ok: true });
    assert.equal(listPendingPermissionRequestsFull(ROOT).length, 0);
  });

  it("lista vazia quando não há gate pendente pro rootDir", () => {
    assert.deepEqual(listPendingPermissionRequestsFull("/tmp/root-pending-full-vazio"), []);
  });

  it("não vaza pendentes entre rootDirs diferentes", async () => {
    openGate(`${ROOT}-a`, "tu-a-1");
    await new Promise((r) => setImmediate(r));
    assert.equal(listPendingPermissionRequestsFull(`${ROOT}-a`).length, 1);
    assert.equal(listPendingPermissionRequestsFull(`${ROOT}-b`).length, 0);
  });
});

describe("gate de tool (#3804) — Bash/etc. vira card aprovar/negar, não denial", () => {
  // Cada `it` usa seu próprio rootDir pra não vazar allowlist de sessão
  // ("always") nem pendentes entre casos — o estado de studio-chat.ts é
  // global por rootDir (Maps em memória).

  /** Dispara UMA tool call via um turno de brinquedo, sem aguardar resolução
   * — deixa a Promise pendente no Map. Devolve um objeto cujo `.result` é
   * preenchido quando a tool call finalmente resolve (allow/deny). */
  function openToolGate(root: string, toolName: string, input: Record<string, unknown>, toolUseId: string) {
    const captured: { result: { behavior: string; message?: string } | null } = { result: null };
    const received: ChatWireEvent[] = [];
    const fakeQuery: QueryFn = (params) => {
      async function* gen() {
        const canUseTool = params.options?.canUseTool as CanUseTool;
        const r = await canUseTool(toolName, input, {
          signal: new AbortController().signal,
          toolUseID: toolUseId,
          requestId: `req-${toolUseId}`,
        });
        captured.result = r as { behavior: string; message?: string };
        // segura o turno aberto pós-resolução pra ele não morrer e limpar o
        // que não precisamos; o teste não aguarda o turno.
        await new Promise(() => {});
        yield undefined as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
    void runChatTurn({ message: "oi", cwd: root, queryFn: fakeQuery, onEvent: (e) => received.push(e) });
    return { captured, received };
  }

  it("emite chat-tool-permission-request com toolName+input e registra pendente kind:'tool'", async () => {
    const ROOT = "/tmp/root-tool-gate-emit";
    const { received } = openToolGate(ROOT, "Bash", { command: "npx tsx scripts/x.ts" }, "tu-g-1");
    await new Promise((r) => setImmediate(r));

    const ev = received.find(
      (e): e is Extract<ChatWireEvent, { event: "chat-tool-permission-request" }> =>
        e.event === "chat-tool-permission-request",
    );
    assert.ok(ev, "esperava chat-tool-permission-request");
    assert.equal(ev.data.toolName, "Bash");
    assert.equal((ev.data.input as { command?: string }).command, "npx tsx scripts/x.ts");

    // aparece na lista de pendentes com kind 'tool' + input (pra badge + hidratação).
    const full = listPendingPermissionRequestsFull(ROOT);
    assert.equal(full.length, 1);
    assert.equal(full[0].kind, "tool");
    assert.equal(full[0].toolName, "Bash");
    assert.deepEqual(full[0].input, { command: "npx tsx scripts/x.ts" });
    const summary = listPendingPermissionRequests(ROOT);
    assert.equal(summary[0].kind, "tool");
    assert.equal(summary[0].firstQuestion, null);
  });

  it("decision 'allow' resolve a tool call com behavior:'allow' e some da lista de pendentes", async () => {
    const ROOT = "/tmp/root-tool-gate-allow";
    const { captured } = openToolGate(ROOT, "Bash", { command: "ls" }, "tu-g-allow");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(resolvePendingToolPermission(ROOT, "tu-g-allow", "allow"), { ok: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(captured.result?.behavior, "allow");
    assert.equal(listPendingPermissionRequestsFull(ROOT).length, 0);
  });

  it("decision 'deny' resolve com behavior:'deny' + mensagem", async () => {
    const ROOT = "/tmp/root-tool-gate-deny";
    const { captured } = openToolGate(ROOT, "Bash", { command: "rm x" }, "tu-g-deny");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(resolvePendingToolPermission(ROOT, "tu-g-deny", "deny"), { ok: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(captured.result?.behavior, "deny");
    assert.match(captured.result?.message ?? "", /negou/i);
  });

  it("decision 'always' aprova E libera a MESMA tool pro resto da sessão sem novo gate", async () => {
    const ROOT = "/tmp/root-tool-gate-always";
    // 1ª chamada: abre gate, editor escolhe 'always'.
    const first = openToolGate(ROOT, "Bash", { command: "echo a" }, "tu-always-1");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(resolvePendingToolPermission(ROOT, "tu-always-1", "always"), { ok: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(first.captured.result?.behavior, "allow");

    // 2ª chamada da MESMA tool: curto-circuito — allow imediato, NENHUM gate
    // emitido e nada pendente.
    const second = openToolGate(ROOT, "Bash", { command: "echo b" }, "tu-always-2");
    await new Promise((r) => setImmediate(r));
    assert.equal(second.captured.result?.behavior, "allow");
    assert.equal(
      second.received.some((e) => e.event === "chat-tool-permission-request"),
      false,
      "2ª chamada não deveria emitir gate depois de 'always'",
    );
    assert.equal(listPendingPermissionRequestsFull(ROOT).length, 0);

    // uma tool DIFERENTE ainda abre gate (o allow é por nome de tool).
    const other = openToolGate(ROOT, "Edit", { file_path: "a.ts" }, "tu-always-edit");
    await new Promise((r) => setImmediate(r));
    assert.equal(
      other.received.some((e) => e.event === "chat-tool-permission-request"),
      true,
      "tool diferente ainda deve abrir gate",
    );
  });

  it("clearSession zera a allowlist 'always' — nova conversa reautoriza", async () => {
    const ROOT = "/tmp/root-tool-gate-clear";
    const first = openToolGate(ROOT, "Bash", { command: "echo a" }, "tu-clr-1");
    await new Promise((r) => setImmediate(r));
    resolvePendingToolPermission(ROOT, "tu-clr-1", "always");
    await new Promise((r) => setImmediate(r));
    assert.equal(first.captured.result?.behavior, "allow");

    clearSession(ROOT); // "nova conversa"

    // pós-clear, a mesma tool volta a abrir gate.
    const after = openToolGate(ROOT, "Bash", { command: "echo b" }, "tu-clr-2");
    await new Promise((r) => setImmediate(r));
    assert.equal(
      after.received.some((e) => e.event === "chat-tool-permission-request"),
      true,
      "após clearSession, 'always' anterior não vale mais",
    );
    // limpeza direta também disponível.
    clearSessionToolAllowlist(ROOT);
  });

  it("guards de tipo cruzado: resolver de pergunta rejeita gate de tool e vice-versa", async () => {
    const ROOT = "/tmp/root-tool-gate-crosskind";
    openToolGate(ROOT, "Bash", { command: "ls" }, "tu-x-tool");
    await new Promise((r) => setImmediate(r));

    // resolver de AskUserQuestion recusa um gate de tool (sem consumir a entry).
    const wrong = resolvePendingPermissionRequest(ROOT, "tu-x-tool", { answers: { a: "b" } });
    assert.equal(wrong.ok, false);
    assert.equal(listPendingPermissionRequestsFull(ROOT).length, 1, "entry não consumida pelo resolver errado");

    // id inexistente → erro.
    assert.equal(resolvePendingToolPermission(ROOT, "tu-nao-existe", "allow").ok, false);
  });
});
