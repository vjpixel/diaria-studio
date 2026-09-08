/**
 * test/sync-apoio-mensal-tag-kit.test.ts (#7633)
 *
 * Cobre a seleção de audiência de `scripts/sync-apoio-mensal-tag-kit.ts` — o
 * sync que projeta o custom field `apoio_nivel` em membresia da tag usada
 * como `subscriber_filter` do envio extra dos apoiadores.
 *
 * O diff/guards puros ficam em `test/apoiadores-kit-channel.test.ts`; aqui é
 * só `selectDesiredMembers`, cuja falha tem duas direções ruins e assimétricas:
 * incluir quem não apoia (vaza conteúdo pago) ou excluir quem apoia (a pessoa
 * paga e não recebe a recompensa).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyAdd,
  applyRemove,
  fetchTagMembers,
  isSystemicKitFailure,
  selectDesiredMembers,
  type SelectableKitSubscriber,
} from "../scripts/sync-apoio-mensal-tag-kit.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";

const sub = (over: Partial<SelectableKitSubscriber> & { id: number; email_address: string }): SelectableKitSubscriber => ({
  state: "active",
  fields: {},
  ...over,
});

describe("#7633 — selectDesiredMembers", () => {
  it("inclui mantenedor e patrono", () => {
    const out = selectDesiredMembers([
      sub({ id: 1, email_address: "m@x.com", fields: { apoio_nivel: "mantenedor" } }),
      sub({ id: 2, email_address: "p@x.com", fields: { apoio_nivel: "patrono" } }),
    ]);
    assert.deepEqual(out.map((m) => m.email), ["m@x.com", "p@x.com"]);
  });

  it("exclui amigo e apoiador (níveis abaixo do alvo, decisão 2 do #4482)", () => {
    const out = selectDesiredMembers([
      sub({ id: 1, email_address: "a@x.com", fields: { apoio_nivel: "amigo" } }),
      sub({ id: 2, email_address: "b@x.com", fields: { apoio_nivel: "apoiador" } }),
    ]);
    assert.deepEqual(out, []);
  });

  it("exclui quem não tem apoio_nivel (campo ausente ou vazio)", () => {
    const out = selectDesiredMembers([
      sub({ id: 1, email_address: "s@x.com" }),
      sub({ id: 2, email_address: "v@x.com", fields: { apoio_nivel: "" } }),
    ]);
    assert.deepEqual(out, []);
  });

  it("exclui assinante não-ativo, mesmo com nível alvo", () => {
    const out = selectDesiredMembers([
      sub({ id: 1, email_address: "i@x.com", state: "inactive", fields: { apoio_nivel: "patrono" } }),
      sub({ id: 2, email_address: "c@x.com", state: "cancelled", fields: { apoio_nivel: "mantenedor" } }),
    ]);
    assert.deepEqual(out, []);
  });

  it("normaliza o valor do campo — texto livre com espaço/caixa alta não exclui quem apoia", () => {
    const out = selectDesiredMembers([
      sub({ id: 1, email_address: "p@x.com", fields: { apoio_nivel: "  Patrono " } }),
    ]);
    assert.deepEqual(out.map((m) => m.email), ["p@x.com"]);
  });

  it("normaliza o e-mail (o diff casa por e-mail — caixa alta viraria add+remove do mesmo contato)", () => {
    const out = selectDesiredMembers([
      sub({ id: 1, email_address: "  P@X.COM ", fields: { apoio_nivel: "patrono" } }),
    ]);
    assert.deepEqual(out, [{ id: 1, email: "p@x.com" }]);
  });

  it("preserva o id do assinante (é ele que a mutação de tag usa, não o e-mail)", () => {
    const out = selectDesiredMembers([
      sub({ id: 4242, email_address: "p@x.com", fields: { apoio_nivel: "patrono" } }),
    ]);
    assert.equal(out[0].id, 4242);
  });
});

// ── I/O contra o Kit (fetch mockado — sem rede real) ──────────────────────
//
// Mesmo padrão de `test/sync-apoio-nivel-kit.test.ts` (#6049), o script irmão:
// o que precisa de teste aqui não é o "chamou a API", é a DISCIPLINA de nunca
// tratar 2xx como prova de escrita — a rota de DELETE de tag do Kit tem
// histórico de responder 2xx sem efeito.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** 204 do Kit não pode carregar corpo — `new Response(body, {status:204})` lança. */
function noContentResponse(): Response {
  return new Response(null, { status: 204 });
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

describe("#7633 — fetchTagMembers", () => {
  it("pagina até o fim e normaliza o e-mail, preservando o id", async () => {
    const pages = [
      {
        subscribers: [{ id: 1, email_address: "  A@X.com " }],
        pagination: { ...emptyPagination, has_next_page: true, end_cursor: "cursor-1" },
      },
      { subscribers: [{ id: 2, email_address: "b@x.com" }], pagination: emptyPagination },
    ];
    let call = 0;
    const members = await withMockFetch(
      (async (url: string) => {
        // 2ª chamada precisa carregar o cursor da 1ª — sem isso a paginação
        // repetiria a mesma página em vez de avançar.
        if (call === 1) assert.match(String(url), /after=cursor-1/);
        return jsonResponse(200, pages[call++]);
      }) as typeof fetch,
      () => fetchTagMembers(42, TEST_CONFIG),
    );
    assert.equal(call, 2, "deveria ter buscado as 2 páginas");
    assert.deepEqual(members, [
      { id: 1, email: "a@x.com" },
      { id: 2, email: "b@x.com" },
    ]);
  });

  it("página única sem cursor -> uma chamada só (não entra em loop)", async () => {
    let calls = 0;
    const members = await withMockFetch(
      (async () => {
        calls++;
        return jsonResponse(200, { subscribers: [{ id: 7, email_address: "p@x.com" }], pagination: emptyPagination });
      }) as typeof fetch,
      () => fetchTagMembers(42, TEST_CONFIG),
    );
    assert.equal(calls, 1);
    assert.deepEqual(members, [{ id: 7, email: "p@x.com" }]);
  });
});

describe("#7633 — applyAdd (nunca confia no 2xx)", () => {
  it("POST na tag + releitura confirmando -> não lança", async () => {
    const seen: string[] = [];
    await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        seen.push(`${init?.method ?? "GET"} ${String(url)}`);
        if (String(url).includes("/subscribers/10/tags")) {
          return jsonResponse(200, { tags: [{ id: 42, name: "apoio-mensal", created_at: "" }] });
        }
        return jsonResponse(201, { subscriber: { id: 10 } });
      }) as typeof fetch,
      () => applyAdd({ id: 10, email: "p@x.com" }, 42, TEST_CONFIG),
    );
    assert.ok(seen.some((s) => s.startsWith("POST") && s.includes("/tags/42/subscribers/10")));
    assert.ok(seen.some((s) => s.includes("/subscribers/10/tags")), "faltou a releitura de confirmação");
  });

  it("POST 2xx mas releitura SEM a tag -> lança (o 2xx mentiu)", async () => {
    await withMockFetch(
      (async (url: string) => {
        if (String(url).includes("/subscribers/10/tags")) return jsonResponse(200, { tags: [] });
        return jsonResponse(201, { subscriber: { id: 10 } });
      }) as typeof fetch,
      () => assert.rejects(() => applyAdd({ id: 10, email: "p@x.com" }, 42, TEST_CONFIG), /releitura pós-tag NÃO confere/),
    );
  });
});

describe("#7633 — applyRemove (o DELETE do Kit tem histórico de 2xx sem efeito)", () => {
  it("DELETE + releitura sem a tag -> não lança", async () => {
    const seen: string[] = [];
    await withMockFetch(
      (async (url: string, init?: RequestInit) => {
        seen.push(`${init?.method ?? "GET"} ${String(url)}`);
        if (String(url).includes("/subscribers/10/tags")) return jsonResponse(200, { tags: [] });
        return noContentResponse();
      }) as typeof fetch,
      () => applyRemove({ id: 10, email: "p@x.com" }, 42, TEST_CONFIG),
    );
    assert.ok(seen.some((s) => s.startsWith("DELETE") && s.includes("/tags/42/subscribers/10")));
  });

  it("DELETE 2xx mas a tag CONTINUA na releitura -> lança (a armadilha documentada em kit-client.ts)", async () => {
    await withMockFetch(
      (async (url: string) => {
        if (String(url).includes("/subscribers/10/tags")) {
          return jsonResponse(200, { tags: [{ id: 42, name: "apoio-mensal", created_at: "" }] });
        }
        return noContentResponse();
      }) as typeof fetch,
      () =>
        assert.rejects(
          () => applyRemove({ id: 10, email: "p@x.com" }, 42, TEST_CONFIG),
          /releitura pós-untag NÃO confere/,
        ),
    );
  });
});

describe("#7633 — isSystemicKitFailure", () => {
  it("401/403/429/5xx são sistêmicos (credencial, rate limit, indisponibilidade)", () => {
    for (const status of [401, 403, 429, 500, 503]) {
      assert.equal(isSystemicKitFailure(new KitApiError("/tags/1/subscribers/2", status, "")), true, `status ${status}`);
    }
  });

  it("404/422 NÃO são sistêmicos — são específicos daquele contato, o loop deve seguir", () => {
    for (const status of [404, 422]) {
      assert.equal(isSystemicKitFailure(new KitApiError("/tags/1/subscribers/2", status, "")), false, `status ${status}`);
    }
  });

  it("falha de VERIFICAÇÃO por releitura não é sistêmica (é semântica, específica do contato)", () => {
    assert.equal(isSystemicKitFailure(new Error("releitura pós-untag NÃO confere pra p@x.com")), false);
  });
});
