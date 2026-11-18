/**
 * test/r2-upload-network-retry-13566.test.ts (#13566, #13567)
 *
 * Em 18/11/2026 (edição 261118) os timers do Threads pessoal e do Instagram
 * falharam com um `fetch failed` seco no upload do vertical (146,6 MB) ao R2.
 * Uma hora depois a rodada seguinte achou o objeto do dia no bucket com o
 * mesmo ETag: o PUT gravou e só a resposta se perdeu. Antes do fix o
 * `reuseOrUploadToR2` lançava na 1ª falha de rede, o post atrasava 1 h e o
 * alarme dizia só "fetch failed", sem o request nem a causa.
 *
 * Fetch mockado, nada de rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  R2NetworkError,
  R2_NETWORK_ATTEMPTS,
  describeNetworkError,
  reuseOrUploadToR2,
  type R2UploadConfig,
} from "../scripts/lib/r2-object-upload.ts";

const cfg: R2UploadConfig = {
  accountId: "acc",
  accessKeyId: "AK",
  secretAccessKey: "SK",
  bucket: "diaria-shorts",
  publicBase: "https://media.diar.ia.br",
};
const body = Buffer.from("vertical-261118");
const etag = `"${createHash("md5").update(body).digest("hex")}"`;
const AT = new Date("2026-11-18T16:00:00.000Z");

/** O `TypeError: fetch failed` do undici, com a causa encadeada. */
function undiciFetchFailed(code: string, message: string): TypeError {
  const cause = Object.assign(new Error(message), { code });
  return new TypeError("fetch failed", { cause });
}

const okHead = () => new Response(null, { status: 200, headers: { "content-length": String(body.length), etag } });
const missingHead = () => new Response(null, { status: 404 });
const listOk = () => new Response("<ListBucketResult></ListBucketResult>", { status: 200 });

describe("#13566 reuseOrUploadToR2 com falha de rede", () => {
  it("cenário da 261118: o PUT perde a resposta mas grava; a reconferência acha o objeto e não reenvia", async () => {
    const calls: string[] = [];
    let objectInBucket = false;
    const sleeps: number[] = [];
    const fetch = async (_u: string, i?: RequestInit) => {
      const m = i?.method ?? "GET";
      calls.push(m);
      if (m === "HEAD") return objectInBucket ? okHead() : missingHead();
      if (m === "PUT") {
        objectInBucket = true; // o R2 gravou...
        throw undiciFetchFailed("UND_ERR_SOCKET", "other side closed"); // ...e a resposta se perdeu
      }
      return listOk();
    };
    const r = await reuseOrUploadToR2({ fetch, now: () => AT, warn: () => {}, sleep: async (ms) => void sleeps.push(ms) }, cfg, "shorts/diaria-comentada-261118-short.mp4", body, "video/mp4");
    assert.deepEqual(r, { url: "https://media.diar.ia.br/shorts/diaria-comentada-261118-short.mp4", reused: true });
    assert.deepEqual(calls, ["HEAD", "PUT", "HEAD"], "um PUT só: depois da falha, reconfere e reaproveita");
    assert.equal(sleeps.length, 1);
  });

  it("o PUT falha por rede e não grava: a 2ª tentativa sobe de novo e dá certo", async () => {
    let puts = 0;
    let objectInBucket = false;
    const fetch = async (_u: string, i?: RequestInit) => {
      const m = i?.method ?? "GET";
      if (m === "HEAD") return objectInBucket ? okHead() : missingHead();
      if (m === "PUT") {
        puts++;
        if (puts === 1) throw undiciFetchFailed("ECONNRESET", "read ECONNRESET");
        objectInBucket = true;
        return new Response(null, { status: 200 });
      }
      return listOk();
    };
    const r = await reuseOrUploadToR2({ fetch, now: () => AT, warn: () => {}, sleep: async () => {} }, cfg, "shorts/v.mp4", body, "video/mp4");
    assert.equal(r.reused, false);
    assert.equal(puts, 2);
  });

  it("rede fora em todas as tentativas: lança R2NetworkError com o request e a causa do undici", async () => {
    let puts = 0;
    const warns: string[] = [];
    const fetch = async (_u: string, i?: RequestInit) => {
      const m = i?.method ?? "GET";
      if (m === "HEAD") return missingHead();
      if (m === "PUT") {
        puts++;
        throw undiciFetchFailed("EAI_AGAIN", "getaddrinfo EAI_AGAIN acc.r2.cloudflarestorage.com");
      }
      return listOk();
    };
    await assert.rejects(
      reuseOrUploadToR2({ fetch, now: () => AT, warn: (m) => void warns.push(m), sleep: async () => {} }, cfg, "shorts/v.mp4", body, "video/mp4"),
      (e: unknown) => {
        assert.ok(e instanceof R2NetworkError);
        assert.match((e as Error).message, /^R2 PUT shorts\/v\.mp4: fetch failed \(EAI_AGAIN: getaddrinfo EAI_AGAIN/);
        return true;
      },
    );
    assert.equal(puts, R2_NETWORK_ATTEMPTS);
    assert.equal(warns.length, R2_NETWORK_ATTEMPTS - 1);
  });

  it("HTTP de erro do PUT não é rede: lança na hora, sem nova tentativa", async () => {
    let puts = 0;
    const fetch = async (_u: string, i?: RequestInit) => {
      const m = i?.method ?? "GET";
      if (m === "HEAD") return missingHead();
      if (m === "PUT") return (puts++, new Response("AccessDenied", { status: 403 }));
      return listOk();
    };
    await assert.rejects(reuseOrUploadToR2({ fetch, now: () => AT, sleep: async () => {} }, cfg, "shorts/v.mp4", body, "video/mp4"), /R2 PUT shorts\/v\.mp4: HTTP 403/);
    assert.equal(puts, 1);
  });

  it("timeout do PUT não repete (seguraria o lock do timer por mais 15 min)", async () => {
    let puts = 0;
    const fetch = async (_u: string, i?: RequestInit) => {
      const m = i?.method ?? "GET";
      if (m === "HEAD") return missingHead();
      if (m === "PUT") {
        puts++;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return listOk();
    };
    await assert.rejects(reuseOrUploadToR2({ fetch, now: () => AT, sleep: async () => {} }, cfg, "shorts/v.mp4", body, "video/mp4"), (e: unknown) => (e as Error).name === "TimeoutError");
    assert.equal(puts, 1);
  });
});

describe("#13566 describeNetworkError", () => {
  it("põe o code e a mensagem da causa ao lado do 'fetch failed'", () => {
    assert.equal(describeNetworkError(undiciFetchFailed("UND_ERR_SOCKET", "other side closed")), "fetch failed (UND_ERR_SOCKET: other side closed)");
  });
  it("sem causa, fica a mensagem", () => {
    assert.equal(describeNetworkError(new TypeError("fetch failed")), "fetch failed");
  });
  it("causa só com code não repete o code", () => {
    const e = new TypeError("fetch failed", { cause: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }) });
    assert.equal(describeNetworkError(e), "fetch failed (ECONNRESET)");
  });
});
