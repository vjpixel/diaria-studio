/**
 * test/kit-find-tag-by-name-6126.test.ts (#6126)
 *
 * `findTagIdByName` é a função que decide a audiência do canal Kit paralelo —
 * e não tinha teste nenhum (achado dos DOIS revisores da PR #6138). A função
 * irmã `resolveTestSendTagId` já tinha os 3 casos cobertos em
 * `kit-broadcasts.test.ts`; esta é a paridade que faltava.
 *
 * O que está em jogo: `null` daqui vira `skip` no dispatch (seguro). Mas um
 * falso negativo — não achar uma tag que existe, por parar a paginação cedo —
 * viraria canal silenciosamente pulado, sem erro visível. E o inverso, um loop
 * que nunca termina, travaria a Etapa 5.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findTagIdByName } from "../scripts/lib/kit-broadcasts.ts";

const TEST_CONFIG = { apiKey: "k" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const endPagination = {
  has_previous_page: false,
  has_next_page: false,
  start_cursor: null,
  end_cursor: null,
  per_page: 500,
};

async function withMockFetch<T>(handler: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

describe("#6126 findTagIdByName", () => {
  it("acha na 1ª página e devolve o id", async () => {
    const id = await withMockFetch(
      (async () =>
        jsonResponse(200, {
          tags: [
            { id: 1, name: "outra", created_at: "x" },
            { id: 42, name: "kit-nativo", created_at: "x" },
          ],
          pagination: endPagination,
        })) as typeof fetch,
      () => findTagIdByName("kit-nativo", TEST_CONFIG),
    );
    assert.equal(id, 42);
  });

  it("NUNCA cria a tag — diferente de resolveTestSendTagId", async () => {
    // Criar tag de audiência vazia produziria um filtro que casa com ninguém
    // — ou, num caller descuidado, filtro inválido = base inteira.
    let postCalled = false;
    const id = await withMockFetch(
      (async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          postCalled = true;
          return jsonResponse(201, { tag: { id: 999, name: "kit-nativo", created_at: "x" } });
        }
        return jsonResponse(200, { tags: [], pagination: endPagination });
      }) as typeof fetch,
      () => findTagIdByName("kit-nativo", TEST_CONFIG),
    );
    assert.equal(id, null);
    assert.equal(postCalled, false, "não pode tentar criar a tag");
  });

  it("pagina: acha na 2ª página", async () => {
    // Um `return null` prematuro aqui viraria canal silenciosamente pulado.
    let calls = 0;
    const id = await withMockFetch(
      (async (url: string) => {
        calls++;
        if (!String(url).includes("after=")) {
          return jsonResponse(200, {
            tags: [{ id: 1, name: "outra", created_at: "x" }],
            pagination: { ...endPagination, has_next_page: true, end_cursor: "CURSOR1" },
          });
        }
        assert.match(String(url), /after=CURSOR1/, "precisa repassar o cursor da página anterior");
        return jsonResponse(200, {
          tags: [{ id: 77, name: "kit-nativo", created_at: "x" }],
          pagination: endPagination,
        });
      }) as typeof fetch,
      () => findTagIdByName("kit-nativo", TEST_CONFIG),
    );
    assert.equal(id, 77);
    assert.equal(calls, 2);
  });

  it("esgota a paginação sem achar ⇒ null", async () => {
    const id = await withMockFetch(
      (async (url: string) =>
        jsonResponse(200, {
          tags: [{ id: 1, name: "outra", created_at: "x" }],
          pagination: String(url).includes("after=")
            ? endPagination
            : { ...endPagination, has_next_page: true, end_cursor: "C1" },
        })) as typeof fetch,
      () => findTagIdByName("nao-existe", TEST_CONFIG),
    );
    assert.equal(id, null);
  });

  it("has_next_page true mas end_cursor null ⇒ para, não entra em loop", async () => {
    // Sem o guard de `end_cursor`, `after` viraria undefined e a MESMA página
    // seria pedida para sempre — travando a Etapa 5.
    let calls = 0;
    const id = await withMockFetch(
      (async () => {
        calls++;
        assert.ok(calls < 5, "loop infinito detectado");
        return jsonResponse(200, {
          tags: [],
          pagination: { ...endPagination, has_next_page: true, end_cursor: null },
        });
      }) as typeof fetch,
      () => findTagIdByName("x", TEST_CONFIG),
    );
    assert.equal(id, null);
    assert.equal(calls, 1);
  });

  it("2xx sem 'pagination' ⇒ null, sem loop (degradação segura)", async () => {
    let calls = 0;
    const id = await withMockFetch(
      (async () => {
        calls++;
        assert.ok(calls < 5, "loop infinito detectado");
        return jsonResponse(200, { tags: [] });
      }) as typeof fetch,
      () => findTagIdByName("x", TEST_CONFIG),
    );
    assert.equal(id, null);
    assert.equal(calls, 1);
  });

  it("erro de rede PROPAGA — não vira null silencioso", async () => {
    // Distinção que importa: erro de rede deve virar `failed` no dispatch, não
    // `skipped` com a mensagem "a tag não existe", que mandaria quem investiga
    // procurar no lugar errado.
    await assert.rejects(
      () =>
        withMockFetch(
          (async () => {
            throw new Error("ECONNRESET");
          }) as typeof fetch,
          () => findTagIdByName("x", TEST_CONFIG),
        ),
      /ECONNRESET/,
    );
  });
});
