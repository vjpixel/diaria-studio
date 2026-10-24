/**
 * test/publish-shorts-confirm-media-type-10966.test.ts
 *
 * #10966: `--confirm-instagram --media-id` aceitava qualquer mídia recente da
 * autora. Com o id errado, uma foto ou um carrossel virava o registro
 * `instagram: published` da edição (#573). Agora a escolha explícita também
 * precisa ser `media_product_type === "REELS"`; o contrário recusa e lista só
 * os Reels como candidatos. Fetch mockado; nenhuma chamada real à Graph API.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideInstagramConfirm, fetchInstagramRecentMedia, instagramEditionMarkers } from "../scripts/publish-shorts.ts";
import type { ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";

const empty: ShortsPublishedFile = { aammdd: "261023", entries: [] };
const since = "2026-10-23T03:00:00.000Z";
const now = "2026-10-23T16:00:00.000Z";
const markers = instagramEditionMarkers({ aammdd: "261023", d1Title: "Título do D1" });

/** O que a Graph devolve em `/{ig-user}/media` (#10915), com foto, carrossel e Reels misturados. */
const media = {
  data: [
    { id: "foto", media_product_type: "FEED", media_type: "IMAGE", timestamp: "2026-10-23T15:30:00+0000", permalink: "https://www.instagram.com/p/foto/", caption: "Título do D1" },
    { id: "carrossel", media_product_type: "FEED", media_type: "CAROUSEL_ALBUM", timestamp: "2026-10-23T15:10:00+0000", caption: "x" },
    { id: "story", media_product_type: "STORY", media_type: "VIDEO", timestamp: "2026-10-23T15:05:00+0000" },
    { id: "semtipo", timestamp: "2026-10-23T14:55:00+0000" },
    { id: "reel", media_product_type: "REELS", media_type: "VIDEO", timestamp: "2026-10-23T15:00:00+0000", permalink: "https://www.instagram.com/reel/r/", caption: "Título do D1" },
    { id: "reel-velho", media_product_type: "REELS", media_type: "VIDEO", timestamp: "2026-10-21T15:00:00+0000", caption: "outro" },
  ],
};

function mockFetch(json: unknown) {
  const urls: string[] = [];
  return {
    deps: {
      fetch: async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(json), { status: 200 });
      },
    },
    urls,
  };
}

describe("#10966 --media-id só registra Reels", () => {
  for (const [id, type] of [
    ["foto", "FEED, media_type: IMAGE"],
    ["carrossel", "FEED, media_type: CAROUSEL_ALBUM"],
    ["story", "STORY, media_type: VIDEO"],
    ["semtipo", "sem media_product_type"],
  ] as const) {
    it(`${id}: recusa, diz o tipo e lista só os Reels`, async () => {
      const f = mockFetch(media);
      const fetched = await fetchInstagramRecentMedia(f.deps, "1784", "tok", "v25.0");
      const d = decideInstagramConfirm({ published: empty, media: fetched, sinceIso: since, markers, mediaId: id, nowIso: now });
      assert.equal(d.kind, "refuse");
      const r = d as { reason: string; candidates: Array<{ id: string }> };
      assert.match(r.reason, new RegExp(`--media-id ${id} não é um Reels`));
      assert.ok(r.reason.includes(`media_product_type: ${type}`), r.reason);
      assert.deepEqual(r.candidates.map((c) => c.id), ["reel", "reel-velho"]);
      // Só leitura, e a leitura pede o tipo da mídia.
      assert.equal(f.urls.length, 1);
      assert.match(decodeURIComponent(f.urls[0]), /fields=[^&]*media_product_type/);
      assert.match(decodeURIComponent(f.urls[0]), /fields=[^&]*media_type/);
    });
  }

  it("Reels escolhido explicitamente continua registrando (inclusive fora da janela e sem marcador)", async () => {
    const f = mockFetch(media);
    const fetched = await fetchInstagramRecentMedia(f.deps, "1784", "tok", "v25.0");
    const d = decideInstagramConfirm({ published: empty, media: fetched, sinceIso: since, markers, mediaId: "reel-velho", nowIso: now });
    assert.equal(d.kind, "register");
    assert.deepEqual((d as { entry: unknown }).entry, { destination: "instagram", status: "published", id: "reel-velho", scheduled_at: null, at: "2026-10-21T15:00:00.000Z" });
    const ok = decideInstagramConfirm({ published: empty, media: fetched, sinceIso: since, markers, mediaId: "reel", nowIso: now });
    assert.equal((ok as { entry: { url?: string } }).entry.url, "https://www.instagram.com/reel/r/");
  });

  it("id fora da lista segue recusando como antes", () => {
    const d = decideInstagramConfirm({ published: empty, media, sinceIso: since, markers, mediaId: "nao-existe", nowIso: now });
    assert.equal(d.kind, "refuse");
    assert.match((d as { reason: string }).reason, /não está entre/);
  });
});
