/**
 * #12121: o `[aviso]` de itens órfãos do podcast precisa trazer o que a ação
 * (`playlistItems.delete`) consome, que é o ID do ITEM da playlist, não o do
 * vídeo. Antes a linha listava só o videoId e mandava "remover no Studio".
 * Também cobre o caminho do link colado (#12085), que varria a playlist sem
 * nunca logar o resultado. Só avisa: nenhum DELETE é chamado. `fetch` mockado,
 * nenhum teste toca a rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { YOUTUBE_API_BASE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import { describePodcastOrphans, scanPodcastPlaylistOrphans } from "../scripts/lib/diaria/youtube-podcast-playlist.ts";
import { addPastedVideoToPodcast } from "../scripts/lib/diaria/youtube-podcast-pasted.ts";

const PLAYLIST = "PLpodcastDiaria01";
const VIDEO_ID = "14SLJsdrjqE";
const ENV = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UCx" };
const CFG = { publishing: { youtube: { podcast_playlist_id: PLAYLIST } } };

/** Formato real de um item "Deleted video" (04/11/2026): sem `videoPublishedAt`. */
const deleted = (id: string, videoId: string) => ({ id, contentDetails: { videoId }, status: { privacyStatus: "privacyStatusUnspecified" } });
const live = (id: string, videoId: string) => ({
  id,
  contentDetails: { videoId, videoPublishedAt: "2026-10-21T09:00:00Z" },
  status: { privacyStatus: "public" },
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockDeps(scanItems: unknown[]) {
  const calls: Array<{ url: string; method: string }> = [];
  const deps: YouTubeUploadDeps = {
    now: () => new Date("2026-11-04T23:00:00Z"),
    fetch: async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url: String(url), method });
      if (String(url) === "https://oauth2.googleapis.com/token") return json(200, { access_token: "tok" });
      if (method === "GET" && String(url).includes("part=contentDetails,status")) return json(200, { items: scanItems });
      if (method === "GET" && String(url).includes("/playlistItems?part=id")) return json(200, { items: [] });
      if (method === "POST" && String(url) === `${YOUTUBE_API_BASE}/playlistItems?part=snippet`) return json(200, { id: "PLI-new" });
      throw new Error(`rota não mockada: ${method} ${url}`);
    },
  };
  return { deps, calls };
}

describe("#12121 aviso de órfãos do podcast", () => {
  it("lista o ID do item da playlist (o que o playlistItems.delete recebe) e nomeia a ação", async () => {
    const { deps, calls } = mockDeps([live("PLI-live", "vivo1"), deleted("PLI-dead1", "G1ehwpXMbFU"), deleted("PLI-dead2", "dih6H_Y9c0k")]);
    const scan = await scanPodcastPlaylistOrphans(deps, "tok", PLAYLIST);
    const line = describePodcastOrphans(scan, PLAYLIST) ?? "";
    assert.match(line, /^\[aviso\]/);
    assert.match(line, /PLI-dead1 \(vídeo G1ehwpXMbFU\)/);
    assert.match(line, /PLI-dead2 \(vídeo dih6H_Y9c0k\)/);
    assert.match(line, /playlistItems\.delete/);
    assert.doesNotMatch(line, /PLI-live/);
    assert.match(line, /nada foi apagado/);
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 0, "só avisa: nenhum DELETE");
  });

  it("item órfão sem videoId sai só com o ID do item", () => {
    const line = describePodcastOrphans(
      { ok: true, orphans: [{ playlistItemId: "PLI-x", videoId: null }], scanned: 1, truncated: false, error: null },
      PLAYLIST,
    );
    assert.match(line ?? "", /: PLI-x\. /);
  });

  it("caminho do link colado (#12085) também emite o aviso, sem DELETE", async () => {
    const { deps, calls } = mockDeps([deleted("PLI-dead1", "G1ehwpXMbFU")]);
    const log: string[] = [];
    const out = await addPastedVideoToPodcast(deps, {
      aammdd: "261104",
      videoUrl: `https://youtu.be/${VIDEO_ID}`,
      config: CFG,
      env: ENV,
      log: (l) => log.push(l),
    });
    assert.equal(out.kind, "attempted");
    const aviso = log.find((l) => /órfão/.test(l));
    assert.ok(aviso, `aviso de órfão ausente no log: ${JSON.stringify(log)}`);
    assert.match(aviso!, /PLI-dead1 \(vídeo G1ehwpXMbFU\)/);
    assert.match(aviso!, /playlistItems\.delete/);
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  });

  it("caminho do link colado com playlist limpa: nenhuma linha de órfão", async () => {
    const { deps } = mockDeps([live("PLI-live", "vivo1")]);
    const log: string[] = [];
    await addPastedVideoToPodcast(deps, { aammdd: "261104", videoUrl: `https://youtu.be/${VIDEO_ID}`, config: CFG, env: ENV, log: (l) => log.push(l) });
    assert.equal(log.filter((l) => /órfão/.test(l)).length, 0);
  });
});
