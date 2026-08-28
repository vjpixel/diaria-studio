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

// #6288: espelha o fix de #6284/#6035/#5942 em withBrevo429Retry — quando o
// Retry-After devolvido excede o orçamento (30s, BREVO_RETRY_GIVE_UP_MS),
// brevoGet desiste JÁ em vez de dormir o teto e retentar sabendo que vai
// falhar de novo (rate limit é por CONTA/HORA).
test("brevoGet: 429 com Retry-After maior que o orçamento → desiste sem dormir", async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    // Medido ao vivo (#6124): Retry-After de 3402s (~57min) contra um
    // orçamento de 30s por tentativa.
    return new Response("rate", { status: 429, headers: { "retry-after": "3402" } });
  }) as unknown as typeof globalThis.fetch;
  const sleeps: number[] = [];
  try {
    await assert.rejects(
      () => brevoGet("key", "/x", async (ms) => { sleeps.push(ms); }),
      /Retry-After 3402s excede o orçamento de 30s/,
    );
    assert.equal(calls, 1, "não deve retentar — desiste na 1ª tentativa");
    assert.deepEqual(sleeps, [], "nunca deve dormir — clock injetado nunca é chamado");
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
