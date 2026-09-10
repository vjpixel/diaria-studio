/**
 * test/continuo-tick-sidecar.test.ts (#7814)
 *
 * Regressão pro sidecar enxuto de tick do contínuo: o detector de
 * fabricação (#7537) perde a evidência quando `~/.hermes/logs/agent.log*`
 * rotaciona antes de alguém investigar — este módulo extrai o mínimo
 * necessário (chamadas de ferramenta + session_id) pra `data/continuo/
 * tick-sidecars/`, que não rotaciona.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTickSidecar,
  filterToolCallsBySessionPrefix,
  groupBySession,
  isSessionClosed,
  parseAgentLogLine,
  parseAgentLogText,
  selectSessionsToCapture,
  selectSidecarsToPrune,
  sidecarFileName,
  type ToolCallEvent,
} from "../scripts/lib/continuo-tick-sidecar.ts";

describe("parseAgentLogLine", () => {
  it("parseia uma linha 'tool X completed' com duração e tamanho", () => {
    const line =
      "2026-09-09 15:41:23,039 INFO [cron_5d791ef6fc2c_20260909_123316] agent.tool_executor: tool terminal completed (4.78s, 4046 chars)";
    const event = parseAgentLogLine(line);
    assert.deepEqual(event, {
      sessionId: "cron_5d791ef6fc2c_20260909_123316",
      at: "2026-09-09T15:41:23.039Z",
      tool: "terminal",
      outcome: "completed",
      durationS: 4.78,
      sizeChars: 4046,
    });
  });

  it("parseia uma linha 'Tool X returned error' (maiúscula, sem tamanho)", () => {
    const line =
      '2026-09-02 05:27:09,312 WARNING [cron_5d791ef6fc2c_20260902_022624] agent.tool_executor: Tool terminal returned error (3.05s): {"output": "..."}';
    const event = parseAgentLogLine(line);
    assert.ok(event);
    assert.equal(event?.sessionId, "cron_5d791ef6fc2c_20260902_022624");
    assert.equal(event?.outcome, "returned_error");
    assert.equal(event?.durationS, 3.05);
    assert.equal(event?.sizeChars, null);
  });

  it("parseia o achado real do #7641 — write_file completed, 611 chars", () => {
    const line =
      "2026-09-08 09:51:26,124 INFO [cron_5d791ef6fc2c_20260908_064744] agent.tool_executor: tool write_file completed (0.20s, 611 chars)";
    const event = parseAgentLogLine(line);
    assert.equal(event?.tool, "write_file");
    assert.equal(event?.sizeChars, 611);
    assert.equal(event?.at, "2026-09-08T09:51:26.124Z");
  });

  it("devolve null pra linha sem bracket de sessão — nunca inventa sessionId", () => {
    const line =
      '2026-09-09 18:58:45,199 INFO agent.tool_executor: tool read_file failed (0.06s): {"error": "File not found"}';
    assert.equal(parseAgentLogLine(line), null);
  });

  it("devolve null pra linha que não é do tool_executor", () => {
    const line = "2026-09-09 15:41:07,528 INFO [cron_x] agent.chat_completion_helpers: Scaling watchdog";
    assert.equal(parseAgentLogLine(line), null);
  });

  it("devolve null pra linha vazia/lixo", () => {
    assert.equal(parseAgentLogLine(""), null);
    assert.equal(parseAgentLogLine("não é uma linha de log"), null);
  });
});

describe("parseAgentLogText", () => {
  it("ignora linhas que não casam, mantém só as válidas, em ordem", () => {
    const text = [
      "linha de lixo",
      "2026-09-09 15:41:23,039 INFO [cron_A_1] agent.tool_executor: tool terminal completed (1.0s, 10 chars)",
      "outra linha de lixo",
      "2026-09-09 15:41:24,000 INFO [cron_A_1] agent.tool_executor: tool write_file completed (0.1s, 20 chars)",
    ].join("\n");
    const events = parseAgentLogText(text);
    assert.equal(events.length, 2);
    assert.equal(events[0].tool, "terminal");
    assert.equal(events[1].tool, "write_file");
  });
});

describe("filterToolCallsBySessionPrefix", () => {
  it("mantém só sessões do job do contínuo", () => {
    const events: ToolCallEvent[] = [
      { sessionId: "cron_5d791ef6fc2c_20260909_123316", at: "t1", tool: "a", outcome: "completed", durationS: null, sizeChars: null },
      { sessionId: "cron_outrojob_20260909_123316", at: "t2", tool: "b", outcome: "completed", durationS: null, sizeChars: null },
      { sessionId: "20260825_163952_a8cfcc2a", at: "t3", tool: "c", outcome: "completed", durationS: null, sizeChars: null },
    ];
    const filtered = filterToolCallsBySessionPrefix(events, "cron_5d791ef6fc2c_");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].sessionId, "cron_5d791ef6fc2c_20260909_123316");
  });
});

describe("groupBySession + buildTickSidecar", () => {
  it("agrupa e ordena por timestamp, calcula first/last/count", () => {
    const events: ToolCallEvent[] = [
      { sessionId: "s1", at: "2026-09-09T10:00:02.000Z", tool: "b", outcome: "completed", durationS: 1, sizeChars: 2 },
      { sessionId: "s1", at: "2026-09-09T10:00:00.000Z", tool: "a", outcome: "completed", durationS: 1, sizeChars: 1 },
      { sessionId: "s2", at: "2026-09-09T09:00:00.000Z", tool: "z", outcome: "failed", durationS: null, sizeChars: null },
    ];
    const groups = groupBySession(events);
    assert.equal(groups.size, 2);
    const sidecar = buildTickSidecar("s1", groups.get("s1")!, "2026-09-09T11:00:00.000Z");
    assert.equal(sidecar.sessionId, "s1");
    assert.equal(sidecar.firstAt, "2026-09-09T10:00:00.000Z");
    assert.equal(sidecar.lastAt, "2026-09-09T10:00:02.000Z");
    assert.equal(sidecar.toolCallCount, 2);
    assert.equal(sidecar.toolCalls[0].tool, "a");
    assert.equal(sidecar.toolCalls[1].tool, "b");
    assert.equal(sidecar.capturedAt, "2026-09-09T11:00:00.000Z");
    // sessionId não vaza duplicado dentro de cada tool call
    assert.equal((sidecar.toolCalls[0] as unknown as { sessionId?: string }).sessionId, undefined);
  });
});

describe("isSessionClosed", () => {
  it("true quando a última chamada foi há mais que o mínimo de ociosidade", () => {
    assert.equal(isSessionClosed("2026-09-09T10:00:00.000Z", "2026-09-09T11:01:00.000Z", 60), true);
  });
  it("false quando ainda dentro da janela de ociosidade", () => {
    assert.equal(isSessionClosed("2026-09-09T10:00:00.000Z", "2026-09-09T10:30:00.000Z", 60), false);
  });
  it("false (nunca 'encerrada') quando now é ANTERIOR a lastAt — clock skew", () => {
    assert.equal(isSessionClosed("2026-09-09T12:00:00.000Z", "2026-09-09T10:00:00.000Z", 60), false);
  });
  it("false quando alguma data é inválida — indeterminado nunca vira 'encerrada'", () => {
    assert.equal(isSessionClosed("não-é-data", "2026-09-09T10:00:00.000Z", 60), false);
    assert.equal(isSessionClosed("2026-09-09T10:00:00.000Z", "não-é-data", 60), false);
  });
});

describe("selectSessionsToCapture", () => {
  it("só sessões encerradas e ainda não capturadas", () => {
    const now = "2026-09-09T12:00:00.000Z";
    const sessions = new Map<string, ToolCallEvent[]>([
      ["s-closed-new", [{ sessionId: "s-closed-new", at: "2026-09-09T10:00:00.000Z", tool: "a", outcome: "completed", durationS: null, sizeChars: null }]],
      ["s-open", [{ sessionId: "s-open", at: "2026-09-09T11:55:00.000Z", tool: "a", outcome: "completed", durationS: null, sizeChars: null }]],
      ["s-closed-already-captured", [{ sessionId: "s-closed-already-captured", at: "2026-09-09T09:00:00.000Z", tool: "a", outcome: "completed", durationS: null, sizeChars: null }]],
    ]);
    const alreadyCaptured = new Set(["s-closed-already-captured"]);
    const toCapture = selectSessionsToCapture(sessions, alreadyCaptured, now, 60);
    assert.deepEqual(toCapture, ["s-closed-new"]);
  });

  it("captura idempotente: sessão já capturada nunca reaparece", () => {
    const now = "2026-09-09T12:00:00.000Z";
    const sessions = new Map<string, ToolCallEvent[]>([
      ["s1", [{ sessionId: "s1", at: "2026-09-09T09:00:00.000Z", tool: "a", outcome: "completed", durationS: null, sizeChars: null }]],
    ]);
    assert.deepEqual(selectSessionsToCapture(sessions, new Set(["s1"]), now, 60), []);
  });
});

describe("selectSidecarsToPrune", () => {
  it("apaga só sidecars mais velhos que a janela de retenção", () => {
    const now = "2026-10-25T00:00:00.000Z"; // 45 dias depois de 09/09
    const sidecars = [
      { name: "old.json", capturedAt: "2026-09-09T00:00:00.000Z" }, // >45d
      { name: "recent.json", capturedAt: "2026-10-20T00:00:00.000Z" }, // <45d
    ];
    const pruned = selectSidecarsToPrune(sidecars, now, 45);
    assert.deepEqual(pruned, ["old.json"]);
  });

  it("nunca apaga sidecar com capturedAt ilegível — indeterminado não vira remoção", () => {
    const sidecars = [{ name: "corrompido.json", capturedAt: "" }];
    const pruned = selectSidecarsToPrune(sidecars, "2026-10-25T00:00:00.000Z", 45);
    assert.deepEqual(pruned, []);
  });

  it("retenção mínima de 7 dias (âncora do item 2 da issue) segue viva sob 45d default", () => {
    const now = "2026-09-15T00:00:00.000Z"; // 6 dias depois
    const sidecars = [{ name: "s.json", capturedAt: "2026-09-09T00:00:00.000Z" }];
    assert.deepEqual(selectSidecarsToPrune(sidecars, now, 45), []);
  });
});

describe("sidecarFileName", () => {
  it("é `{sessionId}.json`", () => {
    assert.equal(sidecarFileName("cron_5d791ef6fc2c_20260909_123316"), "cron_5d791ef6fc2c_20260909_123316.json");
  });
});
