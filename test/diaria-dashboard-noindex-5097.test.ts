/**
 * test/diaria-dashboard-noindex-5097.test.ts (#5097 item E)
 *
 * `diaria-dashboard` é superfície operacional interna, nunca deveria ser
 * indexável em host nenhum — achado ao vivo do #5097:
 * `https://diaria-dashboard.diaria.workers.dev/` servia 156 KB de HTML sem
 * `X-Robots-Tag` e com `robots.txt` sem nenhuma linha `Disallow`. Este teste
 * cobre os 2 sinais adicionados: `GET /robots.txt` com `Disallow: /`
 * incondicional, e `X-Robots-Tag: noindex` em TODA resposta do Worker
 * (independente de rota/status).
 *
 * Mesmo padrão de import dinâmico + polyfill de `caches` de
 * `test/diaria-dashboard-studio-snapshot-3565.test.ts` (o package.json do
 * worker não declara `"type": "module"`, então `node --import tsx` faz
 * interop CJS/ESM peculiar nesse arquivo — o objeto `{fetch}` do default
 * export aparece aninhado em `mod.default.default`, não `mod.default`).
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
  (globalThis as unknown as { caches: unknown }).caches = {
    default: { match: async () => null, put: async () => {} },
  };
});
after(() => {
  (globalThis as unknown as { caches: unknown }).caches = origCaches;
});

function makeEnv(): Env {
  return {
    DASHBOARD_DATA: { get: async () => null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("GET /robots.txt (#5097 item E)", () => {
  it("200 com Disallow: / incondicional", async () => {
    const res = await worker.fetch(new Request("https://x/robots.txt"), makeEnv());
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /User-agent:\s*\*/);
    assert.match(body, /Disallow:\s*\/\s*$/m);
  });
});

describe("X-Robots-Tag: noindex em toda resposta (#5097 item E)", () => {
  it("/healthz carrega o header", async () => {
    const res = await worker.fetch(new Request("https://x/healthz"), makeEnv());
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
  });

  it("/ (sem dado no KV, 200 'não inicializado') carrega o header", async () => {
    const res = await worker.fetch(new Request("https://x/"), makeEnv());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
  });

  it("/api/data (404 sem dado) também carrega o header — noindex independe do status", async () => {
    const res = await worker.fetch(new Request("https://x/api/data"), makeEnv());
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
  });

  it("rota inexistente (404 genérico) também carrega o header", async () => {
    const res = await worker.fetch(new Request("https://x/rota-que-nao-existe"), makeEnv());
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
  });

  it("Content-Type original é preservado — o wrapper só adiciona o header, não substitui os outros", async () => {
    const res = await worker.fetch(new Request("https://x/healthz"), makeEnv());
    assert.equal(res.headers.get("Content-Type"), "text/plain");
  });
});
