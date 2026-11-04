/**
 * #12113: a playlist do podcast acumulou 14 itens "Deleted video" (vídeos
 * apagados do canal não somem da playlist) e ninguém percebeu. O passo do
 * podcast do `publish-youtube.ts --upload` agora varre a playlist depois do
 * insert e avisa os órfãos, sem apagar nada e sem mudar o exit code.
 * `fetch` mockado: nenhum teste toca a rede.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YOUTUBE_API_BASE, YOUTUBE_PUBLISHED_FILE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import {
  ORPHAN_SCAN_MAX_PAGES,
  buildPlaylistItemsScanUrl,
  describePodcastOrphans,
  ensureVideoInPodcastPlaylist,
  isOrphanPlaylistItem,
  scanPodcastPlaylistOrphans,
} from "../scripts/lib/diaria/youtube-podcast-playlist.ts";
import type { RunLogEvent } from "../scripts/lib/run-log.ts";
import { addToPodcastAfterUpload, type YouTubePublishedRecord } from "../scripts/publish-youtube.ts";

const PLAYLIST = "PLpodcastDiaria01";
const VIDEO_ID = "abc123XYZ_9";
const ACCESS = "access-token";
const NOW = new Date("2026-11-04T23:00:00Z");
const CREDS = { clientId: "c", clientSecret: "s", refreshToken: "r", channelId: "UCx" };
const ENV = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UCx" };

/** Formato real de um item "Deleted video" medido via Data API em 04/11/2026. */
const deleted = (id: string, videoId: string) => ({
  id,
  contentDetails: { videoId },
  status: { privacyStatus: "privacyStatusUnspecified" },
});
const live = (id: string, videoId: string, privacyStatus = "public") => ({
  id,
  contentDetails: { videoId, videoPublishedAt: "2026-10-21T09:00:00Z" },
  status: { privacyStatus },
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call {
  url: string;
  method: string;
}
const isScan = (c: Call) => c.method === "GET" && c.url.includes("part=contentDetails,status");

function mockDeps(opts: { pages?: unknown[]; scanStatus?: number; lookupStatus?: number }): { deps: YouTubeUploadDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      now: () => NOW,
      fetch: async (url, init) => {
        const c = { url, method: init?.method ?? "GET" };
        calls.push(c);
        if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: ACCESS });
        if (isScan(c)) {
          if (opts.scanStatus) return json(opts.scanStatus, { error: "boom" });
          const m = /pageToken=p(\d+)/.exec(url);
          const idx = m ? Number(m[1]) : 0;
          return json(200, opts.pages?.[idx] ?? { items: [] });
        }
        if (c.method === "GET" && url.includes("/playlistItems?part=id")) {
          return opts.lookupStatus ? json(opts.lookupStatus, { error: "x" }) : json(200, { items: [] });
        }
        if (c.method === "POST" && url === `${YOUTUBE_API_BASE}/playlistItems?part=snippet`) return json(200, { id: "PLI-new" });
        throw new Error(`rota não mockada: ${c.method} ${url}`);
      },
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "youtube-podcast-12113-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function recordFixture(): YouTubePublishedRecord {
  return {
    aammdd: "261105",
    episode: 9,
    title: "t",
    video_path: "v.mp4",
    thumbnail_path: null,
    audit_blocked: true,
    videoId: VIDEO_ID,
    url: `https://youtu.be/${VIDEO_ID}`,
    channelId: "UCx",
    requested: { privacyStatus: "private", publishAt: "2026-11-05T09:00:00.000Z" },
    thumbnail: { attempted: false, ok: false, error: null },
    state: "scheduled",
    rereadStatus: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: "2026-11-05T09:00:00.000Z" },
    rereadError: null,
    uploadedAt: NOW.toISOString(),
    rereadAt: NOW.toISOString(),
  };
}

describe("isOrphanPlaylistItem (#12113)", () => {
  it("Deleted video (privacyStatusUnspecified, sem videoPublishedAt) é órfão", () => {
    assert.equal(isOrphanPlaylistItem(deleted("PLI-1", "G1ehwpXMbFU")), true);
  });

  it("vídeo do dia, private agendado e ainda sem videoPublishedAt, NÃO é órfão", () => {
    assert.equal(isOrphanPlaylistItem({ id: "x", contentDetails: { videoId: VIDEO_ID }, status: { privacyStatus: "private" } }), false);
  });

  it("vídeo público com videoPublishedAt não é órfão", () => {
    assert.equal(isOrphanPlaylistItem(live("x", "v")), false);
  });

  it("sem status: cai na ausência de videoPublishedAt; sem contentDetails não é julgado", () => {
    assert.equal(isOrphanPlaylistItem({ id: "x", contentDetails: { videoId: "v" } }), true);
    assert.equal(isOrphanPlaylistItem({ id: "x" }), false);
    assert.equal(isOrphanPlaylistItem(null), false);
  });
});

describe("scanPodcastPlaylistOrphans (#12113)", () => {
  it("cenário real: 8 vivos + 14 Deleted video → 14 órfãos com os videoIds", async () => {
    const ids = ["G1ehwpXMbFU", "dih6H_Y9c0k", "CZpEDkys8Jk", "fdOoXn8opI4", "otwOeXwRAxs", "m8J-Is19A6Y", "ZuJ8D4XXkD8",
      "h7Hm2zm3Xug", "f4DlNMXpNKc", "dZllhO1Qj4g", "BTfLZIa6ckI", "dpou2HwLaUw", "44caqjinMxM", "py8OU5iTS7g"];
    const items = [...Array.from({ length: 8 }, (_, i) => live(`PLI-v${i}`, `v${i}`)), ...ids.map((v, i) => deleted(`PLI-d${i}`, v))];
    const { deps } = mockDeps({ pages: [{ items }] });
    const r = await scanPodcastPlaylistOrphans(deps, ACCESS, PLAYLIST);
    assert.equal(r.ok, true);
    assert.equal(r.scanned, 22);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.orphans.map((o) => o.videoId), ids);
    const line = describePodcastOrphans(r, PLAYLIST);
    assert.ok(line && /^\[aviso\]/.test(line), String(line));
    assert.match(line!, /14 item\(ns\) órfão/);
    assert.match(line!, /G1ehwpXMbFU/);
    assert.match(line!, /RSS/);
  });

  it("pagina pelo nextPageToken", async () => {
    const { deps, calls } = mockDeps({
      pages: [{ items: [live("a", "va")], nextPageToken: "p1" }, { items: [deleted("b", "vb")] }],
    });
    const r = await scanPodcastPlaylistOrphans(deps, ACCESS, PLAYLIST);
    assert.equal(calls.filter(isScan).length, 2);
    assert.equal(r.scanned, 2);
    assert.deepEqual(r.orphans, [{ playlistItemId: "b", videoId: "vb" }]);
  });

  it("teto de páginas: truncated, sem loop infinito", async () => {
    const pages = Array.from({ length: ORPHAN_SCAN_MAX_PAGES + 5 }, (_, i) => ({ items: [live(`i${i}`, `v${i}`)], nextPageToken: `p${i + 1}` }));
    const { deps, calls } = mockDeps({ pages });
    const r = await scanPodcastPlaylistOrphans(deps, ACCESS, PLAYLIST);
    assert.equal(calls.filter(isScan).length, ORPHAN_SCAN_MAX_PAGES);
    assert.equal(r.truncated, true);
    assert.match(describePodcastOrphans(r, PLAYLIST) ?? "", /pode haver mais/);
  });

  it("falha da API vira ok:false, sem lançar, linha [info]", async () => {
    const { deps } = mockDeps({ scanStatus: 500 });
    const r = await scanPodcastPlaylistOrphans(deps, ACCESS, PLAYLIST);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /500/);
    assert.match(describePodcastOrphans(r, PLAYLIST) ?? "", /^\[info\]/);
  });

  it("playlist limpa: nenhuma linha", () => {
    assert.equal(describePodcastOrphans({ ok: true, orphans: [], scanned: 8, truncated: false, error: null }, PLAYLIST), null);
    assert.equal(describePodcastOrphans(undefined, PLAYLIST), null);
  });

  it("URL de varredura: contentDetails+status, encoding e pageToken", () => {
    const u = buildPlaylistItemsScanUrl("PL a", "tok/1");
    assert.match(u, /part=contentDetails,status/);
    assert.match(u, /playlistId=PL%20a/);
    assert.match(u, /pageToken=tok%2F1/);
    assert.ok(!buildPlaylistItemsScanUrl("PL").includes("pageToken"));
  });
});

describe("ensureVideoInPodcastPlaylist varre depois do insert (#12113)", () => {
  it("insert ok + varredura anexada ao resultado", async () => {
    const { deps, calls } = mockDeps({ pages: [{ items: [deleted("PLI-d", "dead1")] }] });
    const r = await ensureVideoInPodcastPlaylist(deps, { creds: CREDS, playlistId: PLAYLIST, videoId: VIDEO_ID });
    assert.equal(r.ok, true);
    assert.deepEqual(r.orphanScan?.orphans, [{ playlistItemId: "PLI-d", videoId: "dead1" }]);
    const ins = calls.findIndex((c) => c.method === "POST");
    assert.ok(ins >= 0 && ins < calls.findIndex(isScan), "varre só depois do insert");
    assert.ok(!calls.some((c) => c.method === "DELETE"), "nada apagado");
  });

  it("playlist 404: não varre", async () => {
    const { deps, calls } = mockDeps({ lookupStatus: 404 });
    const r = await ensureVideoInPodcastPlaylist(deps, { creds: CREDS, playlistId: PLAYLIST, videoId: VIDEO_ID });
    assert.equal(r.ok, false);
    assert.equal(r.orphanScan, undefined);
    assert.equal(calls.filter(isScan).length, 0);
  });
});

describe("addToPodcastAfterUpload avisa órfãos (#12113)", () => {
  it("órfãos: [aviso] no log + evento warn no run-log, exit code intacto", async () => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), JSON.stringify(recordFixture()));
    const { deps } = mockDeps({ pages: [{ items: [live("PLI-v", VIDEO_ID, "private"), deleted("PLI-d", "dead1")] }] });
    const logs: string[] = [];
    const events: RunLogEvent[] = [];
    const out = await addToPodcastAfterUpload(
      deps,
      { editionDir: dir, env: ENV, log: (l) => logs.push(l), podcastPlaylistId: PLAYLIST, logRunEvent: (e) => events.push(e) },
      { exitCode: 0, record: recordFixture(), skipped: false },
    );
    assert.equal(out.exitCode, 0);
    assert.ok(logs.some((l) => /^\[aviso\]/.test(l) && l.includes("dead1")), logs.join("\n"));
    assert.equal(events.length, 1);
    assert.equal(events[0].level, "warn");
    assert.match(events[0].message, /órfão/);
    const disk = JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"));
    assert.equal(disk.podcast.orphanScan.orphans.length, 1);
  });

  it("playlist limpa: nenhum aviso de órfão nem evento", async () => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), JSON.stringify(recordFixture()));
    const { deps } = mockDeps({ pages: [{ items: [live("PLI-v", "v1")] }] });
    const logs: string[] = [];
    const events: RunLogEvent[] = [];
    await addToPodcastAfterUpload(
      deps,
      { editionDir: dir, env: ENV, log: (l) => logs.push(l), podcastPlaylistId: PLAYLIST, logRunEvent: (e) => events.push(e) },
      { exitCode: 0, record: recordFixture(), skipped: false },
    );
    assert.ok(!logs.some((l) => l.includes("órfão")), logs.join("\n"));
    assert.equal(events.length, 0);
  });
});
