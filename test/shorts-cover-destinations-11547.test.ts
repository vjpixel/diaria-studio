/**
 * #11547 — capa do vertical (o Still do Premiere) nos destinos que aceitam:
 * Facebook (`/{video-id}/thumbnails`), LinkedIn perfil (`uploadThumbnail`),
 * YouTube Shorts (`thumbnails.set`), X/Buffer (`thumbnailOffset`) e o registro
 * por destino em `06-shorts-published.json`. Tudo com fetch falso — nenhuma
 * chamada real a Facebook/LinkedIn/Buffer/YouTube.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHORT_COVER_FILE,
  SHORT_COVER_SOURCE_FILE,
  bufferThumbnailOffsetMs,
  carryOverCover,
  parseShortCoverSource,
  planCoverDestination,
  stillTimecodeOffsetMs,
  withMissingCoverRecord,
} from "../scripts/lib/diaria/short-cover.ts";
import {
  buildMarkEntry,
  enqueueInstagramReel,
  parseThumbnailOffsetArg,
  prepareBufferItem,
  publishFacebookReel,
  publishInstagramReel,
  publishLinkedInProfileVideo,
  publishYouTubeShort,
  readShortCover,
  type GraphDeps,
} from "../scripts/publish-shorts.ts";
import { writeShortCoverSourceSidecar } from "../scripts/fetch-drive-video.ts";
import { LINKEDIN_VIDEOS_FINALIZE_URL, LINKEDIN_VIDEOS_INIT_URL } from "../scripts/lib/linkedin-video.ts";
import { LINKEDIN_POSTS_URL } from "../scripts/lib/linkedin-personal.ts";
import type { YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import { parseShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

describe("#11547 timecode do Still → thumbnailOffset (ms)", () => {
  it("frame 0 do Premiere (o caso da 261029) vira 0", () => {
    assert.equal(stillTimecodeOffsetMs("Diaria comentada_Instagram_V1.00_00_00_00.Still001.jpg"), 0);
  });
  it("segundos + frames a 30 fps", () => {
    assert.equal(stillTimecodeOffsetMs("261027 Vertical (Instagram).00_00_03_08.Still001.jpg"), 3267);
    assert.equal(stillTimecodeOffsetMs("x.00_01_02_15.Still001.jpg"), 62_500);
  });
  it("sem timecode ou timecode inválido → null (não chuta frame)", () => {
    assert.equal(stillTimecodeOffsetMs("capa.jpg"), null);
    assert.equal(stillTimecodeOffsetMs("x.00_00_75_00.Still001.jpg"), null);
    assert.equal(stillTimecodeOffsetMs("x.00_00_01_45.Still001.jpg"), null);
  });
  it("sidecar só vale se o tamanho bate com a capa no disco", () => {
    const raw = JSON.stringify({ name: "V1.00_00_00_00.Still001.jpg", bytes: 9 });
    assert.equal(bufferThumbnailOffsetMs(parseShortCoverSource(raw, 9)), 0);
    assert.equal(parseShortCoverSource(raw, 10), null, "capa trocada depois: o nome não diz mais nada");
    assert.equal(parseShortCoverSource("{", 9), null);
    assert.equal(parseShortCoverSource(null, 9), null);
    assert.equal(bufferThumbnailOffsetMs(null), null);
  });
});

describe("#11547 plano da capa por destino", () => {
  const ctx = { coverPath: "/e/04-youtube-short-capa.jpg", coverUploadReady: true, bufferOffsetMs: 0 };
  it("cada destino com o método certo", () => {
    assert.equal(planCoverDestination({ destination: "facebook:diaria" }, ctx), "thumbnail_upload");
    assert.equal(planCoverDestination({ destination: "linkedin_profile" }, ctx), "thumbnail_upload");
    assert.equal(planCoverDestination({ destination: "youtube_shorts", mode: "api" }, ctx), "thumbnails_set");
    assert.match(planCoverDestination({ destination: "youtube_shorts", mode: "guided" }, ctx), /^guided/);
    assert.equal(planCoverDestination({ destination: "instagram" }, ctx), "cover_url");
    assert.equal(planCoverDestination({ destination: "x" }, ctx), "thumbnail_offset 0 ms");
    assert.match(planCoverDestination({ destination: "threads_profile" }, ctx), /^unsupported/);
  });
  it("sem capa → automático; X sem timecode → a Buffer escolhe", () => {
    const none = { coverPath: null, coverUploadReady: true, bufferOffsetMs: null };
    assert.equal(planCoverDestination({ destination: "facebook:diaria" }, none), "automatic");
    assert.equal(planCoverDestination({ destination: "x" }, none), "automatic");
    assert.match(planCoverDestination({ destination: "x" }, { ...ctx, bufferOffsetMs: null }), /^automatic/);
  });
});

/** Graph falsa: responde em sequência e grava o corpo de cada chamada. */
function fakeGraph(responses: Array<Record<string, unknown> | Error>) {
  const calls: Array<{ url: string; form: Record<string, unknown> | null }> = [];
  let i = 0;
  const deps: GraphDeps = {
    fetch: async (url, init) => {
      const form = init?.body instanceof FormData ? Object.fromEntries([...init.body]) : init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
      calls.push({ url, form });
      const r = responses[i++];
      if (!r) throw new Error(`chamada inesperada: ${url}`);
      if (r instanceof Error) throw r;
      const { __http, ...json } = r as any;
      return new Response(JSON.stringify(json), { status: __http ?? 200 });
    },
    sleep: async () => {},
    now: () => new Date("2026-10-29T08:00:00Z"),
    log: () => {},
  };
  return { deps, calls };
}
const page = { slug: "diaria", enabled: true, pageId: "179", token: "tok", missing: [] as string[], utmContent: "page-diaria" };
function mp4(seconds: number): Buffer {
  const p = Buffer.alloc(100);
  p.writeUInt32BE(1000, 12);
  p.writeUInt32BE(seconds * 1000, 16);
  const mvhd = Buffer.concat([Buffer.from([0, 0, 0, 108, 0x6d, 0x76, 0x68, 0x64]), p]);
  return Buffer.concat([Buffer.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]), Buffer.from([0, 0, 0, 116, 0x6d, 0x6f, 0x6f, 0x76]), mvhd]);
}

describe("#11547 Facebook: POST /{video-id}/thumbnails logo depois do upload", () => {
  it("Reels (≤90 s): source + is_preferred=true, registro cover ok", async () => {
    const { deps, calls } = fakeGraph([{ video_id: "v1" }, { success: true }, { success: true }, { status: { video_status: "ready" } }, { success: true }]);
    const out = await publishFacebookReel(deps, page, "v25.0", mp4(60), "legenda", null, JPEG);
    const thumb = calls[4];
    assert.match(thumb.url, /\/v25\.0\/v1\/thumbnails$/);
    assert.equal(thumb.form?.is_preferred, "true");
    assert.ok(thumb.form?.source instanceof Blob);
    assert.deepEqual(out.entry.cover, { method: "thumbnail_upload", ok: true });
    assert.equal(out.entry.status, "published");
  });

  it("/videos resumable (>90 s): também recebe a capa", async () => {
    const big = mp4(120);
    const { deps, calls } = fakeGraph([
      { upload_session_id: "s", video_id: "v2", start_offset: "0", end_offset: String(big.length) },
      { start_offset: String(big.length), end_offset: String(big.length) },
      { success: true },
      { status: { video_status: "ready" } },
      { success: true },
    ]);
    const out = await publishFacebookReel(deps, page, "v25.0", big, "legenda", null, JPEG);
    assert.match(calls[4].url, /\/v2\/thumbnails$/);
    assert.equal(out.entry.cover?.ok, true);
  });

  it("falha da capa (HTTP 400 ou rede) NÃO derruba o vídeo: registra ok=false + aviso", async () => {
    for (const fail of [{ __http: 400, error: { message: "bad image" } }, new Error("ECONNRESET")]) {
      const { deps } = fakeGraph([{ video_id: "v1" }, { success: true }, { success: true }, { status: { video_status: "ready" } }, fail]);
      const out = await publishFacebookReel(deps, page, "v25.0", mp4(60), "legenda", null, JPEG);
      assert.equal(out.entry.id, "v1");
      assert.equal(out.entry.cover?.ok, false);
      assert.match(out.entry.cover?.error ?? "", /thumbnails/);
      assert.match((out.warnings ?? []).join("\n"), /capa não aplicada/);
    }
  });

  it("sem capa: nenhuma chamada a /thumbnails e sem campo cover", async () => {
    const { deps, calls } = fakeGraph([{ video_id: "v1" }, { success: true }, { success: true }, { status: { video_status: "ready" } }]);
    const out = await publishFacebookReel(deps, page, "v25.0", mp4(60), "legenda", null);
    assert.equal(calls.length, 4);
    assert.equal(out.entry.cover, undefined);
  });
});

describe("#11547 Instagram: o registro diz que a capa foi (cover_url)", () => {
  it("publish direto e fila do Worker", async () => {
    const seq = [{ id: "c" }, { success: true }, { status_code: "FINISHED" }, { id: "m" }, { permalink: "p" }];
    const deps: GraphDeps = { fetch: async () => Response.json(seq.shift()), sleep: async () => {}, now: () => new Date(), log: () => {} };
    const direct = await publishInstagramReel(deps, "ig", "t", "v25.0", Buffer.from("v"), "c", [], "https://cdn/c.jpg");
    assert.deepEqual(direct.entry.cover, { method: "cover_url", ok: true });
    const queued = await enqueueInstagramReel(
      { uploadVideo: async () => "https://cdn/v.mp4", uploadCover: async () => undefined, enqueue: async () => ({ key: "k", scheduled_at: "2026-10-30T12:00:00Z" }), now: () => new Date("2026-10-29") },
      { caption: "x", scheduledAt: "2026-10-30T12:00:00Z", igAccount: "diaria", idempotencyKey: "k" },
      [],
    );
    assert.equal(queued.entry.cover, undefined, "sem capa no R2: frame automático, sem registro de capa");
  });
});

/** LinkedIn falsa com `thumbnailUploadUrl`. */
function fakeLinkedIn(
  opts: {
    thumbStatus?: number;
    finalizeFailsWithThumb?: boolean;
    initFailsWithThumb?: boolean;
    partStatus?: number;
    neverAvailable?: boolean;
    /** #11702: status do vídeo enquanto o upload declarou `uploadThumbnail: true`. */
    statusWithThumb?: "PROCESSING_FAILED" | "PROCESSING";
  } = {},
) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  let initBody: any = null;
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method, body });
    if (url === LINKEDIN_VIDEOS_INIT_URL) {
      initBody = body;
      if (opts.initFailsWithThumb && body.initializeUploadRequest.uploadThumbnail) return new Response("bad thumbnail", { status: 400 });
      return Response.json({
        value: {
          video: "urn:li:video:V1",
          uploadToken: "",
          uploadInstructions: [{ uploadUrl: "https://up.example/p1", firstByte: 0, lastByte: 9 }],
          ...(body.initializeUploadRequest.uploadThumbnail ? { thumbnailUploadUrl: "https://up.example/thumb" } : {}),
        },
      });
    }
    if (url === "https://up.example/thumb") return new Response(null, { status: opts.thumbStatus ?? 201 });
    if (url.startsWith("https://up.example/")) return new Response(null, { status: opts.partStatus ?? 200, headers: { etag: "etag-1" } });
    if (url === LINKEDIN_VIDEOS_FINALIZE_URL) {
      return new Response(null, { status: opts.finalizeFailsWithThumb && initBody?.initializeUploadRequest.uploadThumbnail ? 400 : 200 });
    }
    if (url.startsWith("https://api.linkedin.com/rest/videos/")) {
      if (opts.statusWithThumb && initBody?.initializeUploadRequest.uploadThumbnail) return Response.json({ status: opts.statusWithThumb });
      return Response.json({ status: opts.neverAvailable ? "PROCESSING" : "AVAILABLE" });
    }
    if (url === LINKEDIN_POSTS_URL) return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:99" } });
    throw new Error(`URL inesperada ${url}`);
  };
  return { calls, deps: { fetchFn, sleep: async () => {}, log: () => {}, now: () => new Date("2026-10-29T15:00:00Z") } };
}
const CREDS = { accessToken: "tok", personUrn: "urn:li:person:abc", expiresAt: null };

describe("#11547 LinkedIn perfil: uploadThumbnail + PUT do JPEG", () => {
  it("pede uploadThumbnail:true, sobe o JPEG antes do finalize e registra a capa", async () => {
    const li = fakeLinkedIn();
    const out = await publishLinkedInProfileVideo(li.deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título", JPEG);
    assert.equal(li.calls[0].body.initializeUploadRequest.uploadThumbnail, true);
    const iThumb = li.calls.findIndex((c) => c.url === "https://up.example/thumb");
    const iFin = li.calls.findIndex((c) => c.url === LINKEDIN_VIDEOS_FINALIZE_URL);
    assert.ok(iThumb > 0 && iThumb < iFin, "miniatura sobe antes do finalizeUpload");
    assert.equal(li.calls[iThumb].method, "PUT");
    assert.equal(out.entry.status, "published");
    assert.deepEqual(out.entry.cover, { method: "thumbnail_upload", ok: true });
  });

  it("PUT da miniatura falhou: vídeo sai mesmo assim, cover ok=false + aviso", async () => {
    const li = fakeLinkedIn({ thumbStatus: 500 });
    const out = await publishLinkedInProfileVideo(li.deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título", JPEG);
    assert.equal(out.entry.status, "published");
    assert.equal(out.entry.cover?.ok, false);
    assert.match((out.warnings ?? []).join("\n"), /capa não aplicada/);
  });

  it("upload com capa recusado antes do envio → tenta de novo SEM capa (nada no perfil ainda)", async () => {
    const li = fakeLinkedIn({ finalizeFailsWithThumb: true });
    const out = await publishLinkedInProfileVideo(li.deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título", JPEG);
    const inits = li.calls.filter((c) => c.url === LINKEDIN_VIDEOS_INIT_URL);
    assert.deepEqual(inits.map((c) => c.body.initializeUploadRequest.uploadThumbnail), [true, false]);
    assert.equal(li.calls.filter((c) => c.url === LINKEDIN_POSTS_URL).length, 1, "um post só");
    assert.equal(out.entry.status, "published");
    assert.equal(out.entry.cover?.ok, false);
  });

  it("#11660: initializeUpload recusado com uploadThumbnail:true → repete sem capa", async () => {
    const li = fakeLinkedIn({ initFailsWithThumb: true });
    const out = await publishLinkedInProfileVideo(li.deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título", JPEG);
    const inits = li.calls.filter((c) => c.url === LINKEDIN_VIDEOS_INIT_URL);
    assert.deepEqual(inits.map((c) => c.body.initializeUploadRequest.uploadThumbnail), [true, false]);
    assert.equal(out.entry.status, "published");
  });

  it("#11660: parte do vídeo falhou (não é a capa) → NÃO sobe o vertical de novo", async () => {
    const li = fakeLinkedIn({ partStatus: 500 });
    await publishLinkedInProfileVideo(li.deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título", JPEG).catch(() => null);
    assert.equal(li.calls.filter((c) => c.url === LINKEDIN_VIDEOS_INIT_URL).length, 1, "uma tentativa só");
    assert.equal(li.calls.filter((c) => c.url === LINKEDIN_POSTS_URL).length, 0);
  });

  it("#11660: timeout do processamento (nunca AVAILABLE) → NÃO repete sem capa", async () => {
    const li = fakeLinkedIn({ neverAvailable: true });
    await publishLinkedInProfileVideo(li.deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título", JPEG).catch(() => null);
    assert.equal(li.calls.filter((c) => c.url === LINKEDIN_VIDEOS_INIT_URL).length, 1, "uma tentativa só");
    assert.equal(li.calls.filter((c) => c.url === LINKEDIN_POSTS_URL).length, 0);
  });

  it("#11702: PUT da miniatura falhou + PROCESSING_FAILED → repete sem capa e publica", async () => {
    const li = fakeLinkedIn({ thumbStatus: 500, statusWithThumb: "PROCESSING_FAILED" });
    const out = await publishLinkedInProfileVideo(li.deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título", JPEG);
    const inits = li.calls.filter((c) => c.url === LINKEDIN_VIDEOS_INIT_URL);
    assert.deepEqual(inits.map((c) => c.body.initializeUploadRequest.uploadThumbnail), [true, false]);
    assert.equal(li.calls.filter((c) => c.url === LINKEDIN_POSTS_URL).length, 1, "um post só");
    assert.equal(out.entry.status, "published");
    assert.equal(out.entry.cover?.ok, false);
  });

  it("#11702: PUT da miniatura falhou + nunca AVAILABLE → repete sem capa e publica", async () => {
    const li = fakeLinkedIn({ thumbStatus: 500, statusWithThumb: "PROCESSING" });
    const out = await publishLinkedInProfileVideo(li.deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título", JPEG);
    const inits = li.calls.filter((c) => c.url === LINKEDIN_VIDEOS_INIT_URL);
    assert.deepEqual(inits.map((c) => c.body.initializeUploadRequest.uploadThumbnail), [true, false]);
    assert.equal(out.entry.status, "published");
    assert.match(out.entry.cover?.error ?? "", /PUT da miniatura/);
  });

  it("#11702: capa ACEITA + nunca AVAILABLE segue sem repetir (decisão da #11660)", async () => {
    const li = fakeLinkedIn({ statusWithThumb: "PROCESSING" });
    await publishLinkedInProfileVideo(li.deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título", JPEG).catch(() => null);
    assert.equal(li.calls.filter((c) => c.url === LINKEDIN_VIDEOS_INIT_URL).length, 1, "uma tentativa só");
    assert.equal(li.calls.filter((c) => c.url === LINKEDIN_POSTS_URL).length, 0);
  });

  it("sem capa: uploadThumbnail:false e sem campo cover (comportamento anterior)", async () => {
    const li = fakeLinkedIn();
    const out = await publishLinkedInProfileVideo(li.deps, CREDS, "202608", Buffer.alloc(10), "Texto", "Título");
    assert.equal(li.calls[0].body.initializeUploadRequest.uploadThumbnail, false);
    assert.equal(out.entry.cover, undefined);
  });
});

describe("#11547 YouTube Shorts: thumbnails.set com o Still", () => {
  const ENV = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UC1" };
  const SLOT = "2026-10-29T15:00:00.000Z";
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  function ytDeps(thumbStatus: number) {
    const calls: string[] = [];
    const d: YouTubeUploadDeps = {
      now: () => new Date("2026-10-29T10:00:00Z"),
      fetch: async (url) => {
        calls.push(url);
        if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "tok" });
        if (url.includes("/youtube/v3/channels")) return json(200, { items: [{ id: "UC1" }] });
        if (url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { Location: "https://up/sess" } });
        if (url === "https://up/sess") return json(200, { id: "s1", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: SLOT } });
        if (url.includes("thumbnails/set")) return json(thumbStatus, thumbStatus === 200 ? { items: [] } : { error: { message: "quota" } });
        if (url.includes("/youtube/v3/videos?part=status")) return json(200, { items: [{ id: "s1", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: SLOT } }] });
        throw new Error(`rota não mockada: ${url}`);
      },
    };
    return { d, calls };
  }
  const run = (d: YouTubeUploadDeps) =>
    publishYouTubeShort({ deps: d, env: ENV, aammdd: "261029", title: "T #Shorts", description: "d", scheduledAt: SLOT, file: Buffer.from("mp4"), force: true, cover: JPEG });

  it("ok → registro thumbnails_set ok", async () => {
    const { d, calls } = ytDeps(200);
    const out = await run(d);
    assert.ok(calls.some((u) => u.includes("thumbnails/set?videoId=s1")));
    assert.deepEqual(out.entry.cover, { method: "thumbnails_set", ok: true });
    assert.equal(out.entry.status, "scheduled");
  });

  it("falha do thumbnails.set não desfaz o Short", async () => {
    const { d } = ytDeps(403);
    const out = await run(d);
    assert.equal(out.entry.status, "scheduled");
    assert.equal(out.entry.cover?.ok, false);
    assert.match((out.warnings ?? []).join("\n"), /capa não aplicada/);
  });
});

describe("#11547 X/Buffer: thumbnailOffset em results[].buffer e no registro", () => {
  const item = { destination: "x", mode: "guided" as const, action: "buffer" as const, caption: "texto", scheduledAt: "2026-10-29T15:00:00.000Z", detail: "" };
  it("offset conhecido vai no buffer; null não aparece", async () => {
    const withOffset = await prepareBufferItem(item, async () => "https://media/v.mp4", 0);
    assert.equal(withOffset.buffer?.thumbnailOffset, 0);
    const without = await prepareBufferItem(item, async () => "https://media/v.mp4");
    assert.equal("thumbnailOffset" in (without.buffer ?? {}), false);
  });

  it("--mark x=buffer grava a capa; a confirmação x=URL mantém o registro", () => {
    const built = buildMarkEntry({ destination: "x", url: null, bufferId: "abc" }, "2026-10-29T15:00:00Z", "2026-10-29T10:00:00Z", 0);
    assert.ok(built.ok);
    if (!built.ok) return;
    assert.deepEqual(built.entry.cover, { method: "thumbnail_offset", ok: true, offset_ms: 0 });
    const confirmed = buildMarkEntry({ destination: "x", url: "https://x.com/diariabr/status/1" }, undefined, "2026-10-29T16:00:00Z");
    assert.ok(confirmed.ok);
    if (!confirmed.ok) return;
    assert.deepEqual(carryOverCover(confirmed.entry, built.entry).cover, built.entry.cover);
    assert.equal(carryOverCover(confirmed.entry, { ...built.entry, destination: "instagram" }).cover, undefined);
  });

  it("--thumbnail-offset: só com x=buffer, inteiro ≥ 0; ausente = sem registro de capa", () => {
    assert.deepEqual(parseThumbnailOffsetArg(undefined, true), { ok: true, value: null });
    assert.deepEqual(parseThumbnailOffsetArg("0", true), { ok: true, value: 0 });
    assert.deepEqual(parseThumbnailOffsetArg("3267", true), { ok: true, value: 3267 });
    assert.equal(parseThumbnailOffsetArg("-1", true).ok, false);
    assert.equal(parseThumbnailOffsetArg("1.5", true).ok, false);
    assert.equal(parseThumbnailOffsetArg("0", false).ok, false);
    const noOffset = buildMarkEntry({ destination: "x", url: null, bufferId: "abc" }, undefined, "t");
    assert.ok(noOffset.ok && noOffset.entry.cover === undefined, "sem o offset informado, o registro não afirma capa");
  });

  it("registro com cover continua legível pelo parser estrito", () => {
    const raw = JSON.stringify({ aammdd: "261029", entries: [{ destination: "x", status: "scheduled", id: "buffer:abc", at: "t", cover: { method: "thumbnail_offset", ok: true, offset_ms: 0 } }] });
    assert.equal(parseShortsPublishedFile(raw, "261029").entries[0].cover?.offset_ms, 0);
  });
});

describe("#11547 leitura da capa + sidecar do fetch do Drive", () => {
  it("sidecar escrito pelo fetch vira o offset; capa trocada depois invalida", () => {
    const dir = mkdtempSync(join(tmpdir(), "cover-11547-"));
    try {
      assert.deepEqual(readShortCover(dir), { path: null, bytes: null, bufferOffsetMs: null });
      writeFileSync(join(dir, SHORT_COVER_FILE), JPEG);
      writeShortCoverSourceSidecar(dir, "Diaria comentada_Instagram_V1.00_00_00_00.Still001.jpg", JPEG.length, () => {});
      const r = readShortCover(dir);
      assert.equal(r.path, join(dir, SHORT_COVER_FILE));
      assert.equal(r.bytes?.length, JPEG.length);
      assert.equal(r.bufferOffsetMs, 0);
      writeFileSync(join(dir, SHORT_COVER_FILE), Buffer.concat([JPEG, JPEG]));
      assert.equal(readShortCover(dir).bufferOffsetMs, null);
      writeFileSync(join(dir, SHORT_COVER_FILE), "");
      assert.equal(readShortCover(dir).path, null, "capa vazia = sem capa");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha ao gravar o sidecar só avisa", () => {
    const dir = mkdtempSync(join(tmpdir(), "cover-11547-"));
    try {
      // `_internal` como ARQUIVO: o mkdir do sidecar falha.
      writeFileSync(join(dir, "_internal"), "x");
      const lines: string[] = [];
      writeShortCoverSourceSidecar(dir, "a.00_00_00_00.Still001.jpg", 1, (l) => lines.push(l));
      assert.match(lines.join("\n"), /origem da capa não registrada/);
      assert.ok(SHORT_COVER_SOURCE_FILE.startsWith("_internal/"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11660 capa ausente na pasta da edição vira registro explícito", () => {
  const base = { status: "published", id: "x1", scheduled_at: null, at: "t" } as const;
  it("destinos que aceitam capa por arquivo ganham cover missing_local ok=false", () => {
    for (const destination of ["facebook:diaria", "instagram", "linkedin_profile", "youtube_shorts"]) {
      const e = withMissingCoverRecord({ ...base, destination } as any, false);
      assert.equal(e.cover?.method, "missing_local", destination);
      assert.equal(e.cover?.ok, false);
      assert.match(e.cover?.error ?? "", /04-youtube-short-capa\.jpg ausente/);
    }
  });
  it("capa presente, X/Threads ou registro de capa já existente → intocado", () => {
    assert.equal(withMissingCoverRecord({ ...base, destination: "linkedin_profile" } as any, true).cover, undefined);
    assert.equal(withMissingCoverRecord({ ...base, destination: "x" } as any, false).cover, undefined);
    assert.equal(withMissingCoverRecord({ ...base, destination: "threads_profile" } as any, false).cover, undefined);
    const prior = { method: "thumbnail_upload", ok: true } as const;
    assert.deepEqual(withMissingCoverRecord({ ...base, destination: "instagram", cover: prior } as any, false).cover, prior);
  });
});
