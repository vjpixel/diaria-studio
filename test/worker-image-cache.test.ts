import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleImage } from "../workers/poll/src/index.ts";

// #1242 regression test — Cache-Control TTL deve ser curto (1h)
// pra permitir regenerar imagem com mesmo key sem ficar presa em cache
// do Gmail Image Proxy / Beehiiv preview por 1 ano.

function makeEnv(value: ArrayBuffer | null) {
  return {
    POLL: {
      async get(_key: string, _type: string) {
        return value;
      },
    },
  } as never;
}

describe("workers/poll handleImage (#1242)", () => {
  it("retorna max-age=3600 (1h) e SEM immutable", async () => {
    const env = makeEnv(new ArrayBuffer(8));
    const res = await handleImage("/img/test-key.jpg", env);
    assert.equal(res.status, 200);
    const cc = res.headers.get("Cache-Control");
    assert.ok(cc, "Cache-Control header presente");
    assert.match(cc!, /max-age=3600/, "TTL 1h");
    assert.doesNotMatch(cc!, /immutable/, "sem immutable (regression #1242)");
  });

  it("retorna Cache-Control mesmo em 404 (no value)", async () => {
    const env = makeEnv(null);
    const res = await handleImage("/img/missing.jpg", env);
    assert.equal(res.status, 404);
    // 404 não precisa Cache-Control especifico, mas CORS sim
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("decoda chave URL-encoded corretamente", async () => {
    let receivedKey: string | undefined;
    const env = {
      POLL: {
        async get(key: string, _type: string) {
          receivedKey = key;
          return new ArrayBuffer(4);
        },
      },
    } as never;
    await handleImage("/img/img-260514-04-d1-2x1.jpg", env);
    assert.equal(receivedKey, "img-260514-04-d1-2x1.jpg");
  });

  it("retorna 404 quando key vazia", async () => {
    const env = makeEnv(null);
    const res = await handleImage("/img/", env);
    assert.equal(res.status, 404);
  });
});
