/**
 * test/site-worker-evento-agente-ia-8563.test.ts (#8563)
 *
 * `GET /evento/agente-ia` no Worker `site` (`diar.ia.br/evento/agente-ia`) —
 * proxy REVERSO (fetch + devolve como resposta deste Worker) pra
 * `https://agente.vjpixel.chatgpt.site/`, pedido do editor pra esconder o
 * domínio chatgpt.site do link divulgado. Diferente de `/confirmado`/
 * `/apoiar/ir` (que usam `Response.redirect`), aqui a barra de endereço do
 * navegador NUNCA sai de diar.ia.br — por isso o teste intercepta
 * `globalThis.fetch` (o Worker chama fetch pro upstream) em vez de checar um
 * header `Location`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";

function fakeEnv(): { env: Env; assetCalls: Request[] } {
  const assetCalls: Request[] = [];
  const env: Env = {
    ASSETS: {
      fetch: async (req: Request) => {
        assetCalls.push(req);
        return new Response("not found", { status: 404 });
      },
    },
    POLL: { get: async () => null },
  };
  return { env, assetCalls };
}

describe("GET /evento/agente-ia (#8563) — proxy reverso pro workshop", () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls: string[] = [];

  beforeEach(() => {
    upstreamCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      upstreamCalls.push(typeof input === "string" ? input : input.toString());
      return new Response("<html><body>workshop</body></html>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-frame-options": "DENY",
          "content-security-policy": "default-src 'self'",
        },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("200, corpo do upstream, nunca chega no ASSETS", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/evento/agente-ia"), env);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "<html><body>workshop</body></html>");
    assert.equal(assetCalls.length, 0, "/evento/agente-ia é resolvido ANTES do asset lookup");
    assert.deepEqual(upstreamCalls, ["https://agente.vjpixel.chatgpt.site/"]);
  });

  it("também casa com barra final", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/evento/agente-ia/"), env);
    assert.equal(res.status, 200);
  });

  it("nunca cacheia (no-store), mesmo se o upstream mandar outro cache-control", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/evento/agente-ia"), env);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("remove headers do upstream que vazariam a origem real ou quebrariam o proxy", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/evento/agente-ia"), env);
    assert.equal(res.headers.get("x-frame-options"), null);
    assert.equal(res.headers.get("content-security-policy"), null);
  });

  it("só GET — POST cai no fluxo normal do asset lookup, nunca chama o upstream", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/evento/agente-ia", { method: "POST" }), env);
    assert.equal(res.status, 404);
    assert.equal(assetCalls.length, 1);
    assert.equal(upstreamCalls.length, 0);
  });
});
