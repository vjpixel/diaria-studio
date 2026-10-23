/**
 * #10923 — o bucket R2 dos verticais não tinha expiração: ~275 MB/dia enchiam
 * os 10 GB do plano gratuito em ~36 dias. Agora o upload de `shorts/` apaga os
 * objetos do prefixo com mais de 7 dias (nunca o recém-enviado), com a mesma
 * chave de API, e falha da limpeza não derruba o upload.
 * Ver scripts/lib/r2-object-upload.ts. Tudo com fetch falso — nada ao vivo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  R2_RETENTION_POLICIES,
  parseListObjectsV2,
  pruneR2Prefix,
  signS3Request,
  uploadToR2,
  type R2UploadConfig,
} from "../scripts/lib/r2-object-upload.ts";

const cfg: R2UploadConfig = { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "b", publicBase: "https://v.test" };
const NOW = new Date("2026-10-23T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const listXml = (objs: { key: string; lm: string }[], next?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>b</Name>` +
  objs.map((o) => `<Contents><Key>${o.key}</Key><LastModified>${o.lm}</LastModified><Size>1</Size></Contents>`).join("") +
  (next ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${next}</NextContinuationToken>` : `<IsTruncated>false</IsTruncated>`) +
  `</ListBucketResult>`;

describe("#10923 signS3Request com query", () => {
  it("bate com o vetor 'GET Bucket (List Objects)' da documentação SigV4 da AWS", () => {
    const h = signS3Request({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/",
      query: { "max-keys": "2", prefix: "J" },
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
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});

describe("#10923 parseListObjectsV2", () => {
  it("lê keys (com entidades XML), datas e o token de continuação", () => {
    const r = parseListObjectsV2(listXml([{ key: "shorts/a&amp;b.mp4", lm: "2026-10-01T00:00:00.000Z" }], "tok&amp;1"));
    assert.deepEqual(r.objects.map((o) => o.key), ["shorts/a&b.mp4"]);
    assert.equal(r.objects[0].lastModified.toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(r.nextToken, "tok&1");
    assert.equal(parseListObjectsV2(listXml([])).nextToken, null);
  });
});

describe("#10923 retenção dos verticais", () => {
  it("a política cobre o prefixo onde o publish-shorts sobe o vertical", () => {
    // scripts/publish-shorts.ts sobe em `shorts/${shortVideoFileName(aammdd)}`.
    const p = R2_RETENTION_POLICIES.find((x) => "shorts/261023-short.mp4".startsWith(x.prefix));
    assert.ok(p, "sem política para shorts/ o bucket volta a crescer sem limite");
    assert.ok(p.maxAgeDays >= 2 && p.maxAgeDays * 0.275 < 10, "folga pro reenfileiramento e abaixo dos 10 GB gratuitos");
  });

  it("upload em shorts/ apaga só os objetos velhos do prefixo, nunca o recém-enviado", async () => {
    const calls: { url: string; method: string }[] = [];
    const body = Buffer.from("video");
    const listed = [
      { key: "shorts/261001-short.mp4", lm: daysAgo(22) },
      { key: "shorts/261015-short.mp4", lm: daysAgo(8) },
      { key: "shorts/261020-short.mp4", lm: daysAgo(3) },
      // re-upload do mesmo dia com LastModified antigo (relógio/cache): nunca apaga o que acabou de subir
      { key: "shorts/261023-short.mp4", lm: daysAgo(30) },
    ];
    const url = await uploadToR2(
      {
        now: () => NOW,
        warn: () => {},
        fetch: async (u, init) => {
          const method = init?.method ?? "GET";
          calls.push({ url: u, method });
          if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(body.length) } });
          if (method === "GET") return new Response(listXml(listed), { status: 200 });
          if (method === "DELETE") return new Response(null, { status: 204 });
          return new Response("", { status: 200 });
        },
      },
      cfg,
      "shorts/261023-short.mp4",
      body,
      "video/mp4",
    );
    assert.equal(url, "https://v.test/shorts/261023-short.mp4");
    const list = calls.find((c) => c.method === "GET")!;
    assert.equal(list.url, "https://acc.r2.cloudflarestorage.com/b?list-type=2&prefix=shorts%2F");
    assert.deepEqual(
      calls.filter((c) => c.method === "DELETE").map((c) => c.url),
      ["https://acc.r2.cloudflarestorage.com/b/shorts/261001-short.mp4", "https://acc.r2.cloudflarestorage.com/b/shorts/261015-short.mp4"],
    );
  });

  it("falha da limpeza só avisa: o upload devolve a URL", async () => {
    const warnings: string[] = [];
    const body = Buffer.from("video");
    const url = await uploadToR2(
      {
        now: () => NOW,
        warn: (m) => warnings.push(m),
        fetch: async (_u, init) => {
          if (init?.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(body.length) } });
          if (init?.method === "GET") return new Response("AccessDenied", { status: 403 });
          return new Response("", { status: 200 });
        },
      },
      cfg,
      "shorts/261023-short.mp4",
      body,
      "video/mp4",
    );
    assert.equal(url, "https://v.test/shorts/261023-short.mp4");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /R2 LIST shorts\/: HTTP 403/);
  });

  it("key fora de prefixo com política → nenhuma listagem", async () => {
    const methods: string[] = [];
    const body = Buffer.from("x");
    await uploadToR2(
      {
        now: () => NOW,
        fetch: async (_u, init) => {
          methods.push(init?.method ?? "GET");
          return init?.method === "HEAD" ? new Response(null, { status: 200, headers: { "content-length": "1" } }) : new Response("", { status: 200 });
        },
      },
      cfg,
      "outros/a.mp4",
      body,
      "video/mp4",
    );
    assert.deepEqual(methods, ["PUT", "HEAD"]);
  });

  it("pruneR2Prefix segue a paginação e nunca lança em erro de rede", async () => {
    const tokens: (string | null)[] = [];
    const r = await pruneR2Prefix(
      {
        now: () => NOW,
        fetch: async (u, init) => {
          if (init?.method === "DELETE") throw new Error("ECONNRESET");
          const t = new URL(u).searchParams.get("continuation-token");
          tokens.push(t);
          return new Response(t ? listXml([{ key: "shorts/b.mp4", lm: daysAgo(9) }]) : listXml([{ key: "shorts/a.mp4", lm: daysAgo(9) }], "p2"), { status: 200 });
        },
      },
      cfg,
      { prefix: "shorts/", maxAgeDays: 7 },
    );
    assert.deepEqual(tokens, [null, "p2"]);
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(r.errors, ["R2 DELETE shorts/a.mp4: ECONNRESET", "R2 DELETE shorts/b.mp4: ECONNRESET"]);
  });
});
