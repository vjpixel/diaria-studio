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
import type { CanUseTool, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  parseChatRequestBody,
  parseChatAnswerRequestBody,
  parseAskUserQuestionInput,
  buildAskUserQuestionUpdatedInput,
  sdkMessageToChatEvents,
  describeChatError,
  getSessionId,
  setSessionId,
  clearSession,
  runChatTurn,
  listPendingPermissionRequests,
  resolvePendingPermissionRequest,
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

describe("runChatTurn (#3557) — AskUserQuestion vira gate (form), não denial automática", () => {
  // #633: regressão que prova o mecanismo fim-a-fim descrito no PR —
  // "sessão de brinquedo que chama AskUserQuestion -> form -> resposta ->
  // assert da continuação". O `fakeQuery` abaixo é o único jeito de exercer
  // isso sem spawnar o SDK real: ele chama `options.canUseTool` ele mesmo
  // (a mesma função que o SDK de verdade chamaria), simulando também uma 2ª
  // tool call (Bash) pra provar que o escopo ampliado NÃO vazou pra outras
  // tools (critério (d) do #3557).
  it("(a) emite chat-permission-request; (b) resolve via resolvePendingPermissionRequest; (c) a sessão continua; (d) outra tool call segue negada", async () => {
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

    let capturedBashDenial: PermissionResult | null = null;

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

        // (d) uma 2ª tool call, FORA do escopo desta issue, continua negada.
        capturedBashDenial = await canUseTool("Bash", { command: "ls" }, {
          signal,
          toolUseID: "tu-bash-1",
          requestId: "req-2",
        });
        yield {
          type: "system",
          subtype: "permission_denied",
          tool_name: "Bash",
          tool_use_id: "tu-bash-1",
          message: capturedBashDenial?.behavior === "deny" ? capturedBashDenial.message : "",
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

    // (d) a 2ª tool call (Bash) foi negada de verdade pelo canUseTool, e o
    // sinal chegou ao browser como chat-tool "denied" — regressão de escopo:
    // o #3557 não deve ter aberto a porta pra mais nada além de AskUserQuestion.
    assert.ok(capturedBashDenial);
    assert.equal((capturedBashDenial as PermissionResult).behavior, "deny");
    const bashDenied = toolEvents.find(
      (e) => e.event === "chat-tool" && (e.data as { toolUseId?: string }).toolUseId === "tu-bash-1",
    );
    assert.ok(bashDenied, "esperava um chat-tool 'denied' pra tu-bash-1");
    assert.equal((bashDenied?.data as { status?: string }).status, "denied");
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
