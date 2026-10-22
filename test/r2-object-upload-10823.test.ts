/**
 * #10823 — upload do vertical pro R2 (S3 + SigV4) que dá o `video_url` público
 * do Reels agendado pela fila do Worker. Ver scripts/lib/r2-object-upload.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadR2UploadConfig, r2PublicUrl, signS3Request, uploadToR2, type R2UploadConfig } from "../scripts/lib/r2-object-upload.ts";

describe("#10823 signS3Request", () => {
  it("bate com o vetor 'GET Object' da documentação SigV4 da AWS", () => {
    const h = signS3Request({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      headers: { Range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
    });
    assert.equal(
      h.Authorization,
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    assert.equal(h["x-amz-date"], "20130524T000000Z");
  });
});

describe("#10823 loadR2UploadConfig", () => {
  const full = {
    R2_ACCOUNT_ID: "acc",
    R2_ACCESS_KEY_ID: "k",
    R2_SECRET_ACCESS_KEY: "s",
    SHORTS_R2_BUCKET: "diaria-shorts",
    SHORTS_R2_PUBLIC_BASE: "https://video.diar.ia.br/",
  };
  it("completo → ready, base sem barra no fim", () => {
    const r = loadR2UploadConfig(full);
    assert.ok(r.ready);
    assert.equal(r.ready && r.config.publicBase, "https://video.diar.ia.br");
  });
  it("lista o que falta", () => {
    const r = loadR2UploadConfig({ ...full, R2_SECRET_ACCESS_KEY: "", SHORTS_R2_BUCKET: undefined });
    assert.deepEqual(r, { ready: false, missing: ["R2_SECRET_ACCESS_KEY", "SHORTS_R2_BUCKET"] });
  });
  it("base pública http é recusada (a Graph exige https)", () => {
    const r = loadR2UploadConfig({ ...full, SHORTS_R2_PUBLIC_BASE: "http://x.test" });
    assert.equal(r.ready, false);
  });
});

describe("#10823 uploadToR2", () => {
  const cfg: R2UploadConfig = { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "b", publicBase: "https://v.test" };
  const body = Buffer.from("video-bytes");

  it("PUT assinado no endpoint da conta, depois HEAD na URL pública; devolve a URL pública", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const url = await uploadToR2(
      {
        now: () => new Date("2026-10-22T12:00:00Z"),
        fetch: async (u, init) => {
          calls.push({ url: u, init });
          if (init?.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(body.length) } });
          return new Response("", { status: 200 });
        },
      },
      cfg,
      "shorts/261022-short.mp4",
      body,
      "video/mp4",
    );
    assert.equal(url, "https://v.test/shorts/261022-short.mp4");
    assert.equal(calls[0].url, "https://acc.r2.cloudflarestorage.com/b/shorts/261022-short.mp4");
    assert.equal(calls[0].init?.method, "PUT");
    const h = calls[0].init?.headers as Record<string, string>;
    assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=k\/20261022\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(calls[1].url, url);
    assert.equal(calls[1].init?.method, "HEAD");
  });

  it("PUT recusado → lança, sem HEAD", async () => {
    let n = 0;
    await assert.rejects(
      uploadToR2({ now: () => new Date(), fetch: async () => (n++, new Response("AccessDenied", { status: 403 })) }, cfg, "a.mp4", body, "video/mp4"),
      /R2 PUT a.mp4: HTTP 403 AccessDenied/,
    );
    assert.equal(n, 1);
  });

  it("URL pública que não responde 200 → lança (Graph não baixaria)", async () => {
    await assert.rejects(
      uploadToR2(
        { now: () => new Date(), fetch: async (_u, init) => new Response(null, { status: init?.method === "HEAD" ? 404 : 200 }) },
        cfg,
        "a.mp4",
        body,
        "video/mp4",
      ),
      /não está público \(HEAD 404\)/,
    );
  });

  it("URL pública com tamanho diferente → lança", async () => {
    await assert.rejects(
      uploadToR2(
        {
          now: () => new Date(),
          fetch: async (_u, init) =>
            init?.method === "HEAD" ? new Response(null, { status: 200, headers: { "content-length": "3" } }) : new Response("", { status: 200 }),
        },
        cfg,
        "a.mp4",
        body,
        "video/mp4",
      ),
      /serve 3 bytes/,
    );
  });

  it("r2PublicUrl encoda segmentos sem tocar nas barras", () => {
    assert.equal(r2PublicUrl(cfg, "shorts/a b.mp4"), "https://v.test/shorts/a%20b.mp4");
  });
});
