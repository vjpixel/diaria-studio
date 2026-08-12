import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkClariceHealth,
  checkClariceMcpHealth,
  parseMcpSseResponse,
  parseHealthcheckArgs,
  DEFAULT_TIMEOUT_MS,
  OBSERVED_PROBE_LATENCY_MS,
} from "../scripts/clarice-healthcheck.ts";

describe("checkClariceHealth", () => {
  it("retorna ok=true em 200 com latency_ms preenchido", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("[]", { status: 200 });
    const result = await checkClariceHealth({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 1000,
    });
    assert.equal(result.ok, true);
    assert.equal(typeof result.latency_ms, "number");
    assert.equal(result.error, undefined);
  });

  it("retorna ok=false em 401", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("unauthorized", { status: 401 });
    const result = await checkClariceHealth({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /HTTP 401/);
  });

  it("retorna ok=false em network error (fetch lança)", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await checkClariceHealth({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /ECONNREFUSED/);
  });

  it("respeita timeout — aborta se demora demais", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const result = await checkClariceHealth({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 50,
    });
    assert.equal(result.ok, false);
  });

  // Regressão: o default era 5s, mas o cortex leva ~16s até no probe de 3 chars.
  // O healthcheck abortava SEMPRE → Stage 0 marcava CLARICE_REST=false com o REST
  // saudável → Stage 2 pulava o fallback e ia direto pro halt banner.
  // Os testes acima passam timeoutMs explícito, então nenhum exercitava o default.
  it("default tolera a latência real do cortex (~16s)", () => {
    assert.ok(
      DEFAULT_TIMEOUT_MS > OBSERVED_PROBE_LATENCY_MS,
      `DEFAULT_TIMEOUT_MS (${DEFAULT_TIMEOUT_MS}ms) precisa folgar sobre a ` +
        `latência observada (${OBSERVED_PROBE_LATENCY_MS}ms) ou o healthcheck ` +
        `reporta ok=false com o REST saudável`,
    );
  });

  it("usa o default quando timeoutMs é omitido — resposta lenta ainda dá ok=true", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = false;
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((resolve) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        setTimeout(() => resolve(new Response("[]", { status: 200 })), OBSERVED_PROBE_LATENCY_MS);
      });

    const pending = checkClariceHealth({ apiKey: "k", fetchImpl }); // sem timeoutMs → default
    t.mock.timers.tick(OBSERVED_PROBE_LATENCY_MS);
    const result = await pending;

    assert.equal(aborted, false, "não deve abortar antes do default");
    assert.equal(result.ok, true);
  });
});

describe("parseHealthcheckArgs", () => {
  it("sem flags → timeoutMs undefined (cai no default)", () => {
    assert.deepEqual(parseHealthcheckArgs([]), {});
  });

  it("--timeout-ms N → timeoutMs numérico", () => {
    assert.deepEqual(parseHealthcheckArgs(["--timeout-ms", "45000"]), {
      timeoutMs: 45000,
    });
  });

  it("--timeout-ms inválido → lança", () => {
    assert.throws(() => parseHealthcheckArgs(["--timeout-ms", "0"]), /número positivo/);
    assert.throws(() => parseHealthcheckArgs(["--timeout-ms", "abc"]), /número positivo/);
  });

  it("não consome a flag seguinte como valor", () => {
    assert.deepEqual(parseHealthcheckArgs(["--timeout-ms", "--outra"]), {});
  });

  it("--mcp → mcp: true", () => {
    assert.deepEqual(parseHealthcheckArgs(["--mcp"]), { mcp: true });
  });

  it("--mcp combinado com --timeout-ms → os dois presentes", () => {
    assert.deepEqual(parseHealthcheckArgs(["--mcp", "--timeout-ms", "5000"]), {
      mcp: true,
      timeoutMs: 5000,
    });
  });
});

describe("parseMcpSseResponse (#5114)", () => {
  it("extrai o JSON da linha 'data: ' de um corpo SSE de 1 evento", () => {
    const body = 'event: message\ndata: {"result":{"isError":false},"jsonrpc":"2.0","id":2}\n\n';
    assert.deepEqual(parseMcpSseResponse(body), { result: { isError: false }, jsonrpc: "2.0", id: 2 });
  });

  it("usa a ÚLTIMA linha 'data:' quando há mais de uma", () => {
    const body = 'event: message\ndata: {"id":1}\nevent: message\ndata: {"id":2}\n\n';
    assert.deepEqual(parseMcpSseResponse(body), { id: 2 });
  });

  it("sem linha 'data:', tenta o corpo inteiro como JSON puro (fallback)", () => {
    assert.deepEqual(parseMcpSseResponse('{"result":{"isError":false}}'), { result: { isError: false } });
  });

  it("retorna null se não houver linha 'data:' NEM o corpo for JSON válido", () => {
    assert.equal(parseMcpSseResponse("event: message\n\n"), null);
    assert.equal(parseMcpSseResponse(""), null);
  });

  it("retorna null se a linha 'data:' não for JSON válido — nunca lança", () => {
    assert.doesNotThrow(() => parseMcpSseResponse("data: {not json\n"));
    assert.equal(parseMcpSseResponse("data: {not json\n"), null);
  });
});

// #5114 — achado ao vivo (12/08/2026, curl contra mcp.clarice.ai com key
// inválida): o transporte MCP responde SEMPRE HTTP 200, mesmo em auth
// rejeitada. O erro real vem dentro do envelope JSON-RPC
// (`result.isError: true`), só depois de uma TOOL ser chamada — `initialize`
// sozinho nunca revela nada sobre a validade da key. Os mocks abaixo
// reproduzem esse formato exato, não um formato inventado.
describe("checkClariceMcpHealth (#5114)", () => {
  function sseBody(json: unknown): string {
    return `event: message\ndata: ${JSON.stringify(json)}\n\n`;
  }

  it("ok=true quando initialize + tools/call respondem 200 sem isError", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call++;
      if (call === 1) {
        return new Response(
          sseBody({ result: { protocolVersion: "2024-11-05" }, jsonrpc: "2.0", id: 1 }),
          { status: 200, headers: { "mcp-session-id": "sess-1", "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        sseBody({ result: { content: [{ type: "text", text: "ola" }], isError: false }, jsonrpc: "2.0", id: 2 }),
        { status: 200 },
      );
    };
    const result = await checkClariceMcpHealth({ apiKey: "valid-key", fetchImpl, timeoutMs: 1000 });
    assert.equal(result.ok, true);
    assert.equal(typeof result.latency_ms, "number");
    assert.equal(result.error, undefined);
    assert.equal(call, 2, "esperava 2 round-trips: initialize + tools/call");
  });

  // Reprodução EXATA do sintoma do #5114: key inválida -> transporte MCP 200,
  // erro só aparece em result.isError + content[0].text.
  it("ok=false quando o cortex rejeita a key — isError=true dentro do envelope 200", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call++;
      if (call === 1) {
        return new Response(sseBody({ result: {}, jsonrpc: "2.0", id: 1 }), {
          status: 200,
          headers: { "mcp-session-id": "sess-2" },
        });
      }
      return new Response(
        sseBody({
          result: {
            content: [{ type: "text", text: "Erro: a API da Clarice retornou HTTP 401. Tente novamente." }],
            isError: true,
          },
          jsonrpc: "2.0",
          id: 2,
        }),
        { status: 200 },
      );
    };
    const result = await checkClariceMcpHealth({ apiKey: "invalid-key", fetchImpl, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.error!, /HTTP 401/);
  });

  it("ok=false quando initialize responde HTTP não-200", async () => {
    const fetchImpl: typeof fetch = async () => new Response("bad gateway", { status: 502 });
    const result = await checkClariceMcpHealth({ apiKey: "k", fetchImpl, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.error!, /HTTP 502.*initialize/);
  });

  it("ok=false quando initialize não devolve mcp-session-id", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(sseBody({ result: {}, jsonrpc: "2.0", id: 1 }), { status: 200 }); // sem header de sessão
    const result = await checkClariceMcpHealth({ apiKey: "k", fetchImpl, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.error!, /mcp-session-id/);
  });

  it("ok=false quando tools/call responde HTTP não-200", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call++;
      if (call === 1) {
        return new Response(sseBody({ result: {}, jsonrpc: "2.0", id: 1 }), {
          status: 200,
          headers: { "mcp-session-id": "sess-3" },
        });
      }
      return new Response("internal error", { status: 500 });
    };
    const result = await checkClariceMcpHealth({ apiKey: "k", fetchImpl, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.error!, /HTTP 500.*tools\/call/);
  });

  it("ok=false quando o corpo do tools/call é ilegível (sem linha data:)", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call++;
      if (call === 1) {
        return new Response(sseBody({ result: {}, jsonrpc: "2.0", id: 1 }), {
          status: 200,
          headers: { "mcp-session-id": "sess-4" },
        });
      }
      return new Response("garbage, not sse", { status: 200 });
    };
    const result = await checkClariceMcpHealth({ apiKey: "k", fetchImpl, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.error!, /ilegível/);
  });

  it("ok=false em network error (fetch lança)", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await checkClariceMcpHealth({ apiKey: "k", fetchImpl, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.error!, /ECONNREFUSED/);
  });

  it("respeita timeout — aborta se demora demais", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const result = await checkClariceMcpHealth({ apiKey: "k", fetchImpl, timeoutMs: 50 });
    assert.equal(result.ok, false);
  });
});
