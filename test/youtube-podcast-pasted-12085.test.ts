/**
 * test/youtube-podcast-pasted-12085.test.ts (#12085)
 *
 * O fallback do Studio (`link-video-d1.ts --save`, `/diaria-publica-video
 * --video-url`) não punha o horizontal no podcast: só o `--upload` (#12068)
 * fazia isso, e o relato marcava "adicionar à mão". `fetch` mockado: nenhum
 * teste toca a rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { YOUTUBE_API_BASE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import { addPastedVideoToPodcast, describePastedPodcastOutcome } from "../scripts/lib/diaria/youtube-podcast-pasted.ts";
import { PODCAST_PLAYLIST_NOT_CONFIGURED, type PodcastPlaylistResult } from "../scripts/lib/diaria/youtube-podcast-playlist.ts";

const PLAYLIST = "PLzBGkwuI2T1qXSt21z_Bk6OVziHQRuTDs";
const VIDEO_ID = "14SLJsdrjqE";
const URL = `https://youtu.be/${VIDEO_ID}`;
const ENV = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UCx" };
const CFG = { publishing: { youtube: { podcast_playlist_id: PLAYLIST } } };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockDeps(opts: { present?: boolean; insertStatus?: number } = {}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const deps: YouTubeUploadDeps = {
    now: () => new Date("2026-11-04T10:00:00Z"),
    fetch: async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url: String(url), method, body: typeof init?.body === "string" ? init.body : undefined });
      if (String(url) === "https://oauth2.googleapis.com/token") return json(200, { access_token: "tok" });
      if (method === "GET" && String(url).includes("/playlistItems?")) return json(200, { items: opts.present ? [{ id: "PLI-old" }] : [] });
      if (method === "POST" && String(url) === `${YOUTUBE_API_BASE}/playlistItems?part=snippet`) {
        return opts.insertStatus && opts.insertStatus !== 200 ? new Response("boom", { status: opts.insertStatus }) : json(200, { id: "PLI-new" });
      }
      throw new Error(`fetch inesperado: ${method} ${url}`);
    },
  };
  return { deps, calls };
}

const base = (over: Partial<Parameters<typeof addPastedVideoToPodcast>[1]> = {}) => {
  const log: string[] = [];
  return { log, input: { aammdd: "261104", videoUrl: URL, config: CFG, env: ENV, log: (l: string) => log.push(l), ...over } };
};

describe("#12085 podcast no link colado", () => {
  it("cenário da issue: vídeo subido pelo Studio e colado → insert na playlist com o videoId da URL", async () => {
    const { deps, calls } = mockDeps();
    const { log, input } = base();
    const out = await addPastedVideoToPodcast(deps, input);
    assert.equal(out.kind, "attempted");
    assert.equal(out.kind === "attempted" && out.result.ok, true);
    const insert = calls.find((c) => c.method === "POST" && c.url.includes("/playlistItems"));
    assert.ok(insert, "insert chamado");
    assert.deepEqual(JSON.parse(insert!.body!).snippet, { playlistId: PLAYLIST, resourceId: { kind: "youtube#video", videoId: VIDEO_ID } });
    assert.match(log.join("\n"), /adicionado à playlist do podcast/);
  });

  it("idempotente: já na playlist → nada inserido", async () => {
    const { deps, calls } = mockDeps({ present: true });
    const out = await addPastedVideoToPodcast(deps, base().input);
    assert.equal(out.kind === "attempted" && out.result.alreadyPresent, true);
    assert.equal(calls.filter((c) => c.method === "POST" && c.url.includes("/playlistItems")).length, 0);
  });

  it("registro do upload já com podcast ok do mesmo vídeo: nenhuma chamada", async () => {
    const { deps, calls } = mockDeps();
    const out = await addPastedVideoToPodcast(deps, base({ recordPodcast: { ok: true, playlistId: PLAYLIST, videoId: VIDEO_ID } }).input);
    assert.equal(out.kind, "already-done");
    assert.equal(calls.length, 0);
  });

  it("sem ID no config: [info] e nenhuma chamada; config inválido: [aviso]", async () => {
    const { deps, calls } = mockDeps();
    const a = base({ config: { publishing: { youtube: {} } } });
    assert.equal((await addPastedVideoToPodcast(deps, a.input)).kind, "not-configured");
    assert.deepEqual(a.log, [PODCAST_PLAYLIST_NOT_CONFIGURED]);
    const b = base({ config: { publishing: { youtube: { podcast_playlist_id: "" } } } });
    assert.equal((await addPastedVideoToPodcast(deps, b.input)).kind, "config-invalid");
    const c = base({ config: null, configError: "Unexpected token" });
    assert.equal((await addPastedVideoToPodcast(deps, c.input)).kind, "config-invalid");
    assert.match(c.log[0], /ilegível/);
    assert.equal(calls.length, 0);
  });

  it("sem credencial: [aviso] para adicionar à mão, nenhuma chamada", async () => {
    const { deps, calls } = mockDeps();
    const { log, input } = base({ env: {} });
    const out = await addPastedVideoToPodcast(deps, input);
    assert.equal(out.kind, "no-credentials");
    assert.match(log[0], /à mão/);
    assert.equal(calls.length, 0);
  });

  it("falha do insert é fail-soft e o retry citado é o --save, nunca o --upload (que subiria o vídeo de novo)", async () => {
    const { deps } = mockDeps({ insertStatus: 500 });
    const { log, input } = base();
    const out = await addPastedVideoToPodcast(deps, input);
    assert.equal(out.kind === "attempted" && out.result.ok, false);
    const line = log.join("\n");
    assert.match(line, /link-video-d1\.ts 261104 --save --video-url https:\/\/youtu\.be\/14SLJsdrjqE/);
    assert.doesNotMatch(line, /--upload/);
  });

  it("describePastedPodcastOutcome: escopo e 404 com a ação certa", () => {
    const fail = (over: Partial<PodcastPlaylistResult>): PodcastPlaylistResult => ({
      playlistId: PLAYLIST,
      videoId: VIDEO_ID,
      attempted: true,
      ok: false,
      alreadyPresent: false,
      playlistItemId: null,
      error: "x",
      scopeMissing: false,
      httpStatus: null,
      at: null,
      ...over,
    });
    assert.match(describePastedPodcastOutcome(fail({ scopeMissing: true }), "261104", URL), /youtube-oauth-setup/);
    assert.match(describePastedPodcastOutcome(fail({ httpStatus: 404 }), "261104", URL), /não encontrada/);
  });
});
