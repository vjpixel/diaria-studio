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

  // #2018-fix: testa paginação multi-página — 50 items na primeira página (boundary)
  // leva a uma segunda chamada; se a segunda retornar vazio, termina com 50 items total.
  it("paginação: exatamente 50 items na 1ª página → faz 2ª chamada (página vazia), retorna 50 total", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `L${i + 1}` }));
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: RequestInfo | URL) => {
      callCount++;
      const urlStr = String(url);
      // 1ª chamada (offset=0): retorna 50 listas
      if (urlStr.includes("offset=0")) return makeJsonResponse({ lists: page1 }) as unknown as Response;
      // 2ª chamada (offset=50): retorna vazio → termina paginação
      return makeJsonResponse({ lists: [] }) as unknown as Response;
    };
    try {
      const { brevoListAllLists } = await import("../scripts/lib/brevo-client.ts");
      const result = await brevoListAllLists("dummy-key");
      assert.equal(result.length, 50, "deve retornar os 50 items da 1ª página");
      assert.equal(callCount, 2, "deve fazer exatamente 2 chamadas (boundary: offset=0 e offset=50)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("paginação multi-página: 2 páginas de 50 + 1 item → 101 items total", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `L${i + 1}` }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({ id: 51 + i, name: `L${51 + i}` }));
    const page3 = [{ id: 101, name: "L101" }];
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: RequestInfo | URL) => {
      callCount++;
      const offset = new URL(String(url)).searchParams.get("offset") ?? "0";
      if (offset === "0") return makeJsonResponse({ lists: page1 }) as unknown as Response;
      if (offset === "50") return makeJsonResponse({ lists: page2 }) as unknown as Response;
      return makeJsonResponse({ lists: page3 }) as unknown as Response;
    };
    try {
      const { brevoListAllLists } = await import("../scripts/lib/brevo-client.ts");
      const result = await brevoListAllLists("dummy-key");
      assert.equal(result.length, 101, "deve agregar 101 items de 3 páginas");
      assert.equal(callCount, 3, "deve fazer exatamente 3 chamadas");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
