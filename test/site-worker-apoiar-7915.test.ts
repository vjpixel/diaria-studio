/**
 * test/site-worker-apoiar-7915.test.ts (#7915)
 *
 * Cobre o wiring de `/apoiar` e `/apoiar/ir` no router de `workers/site`
 * (mesmo `env.ASSETS` fake e mesma disciplina de `test/site-worker-confirmado-7737.test.ts`/
 * `test/site-worker-ai-fetch-counters-8062.test.ts`):
 *
 *   - GET /apoiar/ir incrementa o contador de CLIQUE e redireciona (302)
 *     pro apoia.se, preservando query string — nunca chega no ASSETS
 *     (não existe arquivo nesse path).
 *   - GET /apoiar incrementa o contador de VISUALIZAÇÃO e AINDA ASSIM cai
 *     no asset lookup normal (quem serve o HTML continua sendo env.ASSETS).
 *   - Nenhum contador é pagamento confirmado — isso é o ponto central da
 *     issue (view/click ≠ receita).
 *   - KV ausente (binding não propagado) nunca derruba a resposta —
 *     fail-soft, mesmo padrão dos demais contadores deste Worker.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";
import { apoiarViewCounterKey, apoiarClickCounterKey } from "../scripts/lib/shared/apoiar-counters.ts";
import { DIARIA_APOIASE_URL } from "../scripts/lib/canonical-urls.ts";

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
        return new Response("<html>fake apoiar page</html>", { status: 200 });
      },
    } as unknown as Env["ASSETS"],
    POLL: { get: async () => null },
    ...(kv ? { CURSOS_SUBSCRIBERS: kv } : {}),
  };
  return { env, assetCalls };
}

describe("GET /apoiar/ir (#7915) — clique de apoio, nunca pagamento confirmado", () => {
  it("redireciona (302) pro apoia.se e incrementa o contador de CLIQUE — nunca chega no ASSETS", async () => {
    const { kv, puts } = makeFakeKv();
    const { env, assetCalls } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), DIARIA_APOIASE_URL);
    assert.equal(assetCalls.length, 0, "/apoiar/ir é resolvido ANTES do asset lookup");
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(puts[apoiarClickCounterKey(day)], "1");
  });

  it("preserva a query string (UTM) no redirect", async () => {
    const { kv } = makeFakeKv();
    const { env } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir?utm_source=home&utm_medium=apoiar"), env);
    const location = res.headers.get("Location") ?? "";
    assert.ok(location.startsWith(DIARIA_APOIASE_URL), `location ${location} não começa com ${DIARIA_APOIASE_URL}`);
    assert.match(location, /utm_source=home/);
    assert.match(location, /utm_medium=apoiar/);
  });

  it("KV ausente (binding não propagado) não impede o redirect — fail-soft", async () => {
    const { env } = fakeEnv(undefined);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), DIARIA_APOIASE_URL);
  });

  it("POST não é a rota de clique — cai no asset lookup normal (404 do fake ASSETS não configurado pra isso, mas não é redirect)", async () => {
    const { kv } = makeFakeKv();
    const { env, assetCalls } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar/ir", { method: "POST" }), env);
    assert.notEqual(res.status, 302);
    assert.equal(assetCalls.length, 1);
  });
});

describe("GET /apoiar (#7915) — visualização da oferta, separada do clique", () => {
  it("incrementa o contador de VISUALIZAÇÃO e AINDA ASSIM serve via ASSETS (não intercepta a resposta)", async () => {
    const { kv, puts } = makeFakeKv();
    const { env, assetCalls } = fakeEnv(kv);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar"), env);
    assert.equal(res.status, 200);
    assert.equal(assetCalls.length, 1, "quem serve o HTML de /apoiar continua sendo env.ASSETS");
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(puts[apoiarViewCounterKey(day)], "1");
  });

  it("visualização e clique nunca colidem na mesma chave — dia igual, prefixo diferente", async () => {
    const { kv, puts } = makeFakeKv();
    const { env } = fakeEnv(kv);
    await worker.fetch(new Request("https://diar.ia.br/apoiar"), env);
    await worker.fetch(new Request("https://diar.ia.br/apoiar/ir"), env);
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(puts[apoiarViewCounterKey(day)], "1");
    assert.equal(puts[apoiarClickCounterKey(day)], "1");
  });

  it("KV ausente não derruba a resposta de /apoiar — fail-soft", async () => {
    const { env } = fakeEnv(undefined);
    const res = await worker.fetch(new Request("https://diar.ia.br/apoiar"), env);
    assert.equal(res.status, 200);
  });

  it("outro path qualquer (ex: /apoiar-outra-coisa) não incrementa o contador de visualização", async () => {
    const { kv, puts } = makeFakeKv();
    const { env } = fakeEnv(kv);
    await worker.fetch(new Request("https://diar.ia.br/apoiar-outra-coisa"), env);
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(puts[apoiarViewCounterKey(day)], undefined);
  });
});
