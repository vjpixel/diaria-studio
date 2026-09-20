/**
 * test/site-worker-confirmado-7737.test.ts (#7737, rota renomeada no #8539)
 *
 * `GET /confirmada` no Worker `site` (`diar.ia.br/confirmada`) — a página
 * real de confirmação do double opt-in, movida do Worker `poll`
 * (`eia.diar.ia.br/confirmado`, que agora só faz 301 pra cá — cobertura em
 * `test/poll-confirmado-5167.test.ts`). Render puro coberto em
 * `test/confirmado-page-shared-7737.test.ts`; aqui só o wiring do router —
 * resolvido ANTES do asset lookup (mesmo padrão de `/img/{key}`, #7657),
 * mesmo `env.ASSETS` fake de `test/site-worker-kit-fallback-6429.test.ts`.
 *
 * #8539: a rota renomeou de `/confirmado` pra `/confirmada` — este arquivo
 * cobre os 2 cenários que o critério de aceite da issue pede: `/confirmada`
 * responde 200, e `/confirmado` (nome antigo) vira 301 pra `/confirmada`,
 * NUNCA 404 (link já gravado em e-mails de confirmação entregues e em
 * `opt_in_redirect_url` da Beehiiv/form de DOI do Kit).
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

describe("GET /confirmada (#7737, #8539) — router do Worker site", () => {
  it("200, HTML, corpo da página de confirmação — nunca chega no ASSETS", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmada"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html;charset=utf-8");
    const body = await res.text();
    assert.match(body, /Assinatura confirmada/);
    assert.equal(assetCalls.length, 0, "/confirmada é resolvido ANTES do asset lookup, mesmo padrão de /img/{key}");
  });

  it("canonical da página aponta pro próprio apex, /confirmada", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmada"), env);
    const body = await res.text();
    assert.match(body, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/confirmada">/);
  });

  it("só GET — POST cai no fluxo normal do asset lookup (404 do fake ASSETS)", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmada", { method: "POST" }), env);
    assert.equal(res.status, 404);
    assert.equal(assetCalls.length, 1);
  });

  it("KIT_RECOMMENDATIONS_EMBED_URL setado no Env → widget aparece no corpo servido pelo router", async () => {
    const { env } = fakeEnv();
    env.KIT_RECOMMENDATIONS_EMBED_URL = "https://diariabr.kit.com/profile/recommendations";
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmada"), env);
    const body = await res.text();
    assert.ok(body.includes("<iframe"));
    assert.ok(body.includes(env.KIT_RECOMMENDATIONS_EMBED_URL));
  });
});

describe("GET /confirmado (nome antigo, #8539) — 301 pra /confirmada, NUNCA 404", () => {
  it("301, Location aponta pra /confirmada — link já entregue em e-mail não pode quebrar", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmado"), env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://diar.ia.br/confirmada");
    assert.equal(assetCalls.length, 0, "/confirmado é resolvido ANTES do asset lookup, mesmo padrão de /confirmada");
  });

  it("preserva a query string (UTM) no 301", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmado?utm_source=kit&utm_campaign=doi"), env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://diar.ia.br/confirmada?utm_source=kit&utm_campaign=doi");
  });

  it("só GET — POST cai no fluxo normal do asset lookup (404 do fake ASSETS)", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmado", { method: "POST" }), env);
    assert.equal(res.status, 404);
    assert.equal(assetCalls.length, 1);
  });
});
