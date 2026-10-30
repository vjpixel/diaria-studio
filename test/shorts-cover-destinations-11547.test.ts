import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishFacebookReel, publishLinkedInProfileVideo, prepareBufferItem, shortCoverOffset, readShortCoverOffset } from "../scripts/publish-shorts.ts";
import { parseShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";

const now = () => new Date("2026-10-30T10:00:00Z");
const cover = Buffer.from("jpeg");
function mp4(seconds: number) {
  const payload = Buffer.alloc(100);
  payload.writeUInt32BE(1000, 12);
  payload.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([Buffer.from([0,0,0,116,109,111,111,118,0,0,0,108,109,118,104,100]), payload]);
}
for (const seconds of [60, 120]) for (const fails of [false, true]) {
  test(`Facebook ${seconds}s: capa ${fails ? "falha sem perder vídeo" : "recebida e registrada"}`, async () => {
    let thumbnail = false;
    const file = mp4(seconds);
    const fetchFn: typeof fetch = async (url, init) => {
      const u = String(url);
      const body = init?.body;
      if (u.endsWith("/thumbnails")) {
        thumbnail = true;
        assert.ok(body instanceof FormData);
        assert.equal(body.get("is_preferred"), "true");
        assert.equal(await (body.get("source") as Blob).text(), "jpeg");
        return Response.json(fails ? { error: { message: "denied" } } : { success: true }, { status: fails ? 400 : 200 });
      }
      if (init?.method !== "POST") return Response.json({ status: { video_status: "ready" } });
      if (body instanceof FormData) return Response.json({ start_offset: String(file.length), end_offset: String(file.length) });
      const phase = (body as URLSearchParams)?.get?.("upload_phase");
      if (phase === "finish") return Response.json({ success: true });
      if (u.includes("rupload")) return Response.json({ success: true });
      return Response.json({ video_id: "vid", upload_url: "https://rupload.example/video", upload_session_id: "sess", start_offset: "0", end_offset: String(file.length) });
    };
    const result = await publishFacebookReel({ fetch: fetchFn, now, sleep: async () => {}, log: () => {} },
      { slug: "diaria", pageId: "page", token: "tok", enabled: true, missing: [], utmContent: null },
      "v25.0", file, "caption", null, cover);
    assert.equal(thumbnail, true);
    assert.equal(result.entry.id, "vid");
    assert.equal(result.entry.cover?.status, fails ? "failed" : "uploaded");
    const parsed = parseShortsPublishedFile(JSON.stringify({ aammdd: "261030", entries: [result.entry] }), "261030");
    assert.deepEqual(parsed.entries[0].cover, result.entry.cover);
  });
}
for (const fail of [false, true]) test(`LinkedIn thumbnail PUT ${fail ? "recusa antes do post" : "precede finalize/post"}`, async () => {
  const calls: string[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes("initializeUpload")) {
      assert.equal(JSON.parse(String(init?.body)).initializeUploadRequest.uploadThumbnail, true);
      return Response.json({ value: { video: "urn:li:video:v", thumbnailUploadUrl: "https://up.example/thumb", uploadInstructions: [{ uploadUrl: "https://up.example/video", firstByte: 0, lastByte: 2 }] } });
    }
    if (url.endsWith("/thumb")) {
      assert.equal((init?.headers as Record<string,string>)["media-type-family"], "STILLIMAGE");
      assert.deepEqual(init?.body, cover);
      return new Response(null, { status: fail ? 400 : 201 });
    }
    if (url.endsWith("/video")) return new Response(null, { headers: { etag: "part" } });
    if (url.includes("finalizeUpload")) return new Response(null);
    if (url.includes("/rest/videos/")) return Response.json({ status: "AVAILABLE" });
    return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:1" } });
  };
  const run = () => publishLinkedInProfileVideo({ fetchFn, now, sleep: async () => {}, log: () => {} },
    { accessToken: "tok", personUrn: "urn:li:person:p", expiresAt: null }, "202610", Buffer.from("vid"), "text", "title", cover);
  if (fail) {
    await assert.rejects(run, /upload da capa falhou/);
    assert.equal(calls.some(u => u.includes("/posts")), false);
  } else {
    assert.equal((await run()).entry.cover?.status, "uploaded");
    assert.ok(calls.indexOf("https://up.example/thumb") < calls.findIndex(u => u.includes("finalizeUpload")));
  }
});
test("Buffer preserva offset zero e timecode do Premiere em milissegundos", async () => {
  assert.equal(shortCoverOffset("clip.00_01_02_15.Still001.jpg"), 62500);
  assert.equal(shortCoverOffset("capa.jpg"), 0);
  const item = { destination: "x", mode: "buffer", action: "buffer", caption: "text", scheduledAt: null } as const;
  assert.equal((await prepareBufferItem(item, async () => "https://cdn/v.mp4", 0)).buffer?.thumbnailOffset, 0);
  assert.equal((await prepareBufferItem(item, async () => "https://cdn/v.mp4")).buffer?.thumbnailOffset, undefined);
  const dir = mkdtempSync(join(tmpdir(), "cover-offset-"));
  try {
    const path = join(dir, "04-youtube-short-capa.jpg");
    writeFileSync(`${path}.source.json`, JSON.stringify({ name: "clip.00_00_02_12.Still001.jpg" }));
    mkdirSync(join(dir, "_internal/video-montagem"), { recursive: true });
    writeFileSync(join(dir, "_internal/video-montagem/source.json"), JSON.stringify({ fps: 24 }));
    assert.equal(readShortCoverOffset(path), 2500);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
