/**
 * test/sync-apoio-nivel-kit.test.ts (#6049)
 *
 * Cobre só o que é NOVO/específico do Kit neste arquivo —
 * `extractApoioNivelValueKit`, `fetchCurrentKitState`, `applyApoioTagEntryKit`.
 * A lógica pura reusada (`computeDesiredApoioLevels`, `diffApoioTags`,
 * `evaluateBlastRadiusGuard`, etc.) já está travada em
 * `test/apoio-nivel-sync.test.ts` — reimportar e re-testar aqui
 * seria duplicação sem sinal novo (o shape que ela consome é genérico, não
 * muda por ser alimentado pelo Kit).
 *
 * Sem rede real: `globalThis.fetch` monkeypatchado, mesmo padrão de
 * `test/kit-subscribers.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractApoioNivelValueKit,
  fetchCurrentKitState,
  applyApoioTagEntryKit,
} from "../scripts/sync-apoio-nivel-kit.ts";
import type { ApoioTagDiffEntry } from "../scripts/lib/apoio-nivel-sync.ts";

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

describe("extractApoioNivelValueKit", () => {
  it("fields ausente → string vazia", () => {
    assert.equal(extractApoioNivelValueKit(undefined), "");
  });

  it("fields sem apoio_nivel → string vazia", () => {
    assert.equal(extractApoioNivelValueKit({ setor: "tech" }), "");
  });

  it("fields com apoio_nivel presente → devolve o valor", () => {
    assert.equal(extractApoioNivelValueKit({ apoio_nivel: "mantenedor", setor: "tech" }), "mantenedor");
  });

  it("apoio_nivel não-string (defensivo, runtime malformado) → string vazia", () => {
    assert.equal(extractApoioNivelValueKit({ apoio_nivel: 123 as unknown as string }), "");
  });
});

describe("fetchCurrentKitState (#6049)", () => {
  it("filtra só state === active e mapeia pro shape genérico do diff", async () => {
    const result = await withMockFetch(
      (async () =>
        jsonResponse(200, {
          subscribers: [
            { id: 1, email_address: "Ativo@Exemplo.com", state: "active", created_at: "x", fields: { apoio_nivel: "amigo" } },
            { id: 2, email_address: "cancelado@exemplo.com", state: "cancelled", created_at: "x", fields: { apoio_nivel: "patrono" } },
            { id: 3, email_address: "sem-campo@exemplo.com", state: "active", created_at: "x" },
          ],
          pagination: emptyPagination,
        })) as typeof fetch,
      () => fetchCurrentKitState(TEST_CONFIG),
    );

    assert.equal(result.length, 2, "só os 2 ativos entram");
    assert.deepEqual(result[0], { subscriptionId: "1", email: "ativo@exemplo.com", apoioNivel: "amigo" });
    assert.deepEqual(result[1], { subscriptionId: "3", email: "sem-campo@exemplo.com", apoioNivel: "" });
  });

  it("lista vazia → lança: leitura vazia nunca vira 'ninguém assina' (#11225)", async () => {
    await assert.rejects(
      withMockFetch(
        (async () => jsonResponse(200, { subscribers: [], pagination: emptyPagination })) as typeof fetch,
        () => fetchCurrentKitState(TEST_CONFIG),
      ),
      /0 assinantes ativos/,
    );
  });
});

function makeEntry(overrides: Partial<ApoioTagDiffEntry> = {}): ApoioTagDiffEntry {
  return {
    contactId: "c1",
    contactName: "Fulano",
    email: "fulano@exemplo.com",
    subscriptionId: "42",
    fromLevel: null,
    toLevel: "mantenedor",
    ...overrides,
  };
}

describe("applyApoioTagEntryKit (#6049 — PATCH + releitura)", () => {
  it("PATCH seguido de GET que confirma o valor esperado — não lança", async () => {
    let calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "PATCH") {
        return jsonResponse(200, { subscriber: { id: 42, email_address: "fulano@exemplo.com", state: "active", created_at: "x" } });
      }
      return jsonResponse(200, {
        subscriber: { id: 42, email_address: "fulano@exemplo.com", state: "active", created_at: "x", fields: { apoio_nivel: "mantenedor" } },
      });
    }) as typeof fetch;

    await withMockFetch(fetchImpl, () => assert.doesNotReject(applyApoioTagEntryKit(makeEntry(), TEST_CONFIG)));
    assert.equal(calls.length, 2);
    assert.match(calls[0], /^PATCH .*\/subscribers\/42$/);
    assert.match(calls[1], /^GET .*\/subscribers\/42$/);
  });

  it("remoção (toLevel: null) grava string vazia e confirma contra fields ausente/vazio", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(init.body as string);
        assert.equal(body.fields.apoio_nivel, "");
        return jsonResponse(200, { subscriber: { id: 42, email_address: "fulano@exemplo.com", state: "active", created_at: "x" } });
      }
      return jsonResponse(200, { subscriber: { id: 42, email_address: "fulano@exemplo.com", state: "active", created_at: "x" } });
    }) as typeof fetch;

    await withMockFetch(fetchImpl, () =>
      assert.doesNotReject(applyApoioTagEntryKit(makeEntry({ fromLevel: "mantenedor", toLevel: null }), TEST_CONFIG)),
    );
  });

  it("releitura NÃO confere com o valor esperado → lança, mutação não confirmada", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse(200, { subscriber: { id: 42, email_address: "fulano@exemplo.com", state: "active", created_at: "x" } });
      }
      return jsonResponse(200, {
        subscriber: { id: 42, email_address: "fulano@exemplo.com", state: "active", created_at: "x", fields: { apoio_nivel: "amigo" } },
      });
    }) as typeof fetch;

    await assert.rejects(
      withMockFetch(fetchImpl, () => applyApoioTagEntryKit(makeEntry({ toLevel: "mantenedor" }), TEST_CONFIG)),
      /NÃO confere.*mutação NÃO confirmada/,
    );
  });

  it("adição: corpo do PATCH leva o nível em fields.apoio_nivel (#11225)", async () => {
    let patchBody: { fields?: Record<string, string> } = {};
    const sub = { id: 42, email_address: "fulano@exemplo.com", state: "active", created_at: "x" };
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchBody = JSON.parse(init.body as string);
        return jsonResponse(200, { subscriber: sub });
      }
      return jsonResponse(200, { subscriber: { ...sub, fields: { apoio_nivel: "mantenedor" } } });
    }) as typeof fetch;
    await withMockFetch(fetchImpl, () => applyApoioTagEntryKit(makeEntry({ toLevel: "mantenedor" }), TEST_CONFIG));
    assert.deepEqual(patchBody.fields, { apoio_nivel: "mantenedor" });
  });

  it("remoção que não pegou: releitura ainda traz o nível → lança (#11225)", async () => {
    const sub = { id: 42, email_address: "fulano@exemplo.com", state: "active", created_at: "x", fields: { apoio_nivel: "amigo" } };
    const fetchImpl = (async () => jsonResponse(200, { subscriber: sub })) as typeof fetch;
    await assert.rejects(
      withMockFetch(fetchImpl, () => applyApoioTagEntryKit(makeEntry({ fromLevel: "amigo", toLevel: null }), TEST_CONFIG)),
      /NÃO confere/,
    );
  });

  it("PATCH não-ok lança e não relê (#11225)", async () => {
    const methods: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return jsonResponse(422, { errors: ["inválido"] });
    }) as typeof fetch;
    await assert.rejects(withMockFetch(fetchImpl, () => applyApoioTagEntryKit(makeEntry(), TEST_CONFIG)));
    assert.deepEqual(methods, ["PATCH"]);
  });

  it("GET falhando depois de PATCH ok lança: escrita não confirmada (#11225)", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? jsonResponse(200, { subscriber: { id: 42, email_address: "fulano@exemplo.com", state: "active", created_at: "x" } })
        : jsonResponse(404, { errors: ["não encontrado"] })) as typeof fetch;
    await assert.rejects(withMockFetch(fetchImpl, () => applyApoioTagEntryKit(makeEntry(), TEST_CONFIG)));
  });

  it("subscriptionId não numérico (dado malformado) lança antes de qualquer chamada de rede", async () => {
    let networkCalled = false;
    const fetchImpl = (async () => {
      networkCalled = true;
      return jsonResponse(200, {});
    }) as typeof fetch;

    await assert.rejects(
      withMockFetch(fetchImpl, () => applyApoioTagEntryKit(makeEntry({ subscriptionId: "não-é-um-id" }), TEST_CONFIG)),
      /subscriptionId inválido/,
    );
    assert.equal(networkCalled, false);
  });
});
