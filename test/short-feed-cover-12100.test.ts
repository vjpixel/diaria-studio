/**
 * test/short-feed-cover-12100.test.ts (#12100)
 *
 * O `thumbnails.set` troca só a miniatura 16:9 do Short; o feed de Shorts
 * mostra `oar2.jpg`, que segue o frame automático. Antes do fix o registro
 * dizia `cover: { method: "thumbnails_set", ok: true }` e ninguém sabia que a
 * capa do feed faltava. Agora o registro grava `vertical_feed: "manual"`, o
 * plano e o resultado avisam do passo no app do YouTube, e
 * `check-short-feed-cover.ts` confere o `oar2` contra a capa local.
 * Sem rede: o fetch da CDN é falso e as imagens são sintéticas.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  YOUTUBE_SHORTS_COVER_PLAN,
  planCoverDestination,
  youtubeShortFeedThumbUrl,
  youtubeShortsCoverRecord,
  youtubeShortsVerticalCoverWarning,
} from "../scripts/lib/diaria/short-cover.ts";
import { DHASH_SIZE, FEED_COVER_MATCH_MAX_DISTANCE, assessFeedCover, dHash, hashDistance } from "../scripts/lib/diaria/short-feed-cover-check.ts";
import { YOUTUBE_VIDEO_ID_RE, fetchFeedImage } from "../scripts/check-short-feed-cover.ts";
import { publishYouTubeShort } from "../scripts/publish-shorts.ts";
import type { YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * "Capa": faixa clara com blocos (o lettering do título) no topo de um
 * vertical; "frame": o mesmo fundo sem a faixa, com a pessoa noutra posição.
 */
async function capa(): Promise<Buffer> {
  const bars = Array.from({ length: 4 }, (_, i) => ({
    input: { create: { width: 700, height: 70, channels: 3 as const, background: { r: 250, g: 250, b: 250 } } },
    left: 190,
    top: 240 + i * 100,
  }));
  return sharp({ create: { width: 1080, height: 1920, channels: 3, background: { r: 90, g: 90, b: 90 } } })
    .composite([...bars, { input: { create: { width: 500, height: 900, channels: 3, background: { r: 20, g: 20, b: 20 } } }, left: 290, top: 1000 }])
    .jpeg()
    .toBuffer();
}
async function frameAutomatico(): Promise<Buffer> {
  return sharp({ create: { width: 1080, height: 1920, channels: 3, background: { r: 200, g: 200, b: 200 } } })
    .composite([{ input: { create: { width: 700, height: 1300, channels: 3, background: { r: 20, g: 20, b: 20 } } }, left: 60, top: 500 }])
    .jpeg()
    .toBuffer();
}

describe("#12100 registro e plano da capa do Short", () => {
  it("thumbnails.set ok → ok: true + vertical_feed manual; falha e não tentado seguem como antes", () => {
    assert.deepEqual(youtubeShortsCoverRecord({ attempted: true, ok: true, error: null }), { method: "thumbnails_set", ok: true, vertical_feed: "manual" });
    assert.deepEqual(youtubeShortsCoverRecord({ attempted: true, ok: false, error: "quota" }), { method: "thumbnails_set", ok: false, error: "quota" });
    assert.equal(youtubeShortsCoverRecord({ attempted: false, ok: false }), null);
    assert.equal(youtubeShortsCoverRecord(undefined), null);
  });

  it("aviso do passo manual só para o thumbnails_set aplicado, com o oar2 e o comando de conferência", () => {
    const w = youtubeShortsVerticalCoverWarning("5jX3X0sgMtg", { method: "thumbnails_set", ok: true, vertical_feed: "manual" });
    assert.ok(w);
    assert.match(w!, /capa 16:9 aplicada/);
    assert.match(w!, /Editar → Miniatura/);
    assert.ok(w!.includes("https://i.ytimg.com/vi/5jX3X0sgMtg/oar2.jpg"));
    assert.match(w!, /check-short-feed-cover\.ts --id 5jX3X0sgMtg/);
    assert.equal(youtubeShortsVerticalCoverWarning("x", { method: "thumbnails_set", ok: false, error: "e" }), null);
    assert.equal(youtubeShortsVerticalCoverWarning("x", { method: "thumbnail_upload", ok: true }), null);
    assert.equal(youtubeShortsVerticalCoverWarning("x", null), null);
  });

  it("o plano do Short pela API não promete mais a capa no feed", () => {
    const ctx = { coverPath: "/e/04-youtube-short-capa.jpg", coverUploadReady: true, bufferOffsetMs: 0 };
    assert.equal(planCoverDestination({ destination: "youtube_shorts", mode: "api" }, ctx), YOUTUBE_SHORTS_COVER_PLAN);
    assert.match(YOUTUBE_SHORTS_COVER_PLAN, /16:9/);
    assert.match(YOUTUBE_SHORTS_COVER_PLAN, /feed de Shorts é manual/);
  });

  it("youtubeShortFeedThumbUrl aponta o oar2", () => {
    assert.equal(youtubeShortFeedThumbUrl("uIwtuFBqGkg"), "https://i.ytimg.com/vi/uIwtuFBqGkg/oar2.jpg");
  });
});

describe("#12100 publishYouTubeShort avisa do passo manual", () => {
  const ENV = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UC1" };
  const SLOT = "2026-11-03T15:00:00.000Z";
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const deps: YouTubeUploadDeps = {
    now: () => new Date("2026-11-03T10:00:00Z"),
    fetch: async (url) => {
      if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "tok" });
      if (url.includes("/youtube/v3/channels")) return json(200, { items: [{ id: "UC1" }] });
      if (url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { Location: "https://up/sess" } });
      if (url === "https://up/sess") return json(200, { id: "s1", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: SLOT } });
      if (url.includes("thumbnails/set")) return json(200, { items: [] });
      if (url.includes("/youtube/v3/videos?part=status")) return json(200, { items: [{ id: "s1", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: SLOT } }] });
      throw new Error(`rota não mockada: ${url}`);
    },
  };

  it("capa aplicada no 16:9: registro com vertical_feed manual e aviso com o oar2", async () => {
    const out = await publishYouTubeShort({
      deps,
      env: ENV,
      aammdd: "261103",
      title: "T #Shorts",
      description: "d",
      scheduledAt: SLOT,
      file: Buffer.from("mp4"),
      force: true,
      cover: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.equal(out.entry.status, "scheduled");
    assert.deepEqual(out.entry.cover, { method: "thumbnails_set", ok: true, vertical_feed: "manual" });
    const warnings = (out.warnings ?? []).join("\n");
    assert.match(warnings, /feed de Shorts não muda pela API/);
    assert.ok(warnings.includes("https://i.ytimg.com/vi/s1/oar2.jpg"));
  });
});

describe("#12100 conferência do oar2 contra a capa (dHash)", () => {
  it("dHash tem DHASH_SIZE² bits; distância 0 com a mesma imagem; tamanhos diferentes lançam", async () => {
    const h = await dHash(await capa());
    assert.equal(h.length, DHASH_SIZE * DHASH_SIZE);
    assert.equal(hashDistance(h, h), 0);
    assert.throws(() => hashDistance(h, new Uint8Array(3)), /tamanhos diferentes/);
  });

  it("a capa reencodada em outro tamanho casa; um frame qualquer não", async () => {
    const c = await capa();
    const reencoded = await sharp(c).resize(540, 960).jpeg({ quality: 55 }).toBuffer();
    const same = await assessFeedCover(reencoded, c);
    assert.equal(same.verdict, "capa", `distância ${same.distance}`);
    assert.ok(same.distance <= FEED_COVER_MATCH_MAX_DISTANCE);
    const other = await assessFeedCover(await frameAutomatico(), c);
    assert.equal(other.verdict, "frame-automatico", `distância ${other.distance}`);
  });

  it("fetchFeedImage: pede o oar2 e recusa HTTP de erro ou resposta que não é imagem", async () => {
    const urls: string[] = [];
    const ok = (async (url: string) => {
      urls.push(url);
      return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch;
    assert.deepEqual([...(await fetchFeedImage("5jX3X0sgMtg", ok))], [1, 2, 3]);
    assert.deepEqual(urls, ["https://i.ytimg.com/vi/5jX3X0sgMtg/oar2.jpg"]);
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(fetchFeedImage("5jX3X0sgMtg", notFound), /HTTP 404/);
    const html = (async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    await assert.rejects(fetchFeedImage("5jX3X0sgMtg", html), /esperado imagem/);
  });

  it("fetchFeedImage: HTTP de erro e resposta não-imagem cancelam o corpo (#9991)", async () => {
    for (const [init, re] of [
      [{ status: 404 }, /HTTP 404/],
      [{ status: 200, headers: { "content-type": "text/html" } }, /esperado imagem/],
    ] as const) {
      let cancelled = false;
      const body = new ReadableStream({ cancel() { cancelled = true; } });
      const f = (async () => new Response(body, init)) as unknown as typeof fetch;
      await assert.rejects(fetchFeedImage("5jX3X0sgMtg", f), re);
      assert.equal(cancelled, true, `corpo não cancelado em ${re}`);
    }
  });

  it("id do vídeo: 11 caracteres do alfabeto do YouTube", () => {
    assert.match("-ZMq-9gWoSc", YOUTUBE_VIDEO_ID_RE);
    assert.doesNotMatch("5jX3X0sgMt", YOUTUBE_VIDEO_ID_RE);
    assert.doesNotMatch("../etc/pass", YOUTUBE_VIDEO_ID_RE);
  });
});

describe("#12100 skill: passo manual da capa do feed de Shorts", () => {
  it("o Passo A2 manda aplicar no app e conferir com check-short-feed-cover.ts", () => {
    const skill = readFileSync(resolve(ROOT, ".claude/skills/diaria-publica-video/SKILL.md"), "utf8");
    const a2 = skill.slice(skill.indexOf("### Passo A2"), skill.indexOf("### Passo A3"));
    assert.match(a2, /Capa do feed de Shorts é passo manual \(#12100\)/);
    assert.match(a2, /oar2\.jpg/);
    assert.match(a2, /scripts\/check-short-feed-cover\.ts --id/);
    assert.match(a2, /vertical_feed: "manual"/);
  });
});

describe("#12100 CLI check-short-feed-cover (offline, --feed-image)", () => {
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/check-short-feed-cover.ts", ...args], { cwd: ROOT, encoding: "utf8" });

  it("exit 0 quando o feed mostra a capa, 1 quando mostra outro frame, 2 em uso errado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feed-cover-12100-"));
    try {
      const c = join(dir, "capa.jpg");
      const same = join(dir, "oar2-capa.jpg");
      const other = join(dir, "oar2-frame.jpg");
      writeFileSync(c, await capa());
      writeFileSync(same, await sharp(await capa()).resize(540, 960).jpeg({ quality: 60 }).toBuffer());
      writeFileSync(other, await frameAutomatico());

      const r0 = run(["--feed-image", same, "--cover", c]);
      assert.equal(r0.status, 0, r0.stderr);
      assert.equal(JSON.parse(r0.stdout).verdict, "capa");

      const r1 = run(["--feed-image", other, "--cover", c]);
      assert.equal(r1.status, 1, r1.stderr);
      assert.equal(JSON.parse(r1.stdout).verdict, "frame-automatico");
      assert.match(r1.stderr, /Editar → Miniatura/);

      assert.equal(run(["--cover", c]).status, 2);
      assert.equal(run(["--id", "curto", "--cover", c]).status, 2);
      assert.equal(run(["--feed-image", join(dir, "nao-existe.jpg"), "--cover", c]).status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
