/**
 * test/workers-dev-redirect-wiring-5097.test.ts (#5097 item D, #5104)
 *
 * Teste de COMPORTAMENTO (fetch handler real dos Workers, sem rede) —
 * confirma que `arquivo`/`cursos`/`livros`/`artigo-mensal` fecham o host
 * genérico `*.diaria.workers.dev` com 301 (métodos seguros) ou 308 (demais
 * métodos, #5104 — preserva corpo no retry do cliente) pro host canônico
 * ANTES de qualquer outra lógica (log de Referer, gate, cache, ASSETS).
 * `poll` fica FORA de propósito — `poll.diaria.workers.dev` segue ativo por
 * compat de links de VOTO de edições já publicadas (#3904). `artigos` (static
 * assets puro, sem `main`/script) também fica fora — ver `docs/seo-notes.md`
 * Fato 5 pro porquê é exclusão arquitetural.
 *
 * Ver `test/workers-dev-redirect.test.ts` pro comportamento puro de
 * `resolveWorkersDevRedirect`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import arquivoWorker from "../workers/arquivo/src/index.ts";
import cursosWorker from "../workers/cursos/src/index.ts";
import livrosWorker from "../workers/livros/src/index.ts";
import artigoMensalWorker from "../workers/artigo-mensal/src/index.ts";

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

  // #5104: par de passthrough — `arquivo`/`livros` já tinham este teste
  // ("host canônico -> resposta normal, nunca 301"); `cursos` estava sem,
  // cobrindo só o caminho de redirect.
  it("host canônico (cursos.diar.ia.br) -> resposta normal (teaser via ASSETS), nunca 301", async () => {
    const env = fakeAssetsEnv();
    const res = await cursosWorker.fetch(new Request("https://cursos.diar.ia.br/"), env as never);
    assert.notEqual(res.status, 301);
    assert.equal(res.status, 200);
  });

  // #5104 fleet review, achado 1: `resolveWorkersDevRedirect` era cego a
  // método HTTP — um 301 numa request POST vira GET sem corpo no retry do
  // cliente (RFC 9110 §15.4.2), o que perderia silenciosamente o corpo de
  // `/gate/verify` (mutação com estado — verifica assinante, seta cookie).
  it("POST em cursos.diaria.workers.dev/gate/verify -> 308 (preserva método+corpo), NUNCA 301", async () => {
    const env = fakeAssetsEnv();
    const res = await cursosWorker.fetch(
      new Request("https://cursos.diaria.workers.dev/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "leitor@example.com" }),
      }),
      env as never,
    );
    assert.equal(res.status, 308, "308 preserva método+corpo no retry — 301 rebaixaria pra GET sem corpo");
    assert.equal(res.headers.get("Location"), "https://cursos.diar.ia.br/gate/verify");
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

// #5104 (fleet review do #5097/#5099): `artigo-mensal` tem o MESMO padrão
// `workers_dev = true` + `custom_domain` que `arquivo`/`cursos`/`livros`,
// sem nenhum passivo de link-legado (diferente de `poll`) — ficar fora do
// #5097 original era blind spot da auditoria, não exclusão deliberada.
function makeArtigoMensalEnv(): { ARTICLES: KVNamespace; ALLOWLIST: KVNamespace } {
  const kv = {
    async get(): Promise<string | null> {
      return null;
    },
  };
  // @ts-expect-error — só `get` importa pro teste de roteamento; se o
  // redirect funcionar, nenhum dos dois KVs é sequer consultado.
  return { ARTICLES: kv, ALLOWLIST: kv };
}

describe("workers/artigo-mensal — fecha .workers.dev com 301/308 (#5104)", () => {
  it("GET em artigo-mensal.diaria.workers.dev/2607-08 -> 301 pro host canônico, KV nunca consultado", async () => {
    const env = makeArtigoMensalEnv();
    const res = await artigoMensalWorker.fetch(
      new Request("https://artigo-mensal.diaria.workers.dev/2607-08"),
      env as never,
    );
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://artigo.diar.ia.br/2607-08");
  });

  it("preserva query string (?email=...) no redirect", async () => {
    const env = makeArtigoMensalEnv();
    const res = await artigoMensalWorker.fetch(
      new Request("https://artigo-mensal.diaria.workers.dev/2607-08?email=apoiador%40example.com"),
      env as never,
    );
    assert.equal(res.status, 301);
    assert.equal(
      res.headers.get("Location"),
      "https://artigo.diar.ia.br/2607-08?email=apoiador%40example.com",
    );
  });

  it("POST em artigo-mensal.diaria.workers.dev -> 308 (método não-seguro), NUNCA 301", async () => {
    const env = makeArtigoMensalEnv();
    const res = await artigoMensalWorker.fetch(
      new Request("https://artigo-mensal.diaria.workers.dev/2607-08", { method: "POST" }),
      env as never,
    );
    assert.equal(res.status, 308);
    assert.equal(res.headers.get("Location"), "https://artigo.diar.ia.br/2607-08");
  });

  it("host canônico (artigo.diar.ia.br) -> resposta normal, nunca 301/308", async () => {
    const env = makeArtigoMensalEnv();
    const res = await artigoMensalWorker.fetch(new Request("https://artigo.diar.ia.br/sitemap.xml"), env as never);
    assert.notEqual(res.status, 301);
    assert.notEqual(res.status, 308);
    assert.equal(res.status, 200);
  });
});
