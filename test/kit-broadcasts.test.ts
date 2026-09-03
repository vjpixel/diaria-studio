/**
 * test/kit-broadcasts.test.ts (#464)
 *
 * Sem rede real: `globalThis.fetch` é monkeypatchado (mesmo padrão de
 * `test/kit-client.test.ts`). Cobre write ops (create/update/delete
 * broadcast, tags) e o mecanismo de test-send (`resolveTestSendTagId`,
 * `buildTestSendFilter`, `buildAllSubscribersFilter`).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createBroadcast,
  updateBroadcast,
  deleteBroadcast,
  listTags,
  createTag,
  tagSubscriber,
  listSubscriberTags,
  resolveTestSendTagId,
  buildTestSendFilter,
  buildAllSubscribersFilter,
  listTagSubscribersPage,
  countKitTagMembers,
  listActiveSubscribersCreatedAfter,
  KIT_TEST_SEND_TAG_NAME,
} from "../scripts/lib/kit-broadcasts.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";

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

describe("createBroadcast", () => {
  it("POST /broadcasts, desembrulha o envelope", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const result = await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        captured = { url, init };
        return jsonResponse(201, { broadcast: { id: 1, subject: "Assunto", status: "draft" } });
      }) as typeof fetch,
      () => createBroadcast({ subject: "Assunto", content: "<p>oi</p>" }, TEST_CONFIG),
    );
    assert.equal(result.id, 1);
    assert.equal(captured?.init?.method, "POST");
    assert.match(captured!.url, /\/broadcasts$/);
    const body = JSON.parse(captured!.init!.body as string);
    assert.equal(body.subject, "Assunto");
  });

  it("resposta 2xx sem envelope broadcast lança erro nomeado", async () => {
    await assert.rejects(
      withMockFetch((async () => jsonResponse(201, {})) as typeof fetch, () =>
        createBroadcast({ subject: "x", content: "x" }, TEST_CONFIG),
      ),
      /createBroadcast.*sem o envelope/,
    );
  });
});

describe("updateBroadcast", () => {
  it("usa PATCH (não PUT) — achado ao vivo #464: doc oficial de PUT integral está errada", async () => {
    let method = "";
    const result = await withMockFetch(
      (async (_url: string, init?: RequestInit) => {
        method = init?.method ?? "";
        return jsonResponse(200, { broadcast: { id: 42, subject: "Assunto", status: "draft" } });
      }) as typeof fetch,
      () => updateBroadcast(42, { preview_text: "novo preview" }, TEST_CONFIG),
    );
    assert.equal(method, "PATCH");
    assert.equal(result.id, 42);
  });

  it("resposta 2xx sem envelope broadcast lança erro nomeando o id", async () => {
    await assert.rejects(
      withMockFetch((async () => jsonResponse(200, {})) as typeof fetch, () =>
        updateBroadcast(99, { preview_text: "x" }, TEST_CONFIG),
      ),
      /updateBroadcast\(99\).*sem o envelope/,
    );
  });
});

describe("deleteBroadcast", () => {
  it("DELETE /broadcasts/:id, sucesso sem corpo", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        captured = { url, init };
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      () => deleteBroadcast(7, TEST_CONFIG),
    );
    assert.equal(captured?.init?.method, "DELETE");
    assert.match(captured!.url, /\/broadcasts\/7$/);
  });

  it("broadcast já enviado (422) lança KitApiError — caller decide se é fatal (achado ao vivo #464)", async () => {
    await assert.rejects(
      withMockFetch((async () => jsonResponse(422, { errors: ["Broadcast has already been sent."] })) as typeof fetch, () =>
        deleteBroadcast(7, TEST_CONFIG),
      ),
      (e: unknown) => {
        assert.ok(e instanceof KitApiError);
        assert.equal(e.status, 422);
        return true;
      },
    );
  });
});

describe("tags", () => {
  it("listTags monta query e devolve tags+pagination", async () => {
    let capturedUrl = "";
    const result = await withMockFetch(
      (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(200, { tags: [{ id: 1, name: "foo", created_at: "2026-01-01" }], pagination: emptyPagination });
      }) as typeof fetch,
      () => listTags({ perPage: 50, config: TEST_CONFIG }),
    );
    assert.match(capturedUrl, /per_page=50/);
    assert.equal(result.tags.length, 1);
  });

  it("createTag POST /tags, desembrulha envelope", async () => {
    const result = await withMockFetch(
      (async () => jsonResponse(201, { tag: { id: 5, name: "nova", created_at: "2026-01-01" } })) as typeof fetch,
      () => createTag("nova", TEST_CONFIG),
    );
    assert.equal(result.id, 5);
  });

  it("tagSubscriber POST /tags/:tagId/subscribers/:subscriberId", async () => {
    let capturedUrl = "";
    await withMockFetch(
      (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(201, { subscriber: { id: 1 } });
      }) as typeof fetch,
      () => tagSubscriber(5, 10, TEST_CONFIG),
    );
    assert.match(capturedUrl, /\/tags\/5\/subscribers\/10$/);
  });
});

describe("listSubscriberTags (#6504 item 2)", () => {
  it("GET /subscribers/:id/tags, devolve o array desembrulhado", async () => {
    let capturedUrl = "";
    const tags = await withMockFetch(
      (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(200, { tags: [{ id: 5, name: "rampa-kit", created_at: "2026-08-28" }] });
      }) as typeof fetch,
      () => listSubscriberTags(10, TEST_CONFIG),
    );
    assert.match(capturedUrl, /\/subscribers\/10\/tags$/);
    assert.deepEqual(tags, [{ id: 5, name: "rampa-kit", created_at: "2026-08-28" }]);
  });

  it("resposta 2xx sem envelope 'tags' devolve [] em vez de lançar — chamador trata como 'não confirmado', nunca crasha o push", async () => {
    const tags = await withMockFetch(
      (async () => jsonResponse(200, {})) as typeof fetch,
      () => listSubscriberTags(10, TEST_CONFIG),
    );
    assert.deepEqual(tags, []);
  });
});

describe("resolveTestSendTagId", () => {
  it("tag já existe na 1ª página — devolve o id, não cria de novo", async () => {
    let createCalled = false;
    const id = await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          createCalled = true;
          return jsonResponse(201, { tag: { id: 999, name: KIT_TEST_SEND_TAG_NAME, created_at: "x" } });
        }
        return jsonResponse(200, {
          tags: [{ id: 42, name: KIT_TEST_SEND_TAG_NAME, created_at: "x" }],
          pagination: emptyPagination,
        });
      }) as typeof fetch,
      () => resolveTestSendTagId(TEST_CONFIG),
    );
    assert.equal(id, 42);
    assert.equal(createCalled, false);
  });

  it("tag ausente em todas as páginas — cria e devolve o novo id", async () => {
    const id = await withMockFetch(
      (async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return jsonResponse(201, { tag: { id: 777, name: KIT_TEST_SEND_TAG_NAME, created_at: "x" } });
        }
        return jsonResponse(200, { tags: [{ id: 1, name: "outra-tag", created_at: "x" }], pagination: emptyPagination });
      }) as typeof fetch,
      () => resolveTestSendTagId(TEST_CONFIG),
    );
    assert.equal(id, 777);
  });

  it("pagina até achar — tag está na 2ª página", async () => {
    let call = 0;
    const id = await withMockFetch(
      (async () => {
        call++;
        if (call === 1) {
          return jsonResponse(200, {
            tags: [{ id: 1, name: "outra-tag", created_at: "x" }],
            pagination: { ...emptyPagination, has_next_page: true, end_cursor: "cursor2" },
          });
        }
        return jsonResponse(200, {
          tags: [{ id: 55, name: KIT_TEST_SEND_TAG_NAME, created_at: "x" }],
          pagination: emptyPagination,
        });
      }) as typeof fetch,
      () => resolveTestSendTagId(TEST_CONFIG),
    );
    assert.equal(id, 55);
    assert.equal(call, 2);
  });
});

describe("filters", () => {
  it("buildTestSendFilter escopa por tag id", () => {
    assert.deepEqual(buildTestSendFilter(42), [{ all: [{ type: "tag", ids: [42] }] }]);
  });

  it("buildAllSubscribersFilter é o equivalente a 'enviar pra todo mundo' (array vazio — #6323)", () => {
    assert.deepEqual(buildAllSubscribersFilter(), []);
  });
});

describe("#6582 listTagSubscribersPage / countKitTagMembers", () => {
  it("listTagSubscribersPage: GET /tags/{id}/subscribers, desembrulha o envelope", async () => {
    let captured: { url: string } | undefined;
    const result = await withMockFetch(
      (async (url: string) => {
        captured = { url };
        return jsonResponse(200, {
          subscribers: [{ id: 1, email_address: "a@x.com" }],
          pagination: emptyPagination,
        });
      }) as typeof fetch,
      () => listTagSubscribersPage(42, { config: TEST_CONFIG }),
    );
    assert.equal(result.subscribers.length, 1);
    assert.match(captured!.url, /\/tags\/42\/subscribers$/);
  });

  it("countKitTagMembers: soma UMA página inteira", async () => {
    const count = await withMockFetch(
      (async () =>
        jsonResponse(200, {
          subscribers: [
            { id: 1, email_address: "a@x.com" },
            { id: 2, email_address: "b@x.com" },
          ],
          pagination: emptyPagination,
        })) as typeof fetch,
      () => countKitTagMembers(42, TEST_CONFIG),
    );
    assert.equal(count, 2);
  });

  it("countKitTagMembers: 0 membros — o cenário do guard #6582 (tag resolve, ninguém dentro)", async () => {
    const count = await withMockFetch(
      (async () => jsonResponse(200, { subscribers: [], pagination: emptyPagination })) as typeof fetch,
      () => countKitTagMembers(42, TEST_CONFIG),
    );
    assert.equal(count, 0);
  });

  it("countKitTagMembers: pagina até o fim antes de somar", async () => {
    let call = 0;
    const count = await withMockFetch(
      (async () => {
        call++;
        if (call === 1) {
          return jsonResponse(200, {
            subscribers: [{ id: 1, email_address: "a@x.com" }],
            pagination: { ...emptyPagination, has_next_page: true, end_cursor: "cursor2" },
          });
        }
        return jsonResponse(200, {
          subscribers: [
            { id: 2, email_address: "b@x.com" },
            { id: 3, email_address: "c@x.com" },
          ],
          pagination: emptyPagination,
        });
      }) as typeof fetch,
      () => countKitTagMembers(42, TEST_CONFIG),
    );
    assert.equal(count, 3);
    assert.equal(call, 2, "não pode contar só a 1ª página");
  });
});

describe("#7357 listActiveSubscribersCreatedAfter", () => {
  it("chama GET /subscribers com created_after, status=active e include=tags", async () => {
    let captured: { url: string } | undefined;
    await withMockFetch(
      (async (url: string) => {
        captured = { url };
        return jsonResponse(200, { subscribers: [], pagination: emptyPagination });
      }) as typeof fetch,
      () => listActiveSubscribersCreatedAfter("2026-08-25", TEST_CONFIG),
    );
    assert.match(captured!.url, /\/subscribers\?/);
    const url = new URL(captured!.url);
    assert.equal(url.searchParams.get("created_after"), "2026-08-25");
    assert.equal(url.searchParams.get("status"), "active");
    assert.equal(url.searchParams.get("include"), "tags");
  });

  it("mapeia a tag membership pra tagIds", async () => {
    const result = await withMockFetch(
      (async () =>
        jsonResponse(200, {
          subscribers: [
            { id: 1, email_address: "a@x.com", state: "active", created_at: "2026-08-26T00:00:00Z", tags: [{ id: 7, name: "rampa-kit" }] },
            { id: 2, email_address: "b@x.com", state: "active", created_at: "2026-08-27T00:00:00Z", tags: [] },
          ],
          pagination: emptyPagination,
        })) as typeof fetch,
      () => listActiveSubscribersCreatedAfter("2026-08-25", TEST_CONFIG),
    );
    assert.deepEqual(result, [
      { id: 1, tagIds: [7] },
      { id: 2, tagIds: [] },
    ]);
  });

  it("assinante sem campo `tags` (include omitido em algum ponto do pipeline) ⇒ tagIds vazio, nunca lança", async () => {
    const result = await withMockFetch(
      (async () =>
        jsonResponse(200, {
          subscribers: [{ id: 1, email_address: "a@x.com", state: "active", created_at: "2026-08-26T00:00:00Z" }],
          pagination: emptyPagination,
        })) as typeof fetch,
      () => listActiveSubscribersCreatedAfter("2026-08-25", TEST_CONFIG),
    );
    assert.deepEqual(result, [{ id: 1, tagIds: [] }]);
  });

  it("pagina até o fim antes de devolver", async () => {
    let call = 0;
    const result = await withMockFetch(
      (async () => {
        call++;
        if (call === 1) {
          return jsonResponse(200, {
            subscribers: [{ id: 1, email_address: "a@x.com", state: "active", created_at: "x", tags: [] }],
            pagination: { ...emptyPagination, has_next_page: true, end_cursor: "cursor2" },
          });
        }
        return jsonResponse(200, {
          subscribers: [{ id: 2, email_address: "b@x.com", state: "active", created_at: "x", tags: [] }],
          pagination: emptyPagination,
        });
      }) as typeof fetch,
      () => listActiveSubscribersCreatedAfter("2026-08-25", TEST_CONFIG),
    );
    assert.equal(result.length, 2);
    assert.equal(call, 2, "não pode parar na 1ª página");
  });
});
