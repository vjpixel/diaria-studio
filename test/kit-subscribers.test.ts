/**
 * test/kit-subscribers.test.ts (#6091)
 *
 * Sem rede real: `globalThis.fetch` monkeypatchado, mesmo padrão de
 * `test/kit-broadcasts.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  listKitSubscribersPage,
  listAllKitSubscribers,
  createOrUpdateSubscriber,
  getSubscriberById,
  updateSubscriberFields,
} from "../scripts/lib/kit-subscribers.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const TEST_CONFIG = { apiKey: "kit_test_key" };
const emptyPagination = { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 };

async function withMockFetch<T>(handler: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

describe("listKitSubscribersPage", () => {
  it("monta query e devolve subscribers+pagination", async () => {
    let capturedUrl = "";
    const result = await withMockFetch(
      (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(200, {
          subscribers: [{ id: 1, email_address: "a@b.com", state: "active", created_at: "x" }],
          pagination: emptyPagination,
        });
      }) as typeof fetch,
      () => listKitSubscribersPage({ perPage: 50, config: TEST_CONFIG }),
    );
    assert.match(capturedUrl, /per_page=50/);
    assert.equal(result.subscribers.length, 1);
  });
});

describe("listAllKitSubscribers", () => {
  it("pagina até esgotar (has_next_page:false)", async () => {
    let calls = 0;
    const result = await withMockFetch(
      (async () => {
        calls++;
        if (calls === 1) {
          return jsonResponse(200, {
            subscribers: [{ id: 1, email_address: "a@b.com", state: "active", created_at: "x" }],
            pagination: { ...emptyPagination, has_next_page: true, end_cursor: "cursor2" },
          });
        }
        return jsonResponse(200, {
          subscribers: [{ id: 2, email_address: "b@b.com", state: "active", created_at: "x" }],
          pagination: emptyPagination,
        });
      }) as typeof fetch,
      () => listAllKitSubscribers(TEST_CONFIG),
    );
    assert.equal(calls, 2);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((s) => s.email_address), ["a@b.com", "b@b.com"]);
  });

  it("1 página só: não faz 2ª chamada", async () => {
    let calls = 0;
    await withMockFetch(
      (async () => {
        calls++;
        return jsonResponse(200, { subscribers: [], pagination: emptyPagination });
      }) as typeof fetch,
      () => listAllKitSubscribers(TEST_CONFIG),
    );
    assert.equal(calls, 1);
  });
});

describe("createOrUpdateSubscriber", () => {
  it("POST /subscribers, desembrulha o envelope", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const result = await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        captured = { url, init };
        return jsonResponse(201, { subscriber: { id: 1, email_address: "a@b.com", state: "active", created_at: "x" } });
      }) as typeof fetch,
      () => createOrUpdateSubscriber({ email_address: "a@b.com", state: "active" }, TEST_CONFIG),
    );
    assert.equal(result.id, 1);
    assert.equal(captured?.init?.method, "POST");
    const body = JSON.parse(captured!.init!.body as string);
    assert.equal(body.email_address, "a@b.com");
    assert.equal(body.state, "active");
  });

  it("200 (upsert de e-mail já existente) também funciona — mesma resposta desembrulhada", async () => {
    const result = await withMockFetch(
      (async () => jsonResponse(200, { subscriber: { id: 1, email_address: "a@b.com", state: "active", created_at: "x" } })) as typeof fetch,
      () => createOrUpdateSubscriber({ email_address: "a@b.com", state: "active" }, TEST_CONFIG),
    );
    assert.equal(result.id, 1);
  });

  it("resposta 2xx sem envelope subscriber lança erro nomeado", async () => {
    await assert.rejects(
      withMockFetch((async () => jsonResponse(201, {})) as typeof fetch, () =>
        createOrUpdateSubscriber({ email_address: "a@b.com" }, TEST_CONFIG),
      ),
      /createOrUpdateSubscriber.*sem o envelope/,
    );
  });
});

describe("getSubscriberById (#6049)", () => {
  it("GET /subscribers/{id} desembrulha o envelope subscriber, incluindo fields", async () => {
    let capturedUrl = "";
    const result = await withMockFetch(
      (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(200, {
          subscriber: { id: 42, email_address: "a@b.com", state: "active", created_at: "x", fields: { apoio_nivel: "amigo" } },
        });
      }) as typeof fetch,
      () => getSubscriberById(42, TEST_CONFIG),
    );
    assert.match(capturedUrl, /\/subscribers\/42$/);
    assert.equal(result.id, 42);
    assert.equal(result.fields?.apoio_nivel, "amigo");
  });

  it("resposta 2xx sem envelope subscriber lança erro nomeado", async () => {
    await assert.rejects(
      withMockFetch((async () => jsonResponse(200, {})) as typeof fetch, () => getSubscriberById(42, TEST_CONFIG)),
      /getSubscriberById\(42\).*sem o envelope/,
    );
  });
});

describe("updateSubscriberFields (#6049)", () => {
  it("PATCH /subscribers/{id} com body {fields} — desembrulha o envelope subscriber", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const result = await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        captured = { url, init };
        return jsonResponse(200, {
          subscriber: { id: 42, email_address: "a@b.com", state: "active", created_at: "x", fields: { apoio_nivel: "mantenedor" } },
        });
      }) as typeof fetch,
      () => updateSubscriberFields(42, { apoio_nivel: "mantenedor" }, TEST_CONFIG),
    );
    assert.match(captured!.url, /\/subscribers\/42$/);
    assert.equal(captured?.init?.method, "PATCH");
    const body = JSON.parse(captured!.init!.body as string);
    assert.deepEqual(body.fields, { apoio_nivel: "mantenedor" });
    assert.equal(result.fields?.apoio_nivel, "mantenedor");
  });

  it("string vazia é aceita (limpeza de valor) — corpo carrega literalmente ''", async () => {
    let captured: { init?: RequestInit } | undefined;
    await withMockFetch(
      (async (_url: string, init?: RequestInit) => {
        captured = { init };
        return jsonResponse(200, { subscriber: { id: 1, email_address: "a@b.com", state: "active", created_at: "x" } });
      }) as typeof fetch,
      () => updateSubscriberFields(1, { apoio_nivel: "" }, TEST_CONFIG),
    );
    const body = JSON.parse(captured!.init!.body as string);
    assert.equal(body.fields.apoio_nivel, "");
  });

  it("resposta 2xx sem envelope subscriber lança erro nomeado", async () => {
    await assert.rejects(
      withMockFetch((async () => jsonResponse(200, {})) as typeof fetch, () =>
        updateSubscriberFields(42, { apoio_nivel: "amigo" }, TEST_CONFIG),
      ),
      /updateSubscriberFields\(42\).*sem o envelope/,
    );
  });
});
