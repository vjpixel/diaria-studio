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
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CanUseTool, HookCallback, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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
  appendChatHistoryUserMessage,
  appendChatHistoryEvent,
  getChatHistory,
  clearChatHistory,
  extractFilePathInput,
  isGuardedReviewPath,
  evaluateEditGuard,
  recordKnownFileMtime,
  getKnownFileMtime,
  clearKnownFileMtimeTracking,
  EDIT_GUARD_STALE_MESSAGE,
  createCloseAbortGuard,
  DEFAULT_CHAT_CLOSE_ABORT_DEBOUNCE_MS,
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

/**
 * #3803 — regressão do bug "transcript some ao clicar em link": navegar
 * entre páginas do Studio (MPA, cada página reinjeta chat-drawer.js do zero)
 * esvaziava a tela do chat mesmo com a sessão do Agent SDK viva no servidor
 * via `resume`. Este buffer em memória (mesmo padrão de `sessionIdByRoot`
 * acima) é o que `GET /api/chat/history` serve pro cliente reidratar o
 * transcript visível — cobre a metade "servidor acumula/serve o histórico"
 * do mecanismo; a metade "cliente decide o que falta desenhar" é coberta por
 * `test/chat-hydration.test.ts` (`planHistoryReplay`).
 */
describe("histórico de mensagens por rootDir (#3803)", () => {
  const ROOT_A = "/tmp/hist-root-a";
  const ROOT_B = "/tmp/hist-root-b";

  beforeEach(() => {
    clearChatHistory(ROOT_A);
    clearChatHistory(ROOT_B);
  });

  it("buffer vazio no início", () => {
    assert.deepEqual(getChatHistory(ROOT_A), []);
  });

  it("appendChatHistoryUserMessage registra a mensagem do editor com seq crescente", () => {
    appendChatHistoryUserMessage(ROOT_A, "primeira mensagem");
    appendChatHistoryUserMessage(ROOT_A, "segunda mensagem");
    const history = getChatHistory(ROOT_A);
    assert.equal(history.length, 2);
    assert.equal(history[0].kind, "user");
    assert.equal((history[0] as { text: string }).text, "primeira mensagem");
    assert.equal((history[1] as { text: string }).text, "segunda mensagem");
    assert.ok(history[1].seq > history[0].seq, "seq deve ser monotônico");
  });

  it("chat-delta acumula na MESMA entry de assistente até chat-done fechar o turno", () => {
    appendChatHistoryEvent(ROOT_A, { event: "chat-delta", data: { text: "Ol" } });
    appendChatHistoryEvent(ROOT_A, { event: "chat-delta", data: { text: "á!" } });
    appendChatHistoryEvent(ROOT_A, { event: "chat-done", data: { sessionId: "s1", isError: false, result: null } });
    const history = getChatHistory(ROOT_A);
    assert.equal(history.length, 1);
    assert.equal(history[0].kind, "assistant");
    assert.equal((history[0] as { text: string }).text, "Olá!");
  });

  it("um novo turno (novo chat-delta após chat-done) abre uma entry de assistente NOVA, não continua a antiga", () => {
    appendChatHistoryEvent(ROOT_A, { event: "chat-delta", data: { text: "turno 1" } });
    appendChatHistoryEvent(ROOT_A, { event: "chat-done", data: { sessionId: "s1", isError: false, result: null } });
    appendChatHistoryEvent(ROOT_A, { event: "chat-delta", data: { text: "turno 2" } });
    const history = getChatHistory(ROOT_A);
    assert.equal(history.length, 2);
    assert.equal((history[0] as { text: string }).text, "turno 1");
    assert.equal((history[1] as { text: string }).text, "turno 2");
  });

  it("appendChatHistoryUserMessage fecha qualquer entry de assistente aberta do turno anterior (abort a meio de delta)", () => {
    appendChatHistoryEvent(ROOT_A, { event: "chat-delta", data: { text: "resposta cortada" } });
    // turno abortado — nenhum chat-done chega, o editor manda uma NOVA mensagem:
    appendChatHistoryUserMessage(ROOT_A, "nova pergunta");
    appendChatHistoryEvent(ROOT_A, { event: "chat-delta", data: { text: "resposta nova" } });
    const history = getChatHistory(ROOT_A);
    assert.deepEqual(
      history.map((e) => e.kind),
      ["assistant", "user", "assistant"],
    );
    assert.equal((history[0] as { text: string }).text, "resposta cortada");
    assert.equal((history[2] as { text: string }).text, "resposta nova");
  });

  it("chat-tool start/end/denied viram entries próprias, preservando toolUseId/status", () => {
    appendChatHistoryEvent(ROOT_A, {
      event: "chat-tool",
      data: { toolUseId: "tu-1", name: "Bash", status: "start", input: { command: "ls" } },
    });
    appendChatHistoryEvent(ROOT_A, {
      event: "chat-tool",
      data: { toolUseId: "tu-1", status: "end", isError: false },
    });
    appendChatHistoryEvent(ROOT_A, {
      event: "chat-tool",
      data: { toolUseId: "tu-2", name: "Write", status: "denied", reason: "negado" },
    });
    const history = getChatHistory(ROOT_A);
    assert.equal(history.length, 3);
    assert.deepEqual(history.map((e) => e.kind), ["tool", "tool", "tool"]);
    const [start, end, denied] = history as Array<{
      toolUseId: string;
      status: string;
      name: string;
      isError?: boolean;
      reason?: string;
    }>;
    assert.equal(start.toolUseId, "tu-1");
    assert.equal(start.status, "start");
    assert.equal(start.name, "Bash");
    assert.equal(end.toolUseId, "tu-1");
    assert.equal(end.status, "end");
    assert.equal(end.isError, false);
    assert.equal(denied.toolUseId, "tu-2");
    assert.equal(denied.status, "denied");
    assert.equal(denied.reason, "negado");
  });

  it("chat-error vira entry 'error' e fecha a entry de assistente aberta", () => {
    appendChatHistoryEvent(ROOT_A, { event: "chat-delta", data: { text: "meio de resposta" } });
    appendChatHistoryEvent(ROOT_A, { event: "chat-error", data: { message: "rate limit" } });
    const history = getChatHistory(ROOT_A);
    assert.deepEqual(
      history.map((e) => e.kind),
      ["assistant", "error"],
    );
    assert.equal((history[1] as { text: string }).text, "rate limit");
  });

  it("histórico de rootDirs diferentes não se mistura", () => {
    appendChatHistoryUserMessage(ROOT_A, "mensagem A");
    appendChatHistoryUserMessage(ROOT_B, "mensagem B");
    assert.equal(getChatHistory(ROOT_A).length, 1);
    assert.equal(getChatHistory(ROOT_B).length, 1);
    assert.equal((getChatHistory(ROOT_A)[0] as { text: string }).text, "mensagem A");
  });

  it("clearChatHistory zera só o rootDir indicado", () => {
    appendChatHistoryUserMessage(ROOT_A, "mensagem A");
    appendChatHistoryUserMessage(ROOT_B, "mensagem B");
    clearChatHistory(ROOT_A);
    assert.deepEqual(getChatHistory(ROOT_A), []);
    assert.equal(getChatHistory(ROOT_B).length, 1);
  });

  it("clearSession ('nova conversa') também zera o histórico — regressão: não reidratar transcript de conversa anterior", () => {
    appendChatHistoryUserMessage(ROOT_A, "mensagem antiga");
    clearSession(ROOT_A);
    assert.deepEqual(getChatHistory(ROOT_A), []);
  });

  it("cap de MAX_HISTORY_ENTRIES descarta as entries mais ANTIGAS, mantendo seq monotônico", () => {
    for (let i = 0; i < 410; i++) appendChatHistoryUserMessage(ROOT_A, `msg-${i}`);
    const history = getChatHistory(ROOT_A);
    assert.equal(history.length, 400, "buffer capado em 400 entries");
    // as 10 mais antigas (msg-0..msg-9) foram descartadas — a mais antiga
    // que sobra é msg-10.
    assert.equal((history[0] as { text: string }).text, "msg-10");
    assert.equal((history[history.length - 1] as { text: string }).text, "msg-409");
    // seq segue estritamente crescente mesmo após o trim.
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i].seq > history[i - 1].seq);
    }
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

describe("guard de frescor de arquivo revisável (#3806) — funções puras", () => {
  it("extractFilePathInput: extrai file_path de Read/Edit/Write, null pra shape estranho", () => {
    assert.equal(extractFilePathInput({ file_path: "/a/b.md" }), "/a/b.md");
    assert.equal(extractFilePathInput({ file_path: "  " }), null);
    assert.equal(extractFilePathInput({ command: "ls" }), null);
    assert.equal(extractFilePathInput(null), null);
    assert.equal(extractFilePathInput("string crua"), null);
    assert.equal(extractFilePathInput(undefined), null);
  });

  it("isGuardedReviewPath: só os 4 arquivos revisáveis sob data/editions/{AAMMDD}/", () => {
    const root = "/repo";
    assert.equal(isGuardedReviewPath(root, resolve(root, "data/editions/260720/02-reviewed.md")), true);
    assert.equal(isGuardedReviewPath(root, resolve(root, "data/editions/260720/01-categorized.md")), true);
    assert.equal(isGuardedReviewPath(root, resolve(root, "data/editions/260720/03-social.md")), true);
    assert.equal(
      isGuardedReviewPath(root, resolve(root, "data/editions/260720/_internal/newsletter-final.html")),
      true,
    );
    // fora do escopo: outro arquivo qualquer da edição, mesmo sob data/editions/.
    assert.equal(isGuardedReviewPath(root, resolve(root, "data/editions/260720/04-d1-2x1.jpg")), false);
    // AAMMDD com formato errado.
    assert.equal(isGuardedReviewPath(root, resolve(root, "data/editions/26072/02-reviewed.md")), false);
    // fora de data/editions inteiramente — scripts do repo nunca são guardados.
    assert.equal(isGuardedReviewPath(root, resolve(root, "scripts/studio-ui/studio-chat.ts")), false);
    // path fora do rootDir.
    assert.equal(isGuardedReviewPath(root, "/outro/lugar/data/editions/260720/02-reviewed.md"), false);
  });

  it("evaluateEditGuard: libera quando fora do escopo, sem baseline, ou mtimes iguais; bloqueia só na divergência real", () => {
    assert.equal(
      evaluateEditGuard({ filePath: "x", isGuarded: false, lastReadMtime: "t0", currentMtime: "t1" }).blocked,
      false,
      "fora do escopo (não é arquivo revisável) nunca bloqueia",
    );
    assert.equal(
      evaluateEditGuard({ filePath: "x", isGuarded: true, lastReadMtime: undefined, currentMtime: "t1" }).blocked,
      false,
      "sem baseline (sessão nunca leu este arquivo) — nada a comparar, libera",
    );
    assert.equal(
      evaluateEditGuard({ filePath: "x", isGuarded: true, lastReadMtime: "t0", currentMtime: null }).blocked,
      false,
      "arquivo sumiu do disco — fora do escopo deste guard",
    );
    assert.equal(
      evaluateEditGuard({ filePath: "x", isGuarded: true, lastReadMtime: "t0", currentMtime: "t0" }).blocked,
      false,
      "mtimes iguais — sem divergência",
    );
    const blocked = evaluateEditGuard({ filePath: "02-reviewed.md", isGuarded: true, lastReadMtime: "t0", currentMtime: "t1" });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.reason, EDIT_GUARD_STALE_MESSAGE("02-reviewed.md"));
    assert.match(blocked.reason!, /releia/i);
  });

  it("recordKnownFileMtime/getKnownFileMtime/clearKnownFileMtimeTracking: Maps isolados por rootDir", () => {
    const A = "/tmp/mtime-map-a";
    const B = "/tmp/mtime-map-b";
    assert.equal(getKnownFileMtime(A, "/a/f.md"), undefined);
    recordKnownFileMtime(A, "/a/f.md", "2026-01-01T00:00:00.000Z");
    assert.equal(getKnownFileMtime(A, "/a/f.md"), "2026-01-01T00:00:00.000Z");
    assert.equal(getKnownFileMtime(B, "/a/f.md"), undefined, "não vaza entre rootDirs");
    clearKnownFileMtimeTracking(A);
    assert.equal(getKnownFileMtime(A, "/a/f.md"), undefined);
  });
});

describe("guard de frescor (#3806) — fim-a-fim via runChatTurn + hooks reais (fs de verdade)", () => {
  let root: string;
  let filePath: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-chat-editguard-"));
    const editionDir = resolve(root, "data", "editions", "260721");
    mkdirSync(editionDir, { recursive: true });
    filePath = resolve(editionDir, "02-reviewed.md");
    writeFileSync(filePath, "conteúdo inicial", "utf8");
  });
  afterEach(() => {
    clearKnownFileMtimeTracking(root);
    rmSync(root, { recursive: true, force: true });
  });

  /** Monta um turno de brinquedo que dispara UMA tool call (Read/Edit/Write)
   * via os hooks reais que `runChatTurn` registra em `options.hooks` — o
   * MESMO mecanismo que o SDK de verdade invocaria (PreToolUse antes,
   * PostToolUse depois), simulando a sequência real de um agente. */
  async function runToolThroughHooks(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ pre: Awaited<ReturnType<HookCallback>>; post: Awaited<ReturnType<HookCallback>> }> {
    let captured: { pre: Awaited<ReturnType<HookCallback>>; post: Awaited<ReturnType<HookCallback>> } | undefined;
    const fakeQuery: QueryFn = (params) => {
      async function* gen() {
        const hooks = params.options?.hooks;
        const preHook = hooks?.PreToolUse?.[0]?.hooks[0];
        const postHook = hooks?.PostToolUse?.[0]?.hooks[0];
        assert.ok(preHook && postHook, "runChatTurn deveria registrar os hooks do guard de frescor");
        const baseInput = { session_id: "s1", transcript_path: "/tmp/t.jsonl", cwd: root };
        const pre = await preHook(
          { ...baseInput, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: input, tool_use_id: "tu-1" },
          "tu-1",
          { signal: new AbortController().signal },
        );
        // Só chama o PostToolUse se o Pre não bloqueou — espelha a semântica
        // real (tool bloqueada no Pre nunca executa, então nunca dispara Post).
        const post =
          pre.decision === "block"
            ? {}
            : await postHook(
                { ...baseInput, hook_event_name: "PostToolUse", tool_name: toolName, tool_input: input, tool_response: {} },
                "tu-1",
                { signal: new AbortController().signal },
              );
        captured = { pre, post };
        yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" } as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
    await runChatTurn({ message: "oi", cwd: root, queryFn: fakeQuery, onEvent: () => {} });
    assert.ok(captured, "o generator deveria ter rodado e capturado pre/post");
    return captured!;
  }

  it("Read seguido de Edit sem mudança externa — Edit NÃO é bloqueado", async () => {
    await runToolThroughHooks("Read", { file_path: filePath });
    const { pre } = await runToolThroughHooks("Edit", { file_path: filePath, old_string: "a", new_string: "b" });
    assert.notEqual(pre.decision, "block");
  });

  it("regressão (#3806): mtime obsoleto -> Edit negado com instrução de releitura", async () => {
    // Agente lê o arquivo (grava o mtime T0 como conhecido).
    await runToolThroughHooks("Read", { file_path: filePath });

    // Editor salva no painel do Studio ENQUANTO o arquivo já está em contexto
    // do agente — simulado como uma escrita externa com mtime estritamente
    // mais novo (utimesSync, determinístico — não depende de gap real de
    // relógio entre writes, mesmo padrão de studio-review.test.ts #3729).
    writeFileSync(filePath, "conteúdo salvo pelo editor no Studio", "utf8");
    const known = getKnownFileMtime(root, filePath);
    assert.ok(known);
    const newerDate = new Date(Date.parse(known!) + 5000);
    utimesSync(filePath, newerDate, newerDate);

    // Agente tenta editar em cima do conteúdo velho que ainda está no
    // contexto — deve ser NEGADO, não silenciosamente permitido.
    const { pre } = await runToolThroughHooks("Edit", {
      file_path: filePath,
      old_string: "conteúdo inicial",
      new_string: "edição do agente sobre versão velha",
    });
    assert.equal(pre.decision, "block");
    assert.match(pre.reason ?? "", /releia/i);
    assert.equal(pre.hookSpecificOutput?.permissionDecision, "deny");

    // O conteúdo do editor no disco não foi tocado (o Edit nunca rodou de fato
    // nesta simulação — o teste só chama o hook, não o Edit real; o ponto
    // central é a DECISÃO do hook, verificada acima).
  });

  it("depois de um Edit bem-sucedido, o PRÓPRIO write do agente atualiza o mtime conhecido — 2ª edição no mesmo turno não é bloqueada", async () => {
    await runToolThroughHooks("Read", { file_path: filePath });

    // 1ª edição: sucesso (mtime ainda igual ao lido).
    const first = await runToolThroughHooks("Edit", { file_path: filePath, old_string: "a", new_string: "b" });
    assert.notEqual(first.pre.decision, "block");

    // O Edit real (fora deste teste) escreveria o arquivo — simula isso
    // avançando o mtime em disco, exatamente como writeFileSync faria.
    writeFileSync(filePath, "conteúdo pós 1ª edição do agente", "utf8");
    // PostToolUse do 1º Edit já deveria ter atualizado o carimbo pro mtime que
    // vigorava então — refaz o tracking chamando Read de novo pra representar
    // "o agente sabe do próprio write" (equivalente ao PostToolUse do Edit
    // real, que roda IMEDIATAMENTE após o write; aqui o writeFileSync da
    // simulação aconteceu DEPOIS do hook, por isso o Read extra).
    await runToolThroughHooks("Read", { file_path: filePath });

    // 2ª edição no mesmo "turno" (mesma sessão): não bloqueada, porque o
    // carimbo já reflete o mtime pós-1ª-edição.
    const second = await runToolThroughHooks("Edit", { file_path: filePath, old_string: "b", new_string: "c" });
    assert.notEqual(second.pre.decision, "block");
  });

  it("arquivo FORA do escopo revisável (ex: scripts/*.ts) nunca é bloqueado, mesmo com mtime obsoleto", async () => {
    const scriptPath = resolve(root, "scripts", "algum-script.ts");
    mkdirSync(resolve(root, "scripts"), { recursive: true });
    writeFileSync(scriptPath, "// v1", "utf8");
    await runToolThroughHooks("Read", { file_path: scriptPath });

    writeFileSync(scriptPath, "// v2 (mudança externa)", "utf8");
    const known = getKnownFileMtime(root, scriptPath);
    const newerDate = new Date(Date.parse(known!) + 5000);
    utimesSync(scriptPath, newerDate, newerDate);

    const { pre } = await runToolThroughHooks("Edit", { file_path: scriptPath, old_string: "v1", new_string: "v3" });
    assert.notEqual(pre.decision, "block");
  });

  it("Write (não só Edit) também é coberto pelo guard", async () => {
    await runToolThroughHooks("Read", { file_path: filePath });
    writeFileSync(filePath, "conteúdo salvo pelo editor no Studio", "utf8");
    const known = getKnownFileMtime(root, filePath);
    const newerDate = new Date(Date.parse(known!) + 5000);
    utimesSync(filePath, newerDate, newerDate);

    const { pre } = await runToolThroughHooks("Write", { file_path: filePath, content: "sobrescrita cega do agente" });
    assert.equal(pre.decision, "block");
  });

  it("clearSession zera o tracking de mtime — pós-clear, sem baseline, mesma tool não é bloqueada (nova conversa começa sem 'saber' de nada)", async () => {
    await runToolThroughHooks("Read", { file_path: filePath });
    writeFileSync(filePath, "mudança externa", "utf8");
    const known = getKnownFileMtime(root, filePath);
    const newerDate = new Date(Date.parse(known!) + 5000);
    utimesSync(filePath, newerDate, newerDate);

    clearSession(root); // "nova conversa"
    assert.equal(getKnownFileMtime(root, filePath), undefined);

    const { pre } = await runToolThroughHooks("Edit", { file_path: filePath, old_string: "x", new_string: "y" });
    assert.notEqual(pre.decision, "block", "sem baseline pós-clear, nada a comparar — não deveria bloquear");
  });
});

describe("createCloseAbortGuard (#3887) — debounce do abort no close da request de /api/chat", () => {
  it("close PERSISTENTE (sem cancel dentro da janela) aborta como antes — timer fake", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let abortCalls = 0;
    const guard = createCloseAbortGuard(() => {
      abortCalls++;
    }, 2500);

    guard.onClose();
    assert.equal(abortCalls, 0, "não aborta na hora — só depois do debounce");

    t.mock.timers.tick(2499);
    assert.equal(abortCalls, 0, "ainda dentro da janela — não deveria ter abortado");

    t.mock.timers.tick(1);
    assert.equal(abortCalls, 1, "janela esgotada — close persistente aborta");
  });

  it("close TRANSITÓRIO (<2s, cancel chega antes do timer disparar) NÃO aborta a sessão", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let abortCalls = 0;
    const guard = createCloseAbortGuard(() => {
      abortCalls++;
    }, 2500);

    guard.onClose();
    t.mock.timers.tick(1500); // < 2500ms — turno termina normalmente aqui
    guard.cancel(); // mesmo ponto onde handleApiChat chama antes de res.end()

    t.mock.timers.tick(2000); // passa MUITO da janela original
    assert.equal(abortCalls, 0, "cancel() dentro da janela devia ter cortado o abort de vez");
  });

  it("cancel() sem nenhum close pendente é no-op seguro (turno termina sem NUNCA ter caído)", () => {
    let abortCalls = 0;
    const guard = createCloseAbortGuard(() => {
      abortCalls++;
    }, 2500);
    assert.doesNotThrow(() => guard.cancel());
    assert.equal(abortCalls, 0);
  });

  it("2 close() em sequência (defensivo) não duplica o abort — só o timer mais recente conta", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let abortCalls = 0;
    const guard = createCloseAbortGuard(() => {
      abortCalls++;
    }, 2500);

    guard.onClose();
    t.mock.timers.tick(1000);
    guard.onClose(); // 2º close — reagenda um novo timer de 2500ms a partir daqui

    t.mock.timers.tick(2500);
    assert.equal(abortCalls, 1, "deveria abortar exatamente 1 vez, no timer do 2º close");
  });

  it("DEFAULT_CHAT_CLOSE_ABORT_DEBOUNCE_MS é usado quando debounceMs é omitido", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let abortCalls = 0;
    const guard = createCloseAbortGuard(() => {
      abortCalls++;
    }); // sem 2º argumento — usa o default

    guard.onClose();
    t.mock.timers.tick(DEFAULT_CHAT_CLOSE_ABORT_DEBOUNCE_MS - 1);
    assert.equal(abortCalls, 0);
    t.mock.timers.tick(1);
    assert.equal(abortCalls, 1);
  });
});
