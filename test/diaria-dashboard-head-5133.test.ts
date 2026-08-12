/**
 * test/diaria-dashboard-head-5133.test.ts (#5133)
 *
 * Achado colateral registrado na issue: `HEAD /` devolvia 500 enquanto
 * `GET /` devolvia 200. Causa raiz: `routeRequest` roteia `/` como
 * cacheável e chama `cache.put(request, response.clone())` — a Cache API
 * dos Workers lança pra requests com método não-GET ("Cannot cache
 * response to non-GET request"), e nada capturava essa exceção; o fetch
 * handler default não tinha try/catch em volta de `routeRequest`.
 *
 * Fix: `export default.fetch` reescreve o método pra GET antes de chamar
 * `routeRequest` quando a request original é HEAD, e no retorno devolve a
 * MESMA resposta (status/headers) com body vazio — semântica HTTP padrão
 * de HEAD (RFC 9110 §9.3.2: idêntico a GET exceto pelo corpo).
 *
 * Mesmo padrão de import dinâmico + polyfill de `caches` do resto da suíte
 * de diaria-dashboard (ver test/diaria-dashboard-noindex-5097.test.ts). Um
 * mock de `cache.put` que LANÇA pra requests não-GET (em vez do no-op
 * padrão dos outros testes) reproduz o crash original — sem o fix, este
 * teste falharia com a mesma exceção não capturada que a issue reportou.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../workers/diaria-dashboard/src/index.ts";

const mod = await import("../workers/diaria-dashboard/src/index.ts");

function resolveWorker(m: Record<string, unknown>): { fetch: (req: Request, env: Env) => Promise<Response> } {
  const level1 = m.default as { fetch?: unknown; default?: unknown } | undefined;
  if (level1 && typeof level1.fetch === "function") {
    return level1 as { fetch: (req: Request, env: Env) => Promise<Response> };
  }
  const level2 = level1?.default as { fetch?: unknown } | undefined;
  if (level2 && typeof level2.fetch === "function") {
    return level2 as { fetch: (req: Request, env: Env) => Promise<Response> };
  }
  throw new Error("resolveWorker: não achou {fetch} nem em mod.default nem em mod.default.default");
}
const worker = resolveWorker(mod);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let origCaches: any;
before(() => {
  origCaches = (globalThis as unknown as { caches?: unknown }).caches;
  // Reproduz o comportamento real da Cache API dos Workers: `put()` lança
  // pra requests não-GET. `match()` sempre miss (mais simples, e o teste
  // não depende de cache hit).
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      match: async () => null,
      put: async (request: Request) => {
        if (request.method !== "GET") {
          throw new TypeError("Cannot cache response to non-GET request.");
        }
      },
    },
  };
});
after(() => {
  (globalThis as unknown as { caches: unknown }).caches = origCaches;
});

const TOKEN = "s3cr3t-head-token";

function makeEnv(): Env {
  return {
    DASHBOARD_DATA: { get: async () => null },
    AUTH_TOKEN: TOKEN,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function authedHead(path: string): Request {
  return new Request(`https://x${path}`, { method: "HEAD", headers: { "X-Dashboard-Token": TOKEN } });
}

function authedGet(path: string): Request {
  return new Request(`https://x${path}`, { headers: { "X-Dashboard-Token": TOKEN } });
}

describe("HEAD / não crasha mais (#5133)", () => {
  it("HEAD / devolve o MESMO status que GET / (200, dashboard não inicializado) — nunca 500", async () => {
    const getRes = await worker.fetch(authedGet("/"), makeEnv());
    const headRes = await worker.fetch(authedHead("/"), makeEnv());
    assert.equal(getRes.status, 200);
    assert.equal(headRes.status, getRes.status);
    assert.notEqual(headRes.status, 500);
  });

  it("HEAD / devolve corpo vazio (semântica HTTP padrão de HEAD)", async () => {
    const res = await worker.fetch(authedHead("/"), makeEnv());
    const body = await res.text();
    assert.equal(body, "");
  });

  it("HEAD / preserva os headers da resposta GET equivalente (ex: Content-Type)", async () => {
    const getRes = await worker.fetch(authedGet("/"), makeEnv());
    const headRes = await worker.fetch(authedHead("/"), makeEnv());
    assert.equal(headRes.headers.get("Content-Type"), getRes.headers.get("Content-Type"));
    assert.equal(headRes.headers.get("X-Robots-Tag"), "noindex");
  });

  it("HEAD sem token autenticado também não crasha — 401, não 500", async () => {
    const res = await worker.fetch(new Request("https://x/", { method: "HEAD" }), makeEnv());
    assert.equal(res.status, 401);
  });

  it("HEAD /api/data (rota JSON, também cacheável) não crasha", async () => {
    const res = await worker.fetch(authedHead("/api/data"), makeEnv());
    assert.notEqual(res.status, 500);
  });

  it("HEAD /healthz (rota não-cacheável, fora do gate de auth) não crasha", async () => {
    const res = await worker.fetch(new Request("https://x/healthz", { method: "HEAD" }), makeEnv());
    assert.notEqual(res.status, 500);
  });
});
