/**
 * test/indexnow-key-route.test.ts (#5703)
 *
 * Cobre `scripts/lib/shared/indexnow-key-route.ts` (helper puro de match) e
 * a rota `GET /{INDEXNOW_KEY}.txt` nos Workers `cursos` e `livros` — mesmo
 * padrão de `workers/arquivo/src/index.ts` (#4909 item 2), generalizado
 * pros dois hosts que ganharam IndexNow no #5703. `env.INDEXNOW_KEY`
 * ausente é o estado atual de produção nos dois Workers (secret ainda não
 * provisionada — ver PR body) — coberto explicitamente abaixo pra garantir
 * que o comportamento PRÉ-#5703 (nenhuma rota nova, fallback normal) segue
 * intacto até o editor provisionar a chave.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { matchIndexNowKeyPath } from "../scripts/lib/shared/indexnow-key-route.ts";
import cursosWorker, { type Env as CursosEnv } from "../workers/cursos/src/index.ts";
import livrosWorker, { type Env as LivrosEnv } from "../workers/livros/src/index.ts";

describe("matchIndexNowKeyPath (#5703)", () => {
  it("path exato /{key}.txt -> devolve a chave", () => {
    assert.equal(matchIndexNowKeyPath("/minha-chave.txt", "minha-chave"), "minha-chave");
  });

  it("path diferente -> null", () => {
    assert.equal(matchIndexNowKeyPath("/outra-coisa.txt", "minha-chave"), null);
  });

  it("key ausente (undefined) -> null, mesmo com path que 'pareceria' casar", () => {
    assert.equal(matchIndexNowKeyPath("/undefined.txt", undefined), null);
  });

  it("key vazia -> null", () => {
    assert.equal(matchIndexNowKeyPath("/.txt", ""), null);
  });

  it("key com \\n de sobra (grafia errada de wrangler secret put) -> trima antes de comparar (#5620)", () => {
    assert.equal(matchIndexNowKeyPath("/minha-chave.txt", "minha-chave\n"), "minha-chave");
  });
});

function makeCursosEnv(overrides: Partial<CursosEnv> = {}): CursosEnv {
  return {
    ASSETS: { fetch: async () => new Response("teaser", { status: 200 }) } as unknown as Fetcher,
    CURSOS_SUBSCRIBERS: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace,
    COOKIE_HMAC_SECRET: "cookie-secret",
    ...overrides,
  };
}

describe("workers/cursos: GET /{INDEXNOW_KEY}.txt (#5703)", () => {
  it("sem INDEXNOW_KEY configurada -> nenhuma rota nova, cai no fallback ASSETS (comportamento inalterado)", async () => {
    const env = makeCursosEnv();
    const res = await cursosWorker.fetch(new Request("https://cursos.diar.ia.br/algo.txt"), env);
    const body = await res.text();
    assert.equal(body, "teaser");
  });

  it("com INDEXNOW_KEY configurada -> GET /{chave}.txt devolve 200 com a própria chave", async () => {
    const env = makeCursosEnv({ INDEXNOW_KEY: "chave-cursos-opaca" });
    const res = await cursosWorker.fetch(new Request("https://cursos.diar.ia.br/chave-cursos-opaca.txt"), env);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "chave-cursos-opaca");
    assert.match(res.headers.get("Content-Type") ?? "", /text\/plain/);
  });

  it("com INDEXNOW_KEY configurada, path diferente -> não casa a rota nova (fallback normal)", async () => {
    const env = makeCursosEnv({ INDEXNOW_KEY: "chave-cursos-opaca" });
    const res = await cursosWorker.fetch(new Request("https://cursos.diar.ia.br/outra-coisa.txt"), env);
    assert.equal(await res.text(), "teaser");
  });
});

function makeLivrosEnv(overrides: Partial<LivrosEnv> = {}): LivrosEnv {
  return {
    ASSETS: { fetch: async () => new Response("livros teaser", { status: 200 }) } as unknown as Fetcher,
    ...overrides,
  };
}

describe("workers/livros: GET /{INDEXNOW_KEY}.txt (#5703)", () => {
  it("sem INDEXNOW_KEY configurada -> nenhuma rota nova, cai no fallback ASSETS (comportamento inalterado)", async () => {
    const env = makeLivrosEnv();
    const res = await livrosWorker.fetch(new Request("https://livros.diar.ia.br/algo.txt"), env);
    assert.equal(await res.text(), "livros teaser");
  });

  it("com INDEXNOW_KEY configurada -> GET /{chave}.txt devolve 200 com a própria chave", async () => {
    const env = makeLivrosEnv({ INDEXNOW_KEY: "chave-livros-opaca" });
    const res = await livrosWorker.fetch(new Request("https://livros.diar.ia.br/chave-livros-opaca.txt"), env);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "chave-livros-opaca");
    assert.match(res.headers.get("Content-Type") ?? "", /text\/plain/);
  });

  it("com INDEXNOW_KEY configurada, path diferente -> não casa a rota nova (fallback normal)", async () => {
    const env = makeLivrosEnv({ INDEXNOW_KEY: "chave-livros-opaca" });
    const res = await livrosWorker.fetch(new Request("https://livros.diar.ia.br/outra-coisa.txt"), env);
    assert.equal(await res.text(), "livros teaser");
  });
});
