/**
 * #11412 (fatia 1): imagens públicas novas no R2, `/img/{key}` com fallback
 * KV → R2, flag `public_images_r2.enabled` default OFF.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadR2UploadConfig, uploadToR2, type R2UploadConfig } from "../scripts/lib/r2-object-upload.ts";
import { r2KeyForImageKey, serveKvImage, type KvImageStore, type R2ImageStore } from "../scripts/lib/shared/kv-image.ts";
import {
  PUBLIC_IMAGE_R2_CACHE_CONTROL,
  makeR2ImageUploader,
  readPublicImagesR2Settings,
  resolveR2ImageUploader,
  workerImageUrl,
} from "../scripts/lib/public-images-r2.ts";
import { shouldUploadToR2, uploadPublicImages } from "../scripts/upload-images-public.ts";
import { parsePublicImages } from "../scripts/lib/schemas/public-images.ts";
import { handleImage, type Env } from "../workers/poll/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const R2_ENV = {
  R2_ACCOUNT_ID: "acc",
  R2_ACCESS_KEY_ID: "k",
  R2_SECRET_ACCESS_KEY: "s",
};

describe("#11412 loadR2UploadConfig — nomes genéricos além de SHORTS_*", () => {
  it("R2_BUCKET/R2_PUBLIC_BASE bastam (sem SHORTS_*)", () => {
    const r = loadR2UploadConfig({ ...R2_ENV, R2_BUCKET: "diaria-shorts", R2_PUBLIC_BASE: "https://media.diar.ia.br/" });
    assert.ok(r.ready);
    assert.equal(r.ready && r.config.bucket, "diaria-shorts");
    assert.equal(r.ready && r.config.publicBase, "https://media.diar.ia.br");
  });
  it("SHORTS_* legado continua aceito (é o que está no Doppler)", () => {
    const r = loadR2UploadConfig({ ...R2_ENV, SHORTS_R2_BUCKET: "b-legado", SHORTS_R2_PUBLIC_BASE: "https://v.test" });
    assert.ok(r.ready);
    assert.equal(r.ready && r.config.bucket, "b-legado");
  });
  it("genérico vence o legado quando os dois existem", () => {
    const r = loadR2UploadConfig({
      ...R2_ENV,
      R2_BUCKET: "novo",
      SHORTS_R2_BUCKET: "velho",
      R2_PUBLIC_BASE: "https://novo.test",
      SHORTS_R2_PUBLIC_BASE: "https://velho.test",
    });
    assert.ok(r.ready);
    assert.deepEqual(r.ready && [r.config.bucket, r.config.publicBase], ["novo", "https://novo.test"]);
  });
  it("base http no nome genérico é recusada com o nome usado", () => {
    const r = loadR2UploadConfig({ ...R2_ENV, R2_BUCKET: "b", R2_PUBLIC_BASE: "http://x.test" });
    assert.deepEqual(r, { ready: false, missing: ["R2_PUBLIC_BASE (precisa ser https)"] });
  });
});

describe("#11412 uploadToR2 — Cache-Control do objeto", () => {
  const cfg: R2UploadConfig = { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "b", publicBase: "https://v.test" };
  const body = Buffer.from("img");
  const deps = (calls: Array<{ url: string; init?: RequestInit }>) => ({
    now: () => new Date("2026-10-28T12:00:00Z"),
    fetch: async (u: string, init?: RequestInit) => {
      calls.push({ url: u, init });
      if (init?.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(body.length) } });
      return new Response("", { status: 200 });
    },
  });

  it("cacheControl vai no PUT e entra na assinatura", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await uploadToR2(deps(calls), cfg, "img/261028/a-0123abcd.jpg", body, "image/jpeg", { cacheControl: PUBLIC_IMAGE_R2_CACHE_CONTROL });
    const h = calls[0].init?.headers as Record<string, string>;
    assert.equal(h["cache-control"], "public, max-age=31536000, immutable");
    assert.match(h.Authorization, /SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date,/);
  });

  it("sem cacheControl, o PUT do vertical sai como antes (sem o header)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await uploadToR2(deps(calls), cfg, "shorts/a.mp4", body, "video/mp4");
    const h = calls[0].init?.headers as Record<string, string>;
    assert.equal(h["cache-control"], undefined);
    assert.match(h.Authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/);
  });

  it("img/ não cai na retenção de 7 dias do shorts/ (nenhum LIST depois do upload)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await uploadToR2(deps(calls), cfg, "img/261028/a-0123abcd.jpg", body, "image/jpeg");
    assert.deepEqual(calls.map((c) => c.init?.method), ["PUT", "HEAD"]);
  });
});

describe("#11412 r2KeyForImageKey", () => {
  it("content-addressed → img/{AAMMDD}/{resto}", () => {
    assert.equal(r2KeyForImageKey("img-261028-04-d1-2x1-0123abcd.jpg"), "img/261028/04-d1-2x1-0123abcd.jpg");
  });
  it("sem forma R2 → null", () => {
    assert.equal(r2KeyForImageKey("img-monthly-2610-cover.jpg"), null);
    assert.equal(r2KeyForImageKey("correct:261028"), null, "chave do jogo nunca vira objeto R2");
    assert.equal(r2KeyForImageKey("img-261028-a:b.jpg"), null);
    assert.equal(r2KeyForImageKey("img-261028-../../shorts/x.mp4"), null, "barra não atravessa prefixo");
    assert.equal(r2KeyForImageKey("img-261028-..\\x.jpg"), null);
  });
});

function kvStore(entries: Record<string, ArrayBuffer>): KvImageStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    get: async (key: string) => {
      reads.push(key);
      return entries[key] ?? null;
    },
  };
}

function r2Store(entries: Record<string, { bytes: string; contentType?: string; etag?: string }>, opts: { throws?: boolean } = {}): R2ImageStore & { reads: string[]; heads: string[] } {
  const reads: string[] = [];
  const heads: string[] = [];
  return {
    reads,
    heads,
    head: async (key: string) => {
      heads.push(key);
      if (opts.throws) throw new Error("R2 indisponível");
      const e = entries[key];
      if (!e) return null;
      return { httpEtag: e.etag ?? '"etag-r2"', httpMetadata: e.contentType ? { contentType: e.contentType } : undefined };
    },
    get: async (key: string) => {
      reads.push(key);
      if (opts.throws) throw new Error("R2 indisponível");
      const e = entries[key];
      if (!e) return null;
      return {
        body: new Response(e.bytes).body!,
        httpEtag: e.etag ?? '"etag-r2"',
        httpMetadata: e.contentType ? { contentType: e.contentType } : undefined,
      };
    },
  };
}

const NEW_KEY = "img-261028-04-d1-2x1-0123abcd.jpg";
const NEW_R2_KEY = "img/261028/04-d1-2x1-0123abcd.jpg";

describe("#11412 serveKvImage — fallback KV → R2", () => {
  it("URL antiga (no KV) é servida do KV e o R2 nunca é consultado", async () => {
    const kv = kvStore({ "img-260512-04-d1-2x1-aaaaaaaa.jpg": new TextEncoder().encode("kv").buffer as ArrayBuffer });
    const r2 = r2Store({});
    const res = await serveKvImage("img-260512-04-d1-2x1-aaaaaaaa.jpg", kv, null, r2);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "kv");
    assert.deepEqual(r2.reads, []);
  });

  it("key só no R2 → 200 com os bytes, Content-Type do objeto, immutable, ETag e CORS", async () => {
    const r2 = r2Store({ [NEW_R2_KEY]: { bytes: "r2-bytes", contentType: "image/png", etag: '"abc"' } });
    const res = await serveKvImage(NEW_KEY, kvStore({}), null, r2);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "r2-bytes");
    assert.equal(res.headers.get("Content-Type"), "image/png");
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.equal(res.headers.get("ETag"), '"abc"');
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.deepEqual(r2.reads, [NEW_R2_KEY]);
  });

  it("objeto R2 sem contentType → image/jpeg (mesmo default do KV)", async () => {
    const res = await serveKvImage(NEW_KEY, kvStore({}), null, r2Store({ [NEW_R2_KEY]: { bytes: "x" } }));
    assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  });

  it("If-None-Match com o ETag do R2 → 304 sem corpo", async () => {
    const res = await serveKvImage(NEW_KEY, kvStore({}), '"abc"', r2Store({ [NEW_R2_KEY]: { bytes: "x", etag: '"abc"' } }));
    assert.equal(res.status, 304);
    assert.equal(res.headers.get("ETag"), '"abc"');
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("ausente nos dois → 404 com CORS", async () => {
    const res = await serveKvImage(NEW_KEY, kvStore({}), null, r2Store({}));
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("R2 lança → 503 com CORS (transitório, não 404)", async () => {
    const res = await serveKvImage(NEW_KEY, kvStore({}), null, r2Store({}, { throws: true }));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("HEAD (F4) usa r2.head, nunca r2.get: 200 sem corpo, mesmos headers", async () => {
    const r2 = r2Store({ [NEW_R2_KEY]: { bytes: "r2-bytes", contentType: "image/png", etag: '"abc"' } });
    const res = await serveKvImage(NEW_KEY, kvStore({}), null, r2, "HEAD");
    assert.equal(res.status, 200);
    assert.equal(res.body, null);
    assert.equal(res.headers.get("Content-Type"), "image/png");
    assert.equal(res.headers.get("ETag"), '"abc"');
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.deepEqual(r2.heads, [NEW_R2_KEY]);
    assert.deepEqual(r2.reads, []);
  });

  it("HEAD (F4) ausente → 404; If-None-Match → 304", async () => {
    assert.equal((await serveKvImage(NEW_KEY, kvStore({}), null, r2Store({}), "HEAD")).status, 404);
    const r2 = r2Store({ [NEW_R2_KEY]: { bytes: "x", etag: '"abc"' } });
    const res = await serveKvImage(NEW_KEY, kvStore({}), '"abc"', r2, "HEAD");
    assert.equal(res.status, 304);
    assert.deepEqual(r2.reads, []);
  });

  it("Worker poll: HEAD em /img/ chega como HEAD no R2", async () => {
    const r2 = r2Store({ [NEW_R2_KEY]: { bytes: "via-poll" } });
    const env = {
      POLL: kvStore({}) as unknown as KVNamespace,
      MEDIA: r2,
      POLL_SECRET: "t",
      ADMIN_SECRET: "t",
      ALLOWED_ORIGINS: "https://diar.ia.br",
    } as Env;
    const res = await handleImage(`/img/${NEW_KEY}`, env, new Request(`https://eia.diar.ia.br/img/${NEW_KEY}`, { method: "HEAD" }));
    assert.equal(res.status, 200);
    assert.deepEqual(r2.heads, [NEW_R2_KEY]);
    assert.deepEqual(r2.reads, []);
  });

  it("sem binding R2 → 404 como antes", async () => {
    const res = await serveKvImage(NEW_KEY, kvStore({}), null, undefined);
    assert.equal(res.status, 404);
  });

  it("key fora da allowlist nunca chega ao KV nem ao R2 (#4112)", async () => {
    const kv = kvStore({});
    const r2 = r2Store({});
    const res = await serveKvImage("correct:261028", kv, null, r2);
    assert.equal(res.status, 404);
    assert.deepEqual(kv.reads, []);
    assert.deepEqual(r2.reads, []);
  });

  it("Worker poll: handleImage passa env.MEDIA adiante", async () => {
    const env = {
      POLL: kvStore({}) as unknown as KVNamespace,
      MEDIA: r2Store({ [NEW_R2_KEY]: { bytes: "via-poll" } }),
      POLL_SECRET: "t",
      ADMIN_SECRET: "t",
      ALLOWED_ORIGINS: "https://diar.ia.br",
    } as Env;
    const res = await handleImage(`/img/${NEW_KEY}`, env);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "via-poll");
  });
});

describe("#11412 flag public_images_r2 (default OFF)", () => {
  it("platform.config.json versionado mantém a flag desligada", () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    assert.deepEqual(readPublicImagesR2Settings(cfg), { enabled: false });
  });
  it("bloco ausente ou malformado → desligado", () => {
    assert.equal(readPublicImagesR2Settings({}).enabled, false);
    assert.equal(readPublicImagesR2Settings(null).enabled, false);
    assert.equal(readPublicImagesR2Settings({ public_images_r2: { enabled: "true" } }).enabled, false);
    assert.equal(readPublicImagesR2Settings({ public_images_r2: { enabled: true } }).enabled, true);
  });
  it("desligada → sem uploader, sem aviso", () => {
    assert.deepEqual(resolveR2ImageUploader({ enabled: false }, { ...R2_ENV, R2_BUCKET: "b", R2_PUBLIC_BASE: "https://x" }, "https://w"), { uploader: null });
  });
  it("ligada sem credencial → KV + aviso nomeando o que falta", () => {
    const r = resolveR2ImageUploader({ enabled: true }, {}, "https://w");
    assert.equal(r.uploader, null);
    assert.match(r.warning ?? "", /R2_ACCOUNT_ID.*R2_BUCKET \(ou SHORTS_R2_BUCKET\).*KV/);
  });
  it("ligada com credencial → uploader", () => {
    const r = resolveR2ImageUploader({ enabled: true }, { ...R2_ENV, R2_BUCKET: "b", R2_PUBLIC_BASE: "https://x" }, "https://w");
    assert.equal(typeof r.uploader, "function");
  });
});

describe("#11412 makeR2ImageUploader", () => {
  it("PUT em img/{AAMMDD}/… com immutable; devolve a URL /img/ do Worker (forma de sempre)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r2-up-"));
    try {
      const file = join(dir, "x.jpg");
      writeFileSync(file, "bytes");
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const up = makeR2ImageUploader(
        { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "diaria-shorts", publicBase: "https://media.diar.ia.br" },
        "https://eia.diar.ia.br/",
        {
          now: () => new Date("2026-10-28T12:00:00Z"),
          fetch: async (u, init) => {
            calls.push({ url: u, init });
            return init?.method === "HEAD" ? new Response(null, { status: 200, headers: { "content-length": "5" } }) : new Response("", { status: 200 });
          },
        },
      );
      const url = await up(file, NEW_KEY, "image/jpeg");
      assert.equal(url, `https://eia.diar.ia.br/img/${NEW_KEY}`);
      assert.equal(url, workerImageUrl("https://eia.diar.ia.br", NEW_KEY));
      assert.equal(calls[0].url, `https://acc.r2.cloudflarestorage.com/diaria-shorts/${NEW_R2_KEY}`);
      assert.equal((calls[0].init?.headers as Record<string, string>)["cache-control"], PUBLIC_IMAGE_R2_CACHE_CONTROL);
      assert.equal(calls[1].url, `https://media.diar.ia.br/${NEW_R2_KEY}`);
      // F1: depois do PUT, HEAD na URL do Worker (a que vai pro e-mail).
      assert.equal(calls[2].url, `https://eia.diar.ia.br/img/${NEW_KEY}`);
      assert.equal(calls[2].init?.method, "HEAD");
      // #11459: e também no Worker `site` (home em diar.ia.br/img/…).
      assert.equal(calls[3].url, `https://diar.ia.br/img/${NEW_KEY}`);
      assert.equal(calls[3].init?.method, "HEAD");
      assert.equal(calls.length, 4);
      await assert.rejects(up(file, "img-monthly-x.jpg", "image/jpeg"), /fica no KV/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // F1 (review da #11456): flag ligada antes do binding MEDIA subir → o
  // bucket tem o objeto, mas o Worker responde 404. O uploader tem que lançar
  // para o upload-images-public.ts cair no KV, nunca devolver a URL quebrada.
  function uploaderWithWorker(workerRes: () => Response | Promise<Response>) {
    return makeR2ImageUploader(
      { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "diaria-shorts", publicBase: "https://media.diar.ia.br" },
      "https://eia.diar.ia.br",
      {
        now: () => new Date("2026-10-28T12:00:00Z"),
        fetch: async (u, init) => {
          if (u.startsWith("https://eia.diar.ia.br/")) return workerRes();
          return init?.method === "HEAD" ? new Response(null, { status: 200, headers: { "content-length": "5" } }) : new Response("", { status: 200 });
        },
      },
    );
  }

  for (const status of [404, 503, 403]) {
    it(`Worker responde ${status} na URL /img/ → lança (cai no KV)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "r2-up-"));
      try {
        const file = join(dir, "x.jpg");
        writeFileSync(file, "bytes");
        await assert.rejects(uploaderWithWorker(() => new Response(null, { status }))(file, NEW_KEY, "image/jpeg"), new RegExp(`HTTP ${status}.*KV`));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // #11459: binding MEDIA descomentado só no `poll` → eia.diar.ia.br serve,
  // mas a home (Worker `site`, diar.ia.br/img/…) devolve 404. Tem que cair no KV.
  function uploaderWithSite(siteRes: () => Response, options?: { siteOrigin?: string | null }, workerUrl = "https://eia.diar.ia.br") {
    const calls: string[] = [];
    const up = makeR2ImageUploader(
      { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "diaria-shorts", publicBase: "https://media.diar.ia.br" },
      workerUrl,
      {
        now: () => new Date("2026-10-28T12:00:00Z"),
        fetch: async (u, init) => {
          calls.push(u);
          if (u.startsWith("https://diar.ia.br/")) return siteRes();
          return init?.method === "HEAD" ? new Response(null, { status: 200, headers: { "content-length": "5" } }) : new Response("", { status: 200 });
        },
      },
      options,
    );
    return { up, calls };
  }

  it("#11459: Worker poll 200 mas site (diar.ia.br/img/) 404 → lança (cai no KV)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r2-up-"));
    try {
      const file = join(dir, "x.jpg");
      writeFileSync(file, "bytes");
      const { up, calls } = uploaderWithSite(() => new Response(null, { status: 404 }));
      await assert.rejects(up(file, NEW_KEY, "image/jpeg"), new RegExp(`HTTP 404 em https://diar\\.ia\\.br/img/.*KV`));
      assert.ok(calls.includes(`https://eia.diar.ia.br/img/${NEW_KEY}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#11459: siteOrigin null não confere o site; workerUrl = site não repete o HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r2-up-"));
    try {
      const file = join(dir, "x.jpg");
      writeFileSync(file, "bytes");
      const off = uploaderWithSite(() => new Response(null, { status: 404 }), { siteOrigin: null });
      assert.equal(await off.up(file, NEW_KEY, "image/jpeg"), `https://eia.diar.ia.br/img/${NEW_KEY}`);
      assert.ok(!off.calls.some((u) => u.startsWith("https://diar.ia.br/")));

      const same = uploaderWithSite(() => new Response(null, { status: 200 }), {}, "https://diar.ia.br/");
      await same.up(file, NEW_KEY, "image/jpeg");
      assert.equal(same.calls.filter((u) => u === `https://diar.ia.br/img/${NEW_KEY}`).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("HEAD no Worker falha na rede → lança (cai no KV)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r2-up-"));
    try {
      const file = join(dir, "x.jpg");
      writeFileSync(file, "bytes");
      await assert.rejects(
        uploaderWithWorker(() => {
          throw new Error("ECONNRESET");
        })(file, NEW_KEY, "image/jpeg"),
        /ECONNRESET.*KV/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11412 uploadPublicImages com R2 ligado", () => {
  it("shouldUploadToR2: só content-addressed, nunca o É IA?", () => {
    assert.equal(shouldUploadToR2({}, NEW_KEY, true), true);
    assert.equal(shouldUploadToR2({ noCacheBust: true }, "img-261028-01-eia-A.jpg", true), false);
    assert.equal(shouldUploadToR2({}, NEW_KEY, false), false);
    assert.equal(shouldUploadToR2({}, "img-unknown-04-d1-2x1-0123abcd.jpg", true), false);
  });

  function setupEdition() {
    const base = mkdtempSync(join(tmpdir(), "r2-ed-"));
    const dir = join(base, "261028");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    for (const f of ["04-d1-2x1.jpg", "01-eia-A.jpg", "01-eia-B.jpg"]) writeFileSync(join(dir, f), `bytes-${f}`, "utf8");
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify({ highlights: [{}, {}, {}] }), "utf8");
    return { dir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  }

  it("capa vai pro R2 (target r2), É IA? fica no KV; o cache passa no schema", async () => {
    const { dir, cleanup } = setupEdition();
    try {
      const kv: string[] = [];
      const r2: string[] = [];
      const result = await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: {
          uploadToCloudflare: async (_p, key) => (kv.push(key), `https://kv/img/${key}`),
          uploadToR2: async (_p, key) => (r2.push(key), `https://eia/img/${key}`),
        },
        ensureD1PlayImage: async () => ({ status: "no_hero", path: null }),
      });
      assert.equal(r2.length, 1);
      assert.match(r2[0], /^img-261028-04-d1-2x1-[0-9a-f]{8}\.jpg$/);
      assert.deepEqual(kv.sort(), ["img-261028-01-eia-A.jpg", "img-261028-01-eia-B.jpg"]);
      assert.equal(result.images.cover.target, "r2");
      assert.equal(result.images.cover.url, `https://eia/img/${r2[0]}`);
      assert.equal(result.images.cover.cloudflare_url, result.images.cover.url);
      assert.equal(result.images.cover.file_id, r2[0]);
      assert.equal(result.images.eia_a.target, "cloudflare");
      parsePublicImages(JSON.parse(readFileSync(join(dir, "06-public-images.json"), "utf8")));

      // 2ª rodada com R2 ligado: reusa (nenhum upload novo).
      const again: string[] = [];
      await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: {
          uploadToCloudflare: async (_p, key) => (again.push(key), `https://kv/img/${key}`),
          uploadToR2: async (_p, key) => (again.push(key), `https://eia/img/${key}`),
        },
        ensureD1PlayImage: async () => ({ status: "no_hero", path: null }),
      });
      assert.deepEqual(again, []);

      // Flag desligada depois: a capa volta pro KV (target diferente → re-upload).
      const off: string[] = [];
      const back = await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: { uploadToCloudflare: async (_p, key) => (off.push(key), `https://kv/img/${key}`) },
        ensureD1PlayImage: async () => ({ status: "no_hero", path: null }),
      });
      assert.deepEqual(off, [r2[0]]);
      assert.equal(back.images.cover.target, "cloudflare");
    } finally {
      cleanup();
    }
  });

  it("cache KV anterior + flag ligada → capa migra pro R2", async () => {
    const { dir, cleanup } = setupEdition();
    try {
      await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: { uploadToCloudflare: async (_p, key) => `https://kv/img/${key}` },
        ensureD1PlayImage: async () => ({ status: "no_hero", path: null }),
      });
      const r2: string[] = [];
      const kv: string[] = [];
      const res = await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: {
          uploadToCloudflare: async (_p, key) => (kv.push(key), `https://kv/img/${key}`),
          uploadToR2: async (_p, key) => (r2.push(key), `https://eia/img/${key}`),
        },
        ensureD1PlayImage: async () => ({ status: "no_hero", path: null }),
      });
      assert.equal(r2.length, 1, "capa re-enviada pro R2");
      assert.deepEqual(kv, [], "É IA? cacheado no KV é reusado");
      assert.equal(res.images.cover.target, "r2");
    } finally {
      cleanup();
    }
  });

  it("F1 ponta a ponta: Worker em 404 (binding ausente) → capa vai pro KV, com aviso", async () => {
    const { dir, cleanup } = setupEdition();
    try {
      const kv: string[] = [];
      let putSize = 0;
      const up = makeR2ImageUploader(
        { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "b", publicBase: "https://media.diar.ia.br" },
        "https://eia.diar.ia.br",
        {
          now: () => new Date("2026-10-28T12:00:00Z"),
          fetch: async (u, init) => {
            if (u.startsWith("https://eia.diar.ia.br/")) return new Response("not found", { status: 404 });
            if (init?.method === "PUT") {
              putSize = (init.body as Uint8Array).byteLength;
              return new Response("", { status: 200 });
            }
            return new Response(null, { status: 200, headers: { "content-length": String(putSize) } });
          },
        },
      );
      const res = await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: {
          uploadToCloudflare: async (_p, key) => (kv.push(key), `https://kv/img/${key}`),
          uploadToR2: up,
        },
        ensureD1PlayImage: async () => ({ status: "no_hero", path: null }),
      });
      assert.equal(res.images.cover.target, "cloudflare");
      assert.equal(kv.length, 3);
      assert.ok(res.warnings.some((w) => w.startsWith("cover") && w.includes("R2 falhou") && w.includes("HTTP 404")), JSON.stringify(res.warnings));
    } finally {
      cleanup();
    }
  });

  it("falha no PUT do R2 → imagem vai pro KV, com aviso (nunca fica sem imagem)", async () => {
    const { dir, cleanup } = setupEdition();
    try {
      const kv: string[] = [];
      const res = await uploadPublicImages({
        editionDir: dir,
        mode: "newsletter",
        uploaders: {
          uploadToCloudflare: async (_p, key) => (kv.push(key), `https://kv/img/${key}`),
          uploadToR2: async () => {
            throw new Error("R2 PUT x: HTTP 403");
          },
        },
        ensureD1PlayImage: async () => ({ status: "no_hero", path: null }),
      });
      assert.equal(res.images.cover.target, "cloudflare");
      assert.match(res.images.cover.url, /^https:\/\/kv\/img\/img-261028-04-d1-2x1-/);
      assert.equal(kv.length, 3);
      assert.ok(res.warnings.some((w) => w.startsWith("cover") && w.includes("R2 falhou") && w.includes("HTTP 403")), JSON.stringify(res.warnings));
    } finally {
      cleanup();
    }
  });
});
