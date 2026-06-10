/**
 * brevo-list-all-lists.test.ts (#2018)
 *
 * Testa brevoListAllLists (scripts/lib/brevo-client.ts) — extraído da triplicação
 * em clarice-import-waves/sends/split-cells. Mock de fetch; sem rede.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// Mock de fetch global — sem rede
function makeJsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => "application/json" },
  } as unknown as Response);
}

describe("brevoListAllLists (#2018 — extraído de 3 scripts)", () => {
  it("agrega uma única página (< 50 listas)", async () => {
    const lists = [
      { id: 1, name: "L1" },
      { id: 2, name: "L2" },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => makeJsonResponse({ lists }) as unknown as Response;
    try {
      const { brevoListAllLists } = await import("../scripts/lib/brevo-client.ts");
      const result = await brevoListAllLists("dummy-key");
      assert.deepEqual(result, lists);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retorna [] quando 'lists' ausente na resposta", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => makeJsonResponse({}) as unknown as Response;
    try {
      const { brevoListAllLists } = await import("../scripts/lib/brevo-client.ts");
      const result = await brevoListAllLists("dummy-key");
      assert.deepEqual(result, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lança erro em resposta não-ok (4xx/5xx)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
      headers: { get: () => null },
    } as unknown as Response);
    try {
      const { brevoListAllLists } = await import("../scripts/lib/brevo-client.ts");
      await assert.rejects(
        () => brevoListAllLists("bad-key"),
        /401/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
