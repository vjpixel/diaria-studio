/**
 * #12251: `check-short-feed-cover.ts` media o `oar2.jpg`, que é o frame
 * automático em todo Short, e dizia "o feed mostra outro frame" até nos 6 de
 * 10 Shorts em que a aba Shorts mostrava a capa. Medido pelo editor na rede
 * da página do canal (04/11/2026): a aba carrega `sardefault.jpg` quando o
 * Short tem miniatura vertical própria; 404 = sem capa vertical. 200 não
 * basta (o uIwtuFBqGkg tinha `sardefault` com um frame): a comparação segue.
 * Sem rede: fetch falso, imagens sintéticas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import {
  SHORT_VERTICAL_COVER_HOWTO,
  YOUTUBE_SHORTS_COVER_PLAN,
  youtubeShortFeedThumbUrl,
  youtubeShortsVerticalCoverWarning,
} from "../scripts/lib/diaria/short-cover.ts";
import { assessFeedCover } from "../scripts/lib/diaria/short-feed-cover-check.ts";
import { fetchFeedImage } from "../scripts/check-short-feed-cover.ts";

async function capa(): Promise<Buffer> {
  const bars = Array.from({ length: 4 }, (_, i) => ({
    input: { create: { width: 700, height: 70, channels: 3 as const, background: { r: 250, g: 250, b: 250 } } },
    left: 190,
    top: 240 + i * 100,
  }));
  return sharp({ create: { width: 1080, height: 1920, channels: 3, background: { r: 90, g: 90, b: 90 } } })
    .composite(bars)
    .jpeg()
    .toBuffer();
}

describe("#12251 — o verificador olha a imagem que a aba Shorts usa", () => {
  it("URL é o sardefault.jpg, nunca o oar2.jpg", () => {
    const url = youtubeShortFeedThumbUrl("WEAmxrYpr1E");
    assert.equal(url, "https://i.ytimg.com/vi/WEAmxrYpr1E/sardefault.jpg");
    assert.doesNotMatch(url, /oar\d/);
  });

  it("cenário da issue: Short com capa vertical (sardefault = capa) → veredito capa", async () => {
    const c = await capa();
    const served = await sharp(c).resize(405, 720).jpeg({ quality: 70 }).toBuffer();
    const f = (async () => new Response(new Uint8Array(served), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    const feed = await fetchFeedImage("WEAmxrYpr1E", f);
    assert.ok(feed);
    assert.equal((await assessFeedCover(feed!, c)).verdict, "capa");
  });

  it("404 no sardefault = sem capa vertical: null, corpo cancelado, nunca comparado como imagem", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const f = (async () => new Response(body, { status: 404, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    assert.equal(await fetchFeedImage("BQkZjUGWTDQ", f), null);
    assert.equal(cancelled, true);
  });

  it("sardefault 200 com um frame (caso uIwtuFBqGkg) não passa por capa", async () => {
    const frame = await sharp({ create: { width: 720, height: 1280, channels: 3, background: { r: 200, g: 200, b: 200 } } })
      .composite([{ input: { create: { width: 400, height: 800, channels: 3, background: { r: 20, g: 20, b: 20 } } }, left: 60, top: 300 }])
      .jpeg()
      .toBuffer();
    assert.equal((await assessFeedCover(frame, await capa())).verdict, "frame-automatico");
  });
});

describe("#12251 — os avisos do verificador apontam o Studio web (Passo B3a, #12254)", () => {
  // Os avisos diziam "no app do YouTube, Editar → Miniatura" depois que o
  // #12254 passou a capa vertical para o agente no Studio web.
  it("o passo citado é o Studio web, nunca o app do YouTube", () => {
    assert.match(SHORT_VERTICAL_COVER_HOWTO, /Studio web/);
    assert.match(SHORT_VERTICAL_COVER_HOWTO, /Passo B3a/);
    const w = youtubeShortsVerticalCoverWarning("5jX3X0sgMtg", { method: "thumbnails_set", ok: true, vertical_feed: "manual" });
    assert.ok(w?.includes(SHORT_VERTICAL_COVER_HOWTO));
    for (const text of [SHORT_VERTICAL_COVER_HOWTO, YOUTUBE_SHORTS_COVER_PLAN, w!]) assert.doesNotMatch(text, /app do YouTube/);
  });

  it("os dois avisos do CLI (404 e frame) usam o mesmo passo", () => {
    const src = readFileSync(new URL("../scripts/check-short-feed-cover.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /app do YouTube/);
    assert.equal(src.match(/\$\{SHORT_VERTICAL_COVER_HOWTO\}/g)?.length, 2);
  });
});
