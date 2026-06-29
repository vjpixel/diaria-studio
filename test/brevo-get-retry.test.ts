import { test } from "node:test";
import assert from "node:assert/strict";
import { brevoGet } from "../scripts/lib/brevo-client.ts";

// #2651: brevoGet ganhou _sleep injetável → o caminho de fallback-backoff
// (429 SEM header Retry-After, usa RETRY_MS) fica testável sem espera real.

test("brevoGet: retry no fallback-backoff usa RETRY_MS via _sleep injetável", async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  const mockFetch = async (): Promise<Response> => {
    calls++;
    if (calls < 3) return new Response("rate", { status: 429 }); // sem Retry-After
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
  const sleeps: number[] = [];
  try {
    const r = await brevoGet("key", "/x", async (ms) => {
      sleeps.push(ms);
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(calls, 3); // 2× 429 + 1× 200
    assert.deepEqual(sleeps, [1000, 3000]); // RETRY_MS[0], RETRY_MS[1]
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("brevoGet: 404 → {status:404, body:{}} sem retry", async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  try {
    const r = await brevoGet("key", "/missing", async () => {});
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, {});
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("brevoGet: 401 → throw imediato (sem retry)", async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("nope", { status: 401 });
  }) as unknown as typeof globalThis.fetch;
  try {
    await assert.rejects(() => brevoGet("key", "/x", async () => {}), /401/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});
