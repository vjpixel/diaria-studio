/**
 * threads-null-body-13193.test.ts (#13193)
 *
 * Dois resíduos do review do PR #13183 (#13100):
 *   1. `/threads_publish` devolvendo o corpo `null` (JSON válido): o acesso a
 *      `data.error` lançava TypeError e a falha saía como exceção genérica.
 *      Agora vira "resposta não-JSON" com a mesma classificação do corpo
 *      ilegível: 2xx/5xx = `send_unknown`, 4xx = falha definitiva.
 *   2. `reason` do carrossel com 3 erros completos da Meta: as tentativas
 *      anteriores à última saem só com `HTTP status + code/subcode`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  fireQueueEntry,
  summarizeThreadsHttpError,
  THREADS_CAROUSEL_PARENT_MAX_ATTEMPTS,
} from "../src/dispatch.ts";
import type { QueueEntry } from "../src/index.ts";

const CONFIG = {
  webhookUrl: "https://make.test/diaria",
  threads: { userId: "acc", accessToken: "tok", apiVersion: "v1.0" },
};

function textEntry(): QueueEntry {
  return {
    text: "Post de teste",
    image_url: null,
    scheduled_at: "2026-11-16T09:45:00-03:00",
    destaque: "d1",
    created_at: "2026-11-15T20:00:00.000Z",
    channel: "threads",
  };
}

function bodyOf(init: RequestInit | undefined): string {
  return init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
}

describe("#13193 publishThreadsCreation: corpo null não lança", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockPublish(status: number, body: string) {
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.endsWith("/threads_publish")) return new Response(body, { status });
      if (u.endsWith("/threads")) return new Response(JSON.stringify({ id: "container-1" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  }

  it("200 com corpo null: send_unknown descrito, sem exceção", async () => {
    mockPublish(200, "null");
    const outcome = await fireQueueEntry(textEntry(), CONFIG);
    assert.equal(outcome.status, "send_unknown");
    const reason = (outcome as { reason: string }).reason;
    assert.match(reason, /resposta não-JSON: HTTP 200: null/);
    assert.match(reason, /container-1/);
  });

  it("400 com corpo null: falha definitiva (failed), não ambígua", async () => {
    mockPublish(400, "null");
    const outcome = await fireQueueEntry(textEntry(), CONFIG);
    assert.equal(outcome.status, "failed");
    assert.match((outcome as { reason: string }).reason, /resposta não-JSON: HTTP 400: null/);
  });

  it("502 com corpo null: send_unknown", async () => {
    mockPublish(502, "null");
    const outcome = await fireQueueEntry(textEntry(), CONFIG);
    assert.equal(outcome.status, "send_unknown");
  });
});

describe("#13193 reason do carrossel: só a última tentativa com o erro completo", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalSetTimeout: typeof globalThis.setTimeout;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void) => { fn(); return 0 as any; };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });

  it("anteriores resumidas em HTTP + code/subcode; fbtrace_id só uma vez", async () => {
    let parentAttempt = 0;
    let child = 0;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      const body = bodyOf(init);
      if (u.includes("?fields=status")) return new Response(JSON.stringify({ status: "FINISHED" }), { status: 200 });
      if (u.endsWith("/threads") && body.includes("media_type=CAROUSEL")) {
        parentAttempt++;
        return new Response(
          JSON.stringify({
            error: {
              message: "Invalid parameter",
              type: "OAuthException",
              code: 100,
              error_subcode: 4279009,
              error_user_msg: "Um dos itens do carrossel não pôde ser usado.",
              fbtrace_id: `trace-${parentAttempt}`,
            },
          }),
          { status: 400 },
        );
      }
      if (u.endsWith("/threads")) {
        child++;
        return new Response(JSON.stringify({ id: `child-${child}` }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const outcome = await fireQueueEntry(
      { ...textEntry(), image_urls: ["a", "b", "c"].map((s) => `https://eia.diar.ia.br/img/${s}.jpg`) },
      CONFIG,
    );
    assert.equal(outcome.status, "dlq");
    const reason = (outcome as { reason: string }).reason;
    const n = THREADS_CAROUSEL_PARENT_MAX_ATTEMPTS;
    assert.equal(parentAttempt, n);
    for (let i = 1; i < n; i++) {
      assert.ok(reason.includes(`tentativa ${i}: HTTP 400 (code=100, subcode=4279009)`), `tentativa ${i} resumida: ${reason}`);
      assert.ok(!reason.includes(`trace-${i}`), `tentativa ${i} sem fbtrace_id`);
    }
    assert.ok(reason.includes(`fbtrace_id=trace-${n}`), "última tentativa com o detalhe completo");
    assert.equal(reason.match(/Um dos itens do carrossel/g)?.length, 1, "user_msg só uma vez");
  });
});

describe("#13193 summarizeThreadsHttpError", () => {
  it("status + code + subcode", () => {
    assert.equal(summarizeThreadsHttpError(400, { code: 100, error_subcode: 4279009, message: "x" }), "HTTP 400 (code=100, subcode=4279009)");
  });
  it("sem error: só o status", () => {
    assert.equal(summarizeThreadsHttpError(503, undefined), "HTTP 503");
  });
});
