/**
 * test/site-worker-apoiar-7915.test.ts (#7915, reescrito no #8498)
 *
 * Cobre o wiring de `/apoiar/ir` e `/apoiar` no router de `workers/site`
 * (mesmo `env.ASSETS` fake e mesma disciplina de `test/site-worker-confirmado-7737.test.ts`):
 *
 *   - GET /apoiar/ir incrementa o contador de CLIQUE e redireciona (302)
 *     pro apoia.se com o UTM do menu, preservando a query string — nunca
 *     chega no ASSETS (não existe arquivo nesse path).
 *   - GET /apoiar (página removida, #8498) é 301 PERMANENTE pro mesmo
 *     destino — nunca 404, nunca serve asset.
 *   - O contador de VISUALIZAÇÃO saiu junto com a página: nenhuma chave
 *     `counter:apoiar:view:*` é escrita.
 *   - KV ausente nunca derruba o redirect — fail-soft.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";
import { apoiarClickCounterKey } from "../scripts/lib/shared/apoiar-counters.ts";
import { DIARIA_APOIASE_URL } from "../scripts/lib/canonical-urls.ts";
import {
  APOIAR_REDIRECT_UTM_SOURCE,
  APOIAR_REDIRECT_UTM_MEDIUM,
  APOIAR_REDIRECT_UTM_CAMPAIGN,
} from "../scripts/lib/shared/utm-registry.ts";

const DEFAULT_TARGET = `${DIARIA_APOIASE_URL}?utm_source=${APOIAR_REDIRECT_UTM_SOURCE}&utm_medium=${APOIAR_REDIRECT_UTM_MEDIUM}&utm_campaign=${APOIAR_REDIRECT_UTM_CAMPAIGN}`;

function makeFakeKv(): { kv: KVNamespace; puts: Record<string, string> } {
  const puts: Record<string, string> = {};
  const kv = {
    get: async (key: string) => puts[key] ?? null,
    put: async (key: string, value: string) => {
      puts[key] = value;
    },
    delete: async () => {},
  } as unknown as KVNamespace;
  return { kv, puts };
}

function fakeEnv(kv?: KVNamespace): { env: Env; assetCalls: Request[] } {
  const assetCalls: Request[] = [];
  const env: Env = {
    ASSETS: {
      fetch: async (req: Request) => {
        assetCalls.push(req);
        return new Response("<html>fake asset</html>", { status: 200 });
      },
    } as unknown as Env["ASSETS"],
    POLL: { get: async () => null },
    ...(kv ? { CURSOS_SUBSCRIBERS: kv } : {}),
  };
  return { env, assetCalls };
}

describe("GET /apoiar/ir (#7915/#8498) — clique de apoio, nunca pagamento confirmado", () => {
  it("redireciona (302) pro apoia.se com o UTM do menu e incrementa o contador de CLIQUE — nunca chega no ASSETS", async () => {
    const { kv, puts } = makeFakeKv();
    const { env, assetCalls } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), DEFAULT_TARGET);
    assert.equal(assetCalls.length, 0, "/apoiar/ir é resolvido ANTES do asset lookup");
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(puts[apoiarClickCounterKey(day)], "1");
  });

  it("preserva a query string do request e não sobrescreve UTM explícito do chamador", async () => {
    const { kv } = makeFakeKv();
    const { env } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir?utm_source=home&ref=x"), env);
    const location = new URL(res.headers.get("Location") ?? "");
    assert.equal(location.origin + location.pathname, DIARIA_APOIASE_URL);
    assert.equal(location.searchParams.get("utm_source"), "home", "UTM explícito vence o default");
    assert.equal(location.searchParams.get("ref"), "x");
    assert.equal(location.searchParams.get("utm_medium"), APOIAR_REDIRECT_UTM_MEDIUM, "ausente → default");
    assert.equal(location.searchParams.get("utm_campaign"), APOIAR_REDIRECT_UTM_CAMPAIGN, "ausente → default");
  });

  it("KV ausente (binding não propagado) não impede o redirect — fail-soft", async () => {
    const { env } = fakeEnv(undefined);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), DEFAULT_TARGET);
  });

  it("POST não é a rota de clique — cai no asset lookup normal, não é redirect", async () => {
    const { kv } = makeFakeKv();
    const { env, assetCalls } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir", { method: "POST" }), env);
    assert.notEqual(res.status, 302);
    assert.equal(assetCalls.length, 1);
  });
});

describe("GET /apoiar (#8498) — página removida, 301 permanente pro Apoia.se", () => {
  for (const path of ["/apoiar", "/apoiar/"]) {
    it(`${path} → 301 pro destino com UTM, sem tocar no ASSETS`, async () => {
      const { kv, puts } = makeFakeKv();
      const { env, assetCalls } = fakeEnv(kv);
      const res = await worker.fetch(new Request(`https://diar.ia.br${path}`), env);
      assert.equal(res.status, 301);
      assert.equal(res.headers.get("Location"), DEFAULT_TARGET);
      assert.equal(assetCalls.length, 0);
      const day = new Date().toISOString().slice(0, 10);
      assert.equal(puts[apoiarClickCounterKey(day)], "1");
    });
  }

  it("preserva a query string no 301", async () => {
    const { env } = fakeEnv(undefined);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar?utm_source=gsc"), env);
    assert.equal(res.status, 301);
    assert.equal(new URL(res.headers.get("Location") ?? "").searchParams.get("utm_source"), "gsc");
  });

  it("nenhuma chave de VISUALIZAÇÃO é escrita — contador saiu com a página", async () => {
    const { kv, puts } = makeFakeKv();
    const { env } = fakeEnv(kv);
    await worker.fetch(new Request("https://diar.ia.br/apoiar"), env);
    assert.deepEqual(Object.keys(puts).filter((k) => k.includes(":view:")), []);
  });

  it("outro path (ex: /apoiar-outra-coisa) não é redirecionado", async () => {
    const { kv } = makeFakeKv();
    const { env, assetCalls } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar-outra-coisa"), env);
    assert.equal(res.status, 200);
    assert.equal(assetCalls.length, 1);
  });
});
