/**
 * test/poll-img-etag-cache-5136.test.ts (#5136)
 *
 * `/img/{key}` (workers/poll) ganhou `ETag` + `Cache-Control` diferenciado
 * por classe de key:
 *   - key content-addressed (nome já carrega hash — destaques d1/d2/d3, ver
 *     `cloudflareKvKey`/#1584) → `immutable`, 1 ano. Seguro: uma regeneração
 *     grava numa key NOVA, a antiga nunca muda de conteúdo.
 *   - key de convenção fixa (É IA? A/B, `noCacheBust: true`, #1704) →
 *     mantém o `max-age=3600` de sempre (#1242), porque o /vote depende do
 *     nome nunca mudar entre regenerações — o CONTEÚDO por trás do mesmo
 *     nome pode mudar.
 *
 * `isContentAddressedImageKey`/`imageCacheControlFor` são funções puras
 * (lib.ts) testadas isoladas; o e2e do handler cobre ETag + 304 condicional.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isContentAddressedImageKey, imageCacheControlFor } from "../workers/poll/src/lib.ts";
import { handleImage, type Env } from "../workers/poll/src/index.ts";

describe("isContentAddressedImageKey (#5136)", () => {
  it("key com sufixo hash de 8 chars hex → true (destaque d1/d2/d3)", () => {
    // Exemplo literal citado na issue #5136.
    assert.equal(isContentAddressedImageKey("img-260812-04-d1-2x1-2a65aa66.jpg"), true);
  });

  it("key de convenção fixa do É IA? (A/B) → false", () => {
    assert.equal(isContentAddressedImageKey("img-260812-01-eia-A.jpg"), false);
    assert.equal(isContentAddressedImageKey("img-260812-01-eia-B.jpg"), false);
  });

  it("naming legado real/ia → false", () => {
    assert.equal(isContentAddressedImageKey("img-260812-01-eia-real.jpg"), false);
    assert.equal(isContentAddressedImageKey("img-260812-01-eia-ia.jpg"), false);
  });

  it("sufixo de 7 ou 9 chars hex NÃO conta como hash (só 8 é o formato real)", () => {
    assert.equal(isContentAddressedImageKey("img-260812-04-d1-abcdef1.jpg"), false);
    assert.equal(isContentAddressedImageKey("img-260812-04-d1-abcdef123.jpg"), false);
  });

  it("sufixo com caractere não-hex não conta", () => {
    assert.equal(isContentAddressedImageKey("img-260812-04-d1-abcdefgh.jpg"), false);
  });
});

describe("imageCacheControlFor (#5136)", () => {
  it("key content-addressed → immutable, 1 ano", () => {
    assert.equal(
      imageCacheControlFor("img-260812-04-d1-2x1-2a65aa66.jpg"),
      "public, max-age=31536000, immutable",
    );
  });

  it("key de convenção fixa → max-age=3600 (comportamento pré-#5136 preservado, #1242)", () => {
    assert.equal(imageCacheControlFor("img-260812-01-eia-A.jpg"), "public, max-age=3600");
  });
});

describe("handleImage — ETag + Cache-Control por classe de key (#5136)", () => {
  function makeEnv(stored: ArrayBuffer): Env {
    return {
      POLL: { get: async () => stored } as unknown as KVNamespace,
      POLL_SECRET: "test",
      ADMIN_SECRET: "test",
      ALLOWED_ORIGINS: "https://diar.ia.br",
    };
  }

  const body = new TextEncoder().encode("conteúdo-fake-de-imagem").buffer;

  it("destaque (key com hash) → Cache-Control immutable + ETag presente", async () => {
    const res = await handleImage("/img/img-260812-04-d1-2x1-2a65aa66.jpg", makeEnv(body));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.ok(res.headers.get("ETag"), "ETag deveria estar presente");
  });

  it("É IA? A/B (key sem hash) → Cache-Control continua max-age=3600, mas ganha ETag", async () => {
    const res = await handleImage("/img/img-260812-01-eia-A.jpg", makeEnv(body));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
    assert.ok(res.headers.get("ETag"), "ETag deveria estar presente mesmo na key de convenção fixa");
  });

  it("ETag é determinístico pro mesmo conteúdo (mesmos bytes → mesmo hash)", async () => {
    const res1 = await handleImage("/img/img-260812-04-d1-2x1-aaaaaaaa.jpg", makeEnv(body));
    const res2 = await handleImage("/img/img-260812-04-d1-2x1-bbbbbbbb.jpg", makeEnv(body));
    assert.equal(res1.headers.get("ETag"), res2.headers.get("ETag"));
  });

  it("ETag muda quando o conteúdo muda (key igual, bytes diferentes — caso regen)", async () => {
    const envA = makeEnv(body);
    const envB = makeEnv(new TextEncoder().encode("conteúdo-diferente").buffer);
    const resA = await handleImage("/img/img-260812-01-eia-A.jpg", envA);
    const resB = await handleImage("/img/img-260812-01-eia-A.jpg", envB);
    assert.notEqual(resA.headers.get("ETag"), resB.headers.get("ETag"));
  });

  it("If-None-Match batendo o ETag atual → 304 sem corpo", async () => {
    const env = makeEnv(body);
    const first = await handleImage("/img/img-260812-04-d1-2x1-2a65aa66.jpg", env);
    const etag = first.headers.get("ETag");
    assert.ok(etag);

    const req = new Request("https://eia.diar.ia.br/img/img-260812-04-d1-2x1-2a65aa66.jpg", {
      headers: { "If-None-Match": etag! },
    });
    const second = await handleImage("/img/img-260812-04-d1-2x1-2a65aa66.jpg", env, req);
    assert.equal(second.status, 304);
    assert.equal(await second.arrayBuffer().then((b) => b.byteLength), 0);
    assert.equal(second.headers.get("ETag"), etag);
    assert.equal(second.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  });

  it("If-None-Match desatualizado (ETag antigo, conteúdo mudou) → 200 normal, não 304", async () => {
    const req = new Request("https://eia.diar.ia.br/img/img-260812-01-eia-A.jpg", {
      headers: { "If-None-Match": '"etag-antigo-que-nao-bate"' },
    });
    const res = await handleImage("/img/img-260812-01-eia-A.jpg", makeEnv(body), req);
    assert.equal(res.status, 200);
  });

  it("sem header If-None-Match (request passado mas sem o header) → 200 normal", async () => {
    const req = new Request("https://eia.diar.ia.br/img/img-260812-04-d1-2x1-2a65aa66.jpg");
    const res = await handleImage("/img/img-260812-04-d1-2x1-2a65aa66.jpg", makeEnv(body), req);
    assert.equal(res.status, 200);
  });

  it("sem `request` (compat com callers antigos que só passam path+env) → 200 normal", async () => {
    const res = await handleImage("/img/img-260812-04-d1-2x1-2a65aa66.jpg", makeEnv(body));
    assert.equal(res.status, 200);
  });
});
