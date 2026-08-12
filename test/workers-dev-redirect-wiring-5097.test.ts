/**
 * test/workers-dev-redirect-wiring-5097.test.ts (#5097 item D)
 *
 * Teste de COMPORTAMENTO (fetch handler real dos 3 Workers, sem rede) —
 * confirma que `arquivo`/`cursos`/`livros` fecham o host genérico
 * `*.diaria.workers.dev` com 301 pro host canônico ANTES de qualquer outra
 * lógica (log de Referer, gate, cache, ASSETS). `poll` fica FORA de
 * propósito — `poll.diaria.workers.dev` segue ativo por compat de links de
 * VOTO de edições já publicadas (#3904).
 *
 * Ver `test/workers-dev-redirect.test.ts` pro comportamento puro de
 * `resolveWorkersDevRedirect`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import arquivoWorker from "../workers/arquivo/src/index.ts";
import cursosWorker from "../workers/cursos/src/index.ts";
import livrosWorker from "../workers/livros/src/index.ts";

function fakeAssetsEnv(): { ASSETS: Fetcher } {
  return {
    // @ts-expect-error — só o método `fetch` importa pro teste; se o
    // redirect funcionar, o ASSETS nunca é sequer chamado.
    ASSETS: {
      fetch: async () => new Response("<html>nunca deveria chegar aqui</html>", { status: 200 }),
    },
  };
}

describe("workers/arquivo — fecha .workers.dev com 301 (#5097 item D)", () => {
  it("GET em arquivo.diaria.workers.dev/ -> 301 pro host canônico", async () => {
    const res = await arquivoWorker.fetch(new Request("https://arquivo.diaria.workers.dev/"));
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://arquivo.diar.ia.br/");
  });

  it("preserva o path (/temas/{slug}) no redirect", async () => {
    const res = await arquivoWorker.fetch(new Request("https://arquivo.diaria.workers.dev/temas/anthropic-claude"));
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://arquivo.diar.ia.br/temas/anthropic-claude");
  });

  it("host canônico (arquivo.diar.ia.br) -> resposta normal, nunca 301", async () => {
    // /sitemap.xml (não /) — não depende de fetch externo (#4546), evita
    // mockar globalThis.fetch só pra este teste de roteamento.
    const res = await arquivoWorker.fetch(new Request("https://arquivo.diar.ia.br/sitemap.xml"));
    assert.notEqual(res.status, 301);
    assert.equal(res.status, 200);
  });
});

describe("workers/cursos — fecha .workers.dev com 301 (#5097 item D)", () => {
  it("GET em cursos.diaria.workers.dev/ -> 301 pro host canônico, ASSETS nunca chamado", async () => {
    const env = fakeAssetsEnv();
    const res = await cursosWorker.fetch(new Request("https://cursos.diaria.workers.dev/"), env as never);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://cursos.diar.ia.br/");
  });

  it("preserva query string (?email=...) no redirect", async () => {
    const env = fakeAssetsEnv();
    const res = await cursosWorker.fetch(
      new Request("https://cursos.diaria.workers.dev/?email=leitor%40example.com"),
      env as never,
    );
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://cursos.diar.ia.br/?email=leitor%40example.com");
  });
});

describe("workers/livros — fecha .workers.dev com 301 (#5097 item D)", () => {
  it("GET em livros.diaria.workers.dev/ -> 301 pro host canônico, ASSETS nunca chamado", async () => {
    let assetsCalled = false;
    const env = {
      ASSETS: {
        // @ts-expect-error — só o método `fetch` importa pro teste.
        fetch: async () => {
          assetsCalled = true;
          return new Response("<html>nunca deveria chegar aqui</html>", { status: 200 });
        },
      },
    };
    const res = await livrosWorker.fetch(new Request("https://livros.diaria.workers.dev/"), env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://livros.diar.ia.br/");
    assert.equal(assetsCalled, false, "ASSETS não deveria ser chamado quando a request redireciona");
  });

  it("host canônico (livros.diar.ia.br) -> delega pro ASSETS normalmente, nunca 301", async () => {
    const env = fakeAssetsEnv();
    const res = await livrosWorker.fetch(new Request("https://livros.diar.ia.br/"), env);
    assert.notEqual(res.status, 301);
    assert.equal(res.status, 200);
  });
});
