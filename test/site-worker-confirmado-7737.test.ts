/**
 * test/site-worker-confirmado-7737.test.ts (#7737)
 *
 * `GET /confirmado` no Worker `site` (`diar.ia.br/confirmado`) — a página
 * real de confirmação do double opt-in, movida do Worker `poll`
 * (`eia.diar.ia.br/confirmado`, que agora só faz 301 pra cá — cobertura em
 * `test/poll-confirmado-5167.test.ts`). Render puro coberto em
 * `test/confirmado-page-shared-7737.test.ts`; aqui só o wiring do router —
 * resolvido ANTES do asset lookup (mesmo padrão de `/img/{key}`, #7657),
 * mesmo `env.ASSETS` fake de `test/site-worker-kit-fallback-6429.test.ts`.
 */
import { describe, it } from "node:test";
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

describe("GET /confirmado (#7737) — router do Worker site", () => {
  it("200, HTML, corpo da página de confirmação — nunca chega no ASSETS", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmado"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html;charset=utf-8");
    const body = await res.text();
    assert.match(body, /Assinatura confirmada/);
    assert.equal(assetCalls.length, 0, "/confirmado é resolvido ANTES do asset lookup, mesmo padrão de /img/{key}");
  });

  it("canonical da página aponta pro próprio apex", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmado"), env);
    const body = await res.text();
    assert.match(body, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/confirmado">/);
  });

  it("só GET — POST cai no fluxo normal do asset lookup (404 do fake ASSETS)", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmado", { method: "POST" }), env);
    assert.equal(res.status, 404);
    assert.equal(assetCalls.length, 1);
  });
});
