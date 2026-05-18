import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  correctTextViaREST,
  extractSuggestions,
} from "../scripts/clarice-correct.ts";

function mockFetch(response: {
  status: number;
  body: unknown;
}): typeof fetch {
  return async () => {
    return new Response(
      typeof response.body === "string"
        ? response.body
        : JSON.stringify(response.body),
      { status: response.status, headers: { "Content-Type": "application/json" } },
    );
  };
}

describe("correctTextViaREST", () => {
  it("retorna lista de sugestões quando API responde com array top-level", async () => {
    const fetchImpl = mockFetch({
      status: 200,
      body: [{ from: "x", to: "y", rule: "test" }],
    });
    const result = await correctTextViaREST({
      apiKey: "k",
      text: "texto",
      fetchImpl,
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].from, "x");
    assert.equal(result[0].to, "y");
  });

  it("extrai paragraphs[].suggestions[] quando API responde envelopado", async () => {
    const fetchImpl = mockFetch({
      status: 200,
      body: {
        paragraphs: [
          { suggestions: [{ from: "a", to: "b" }, { from: "c", to: "d" }] },
          { suggestions: [{ from: "e", to: "f" }] },
        ],
      },
    });
    const result = await correctTextViaREST({
      apiKey: "k",
      text: "texto",
      fetchImpl,
    });
    assert.equal(result.length, 3);
    assert.deepEqual(
      result.map((s) => s.from),
      ["a", "c", "e"],
    );
  });

  it("retorna [] quando endpoint responde objeto sem suggestions/paragraphs/results", async () => {
    const fetchImpl = mockFetch({ status: 200, body: { ok: true } });
    const result = await correctTextViaREST({
      apiKey: "k",
      text: "texto",
      fetchImpl,
    });
    assert.equal(result.length, 0);
  });

  it("lança erro com HTTP status em non-2xx", async () => {
    const fetchImpl = mockFetch({ status: 401, body: "unauthorized" });
    await assert.rejects(
      () =>
        correctTextViaREST({
          apiKey: "k",
          text: "texto",
          fetchImpl,
        }),
      /HTTP 401/,
    );
  });

  it("passa X-API-Key no header", async () => {
    let captured: Headers | null = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = new Headers(init?.headers);
      return new Response("[]", { status: 200 });
    };
    await correctTextViaREST({ apiKey: "secret123", text: "x", fetchImpl });
    assert.equal(captured!.get("x-api-key"), "secret123");
  });

  it("envia body com paragraphs[0].description = text", async () => {
    let captured: string | null = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = typeof init?.body === "string" ? init.body : null;
      return new Response("[]", { status: 200 });
    };
    await correctTextViaREST({ apiKey: "k", text: "olá mundo", fetchImpl });
    const parsed = JSON.parse(captured!) as { paragraphs: Array<{ description: string }> };
    assert.equal(parsed.paragraphs[0].description, "olá mundo");
  });
});

describe("extractSuggestions", () => {
  it("aceita array direto", () => {
    assert.equal(extractSuggestions([{ from: "x", to: "y" }]).length, 1);
  });

  it("aceita { suggestions: [...] }", () => {
    assert.equal(
      extractSuggestions({ suggestions: [{ from: "x", to: "y" }] }).length,
      1,
    );
  });

  it("aceita { results: [...] }", () => {
    assert.equal(
      extractSuggestions({ results: [{ from: "x", to: "y" }] }).length,
      1,
    );
  });

  it("rejeita shapes inválidos (sem from/to)", () => {
    assert.throws(() => extractSuggestions([{ rule: "x" }]));
  });
});
