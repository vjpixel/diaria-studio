/**
 * worker-img-cors.test.ts
 *
 * Regression test: `/img/{key}` deve servir com `Access-Control-Allow-Origin: *`.
 *
 * Razão: imagens da newsletter daily (#1119) ficam em KV e são fetchadas pelo
 * paste flow rodando em `app.beehiiv.com`. Sem CORS, fetch falha com
 * `Failed to fetch` opaco. As imagens são públicas mesmo — `*` é seguro.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleImage, type Env } from "../workers/poll/src/index.ts";

/** Mock minimal Env com KV stub que retorna 1 imagem fixa. */
function makeEnv(stored: ArrayBuffer | null = new ArrayBuffer(4)): Env {
  return {
    POLL: {
      get: async (_key: string, _type: string) => stored,
    } as unknown as KVNamespace,
    POLL_SECRET: "test",
    ADMIN_SECRET: "test",
    ALLOWED_ORIGINS: "https://diar.ia.br",
  };
}

describe("handleImage CORS", () => {
  it("retorna Access-Control-Allow-Origin: * pra request com chave válida", async () => {
    const env = makeEnv();
    const res = await handleImage("/img/img-260512-cover.jpg", env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("retorna Content-Type image/jpeg + Cache-Control immutable", async () => {
    const env = makeEnv();
    const res = await handleImage("/img/img-260512-cover.jpg", env);
    assert.equal(res.headers.get("Content-Type"), "image/jpeg");
    assert.equal(
      res.headers.get("Cache-Control"),
      "public, max-age=31536000, immutable",
    );
  });

  it("#1132 P2.4: 404 também emite CORS header (pre-check robusto)", async () => {
    const env = makeEnv(null);
    const res = await handleImage("/img/missing.jpg", env);
    assert.equal(res.status, 404);
    assert.equal(
      res.headers.get("Access-Control-Allow-Origin"),
      "*",
      "CORS deve estar presente mesmo em 404 pra pre-check funcionar",
    );
  });

  it("key vazia retorna 404 sem fetch ao KV, com CORS", async () => {
    const env = makeEnv();
    const res = await handleImage("/img/", env);
    assert.equal(res.status, 404);
    assert.equal(
      res.headers.get("Access-Control-Allow-Origin"),
      "*",
      "CORS deve estar presente mesmo em 404 com key vazia",
    );
  });
});
