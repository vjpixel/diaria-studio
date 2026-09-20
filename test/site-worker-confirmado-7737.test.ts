/**
 * test/site-worker-confirmado-7737.test.ts (#7737; rename #8554)
 *
 * `GET /confirmada` no Worker `site` (`diar.ia.br/confirmada`) — a página
 * real de confirmação do double opt-in, movida do Worker `poll`
 * (`eia.diar.ia.br/confirmado`, que agora só faz 301 pra cá — cobertura em
 * `test/poll-confirmado-5167.test.ts`). Render puro coberto em
 * `test/confirmado-page-shared-7737.test.ts`; aqui só o wiring do router —
 * resolvido ANTES do asset lookup (mesmo padrão de `/img/{key}`, #7657),
 * mesmo `env.ASSETS` fake de `test/site-worker-kit-fallback-6429.test.ts`.
 *
 * #8554 (20/09/2026): o path renomeou `/confirmado` → `/confirmada`
 * (concordância de gênero com "assinatura confirmada" — a página não
 * confirma nada masculino). `/confirmado` no apex NUNCA vira 404: e-mails
 * de confirmação do Kit já entregues e o "After confirming redirect to" do
 * form Kit `9897918` apontam pro path antigo, então o router responde 301
 * permanente `/confirmado` → `/confirmada`, preservando a query string
 * (mesmo contrato do redirect de `workers/poll/src/confirmado.ts`, #7799).
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

describe("GET /confirmada (#7737, rename #8554) — router do Worker site", () => {
  it("200, HTML, corpo da página de confirmação — nunca chega no ASSETS", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmada"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html;charset=utf-8");
    const body = await res.text();
    assert.match(body, /Assinatura confirmada/);
    assert.equal(assetCalls.length, 0, "/confirmada é resolvido ANTES do asset lookup, mesmo padrão de /img/{key}");
  });

  // #8539 — o router passou a LER `?via=` e repassar pra `handleConfirmadoPage`.
  // Sem estes dois, um erro de digitação no nome do parâmetro (ou a perda do
  // repasse) passaria batido: toda a cobertura de `?via=` chama o render
  // direto, sem atravessar o router que produção de fato exercita.
  it("?via=brevo chega no render — copy de retomada, não de primeira edição", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmada?via=brevo"), env);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /A diária continua chegando/);
    assert.doesNotMatch(body, /Sua primeira edição chega/);
  });

  it("sem ?via= (e com via desconhecido) serve a copy padrão", async () => {
    const { env } = fakeEnv();
    for (const url of ["https://diar.ia.br/confirmada", "https://diar.ia.br/confirmada?via=sei-la"]) {
      const res = await worker.fetch(new Request(url), env);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Sua primeira edição chega/);
    }
  });

  it("canonical da página aponta pro próprio apex, path novo", async () => {
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
});

describe("GET /confirmado (#8554) — 301 pro path novo, nunca 404", () => {
  it("301 permanente pra /confirmada, sem query string", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmado"), env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://diar.ia.br/confirmada");
    assert.equal(assetCalls.length, 0, "/confirmado é resolvido ANTES do asset lookup, mesmo padrão de /confirmada");
  });

  it("preserva a query string no redirect (UTM/?via=)", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmado?via=brevo&utm_source=kit"), env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://diar.ia.br/confirmada?via=brevo&utm_source=kit");
  });

  it("só GET — POST cai no fluxo normal do asset lookup (404 do fake ASSETS), nunca redireciona", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(new Request("https://diar.ia.br/confirmado", { method: "POST" }), env);
    assert.equal(res.status, 404);
    assert.equal(assetCalls.length, 1);
  });
});
