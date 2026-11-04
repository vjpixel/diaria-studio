/**
 * #12068: o `publish-youtube.ts --upload` põe o vídeo HORIZONTAL na playlist do
 * podcast (`playlistItems.insert`) — no upload novo, no vídeo que já estava no
 * canal e no já registrado (resume). Idempotente (`playlistItems.list` antes),
 * fail-soft (falha vira `[aviso]`, nunca muda o exit code) e no-op quando
 * `publishing.youtube.podcast_playlist_id` é `null`. `fetch` mockado: nenhum
 * teste toca a rede.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { YOUTUBE_API_BASE, YOUTUBE_PUBLISHED_FILE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import {
  PODCAST_PLAYLIST_NOT_CONFIGURED,
  addVideoToPodcastPlaylist,
  buildPlaylistItemInsertRequest,
  buildPlaylistItemsLookupUrl,
  describePodcastOutcome,
  loadPodcastPlaylistId,
  podcastConfigWarning,
  readPodcastPlaylistConfig,
  type PodcastPlaylistResult,
} from "../scripts/lib/diaria/youtube-podcast-playlist.ts";
import type { RunLogEvent } from "../scripts/lib/run-log.ts";
import {
  addToPodcastAfterUpload,
  planYouTubePublish,
  runYouTubeUpload,
  type RunUploadOutcome,
  type YouTubePublishPlan,
  type YouTubePublishedRecord,
} from "../scripts/publish-youtube.ts";

const REVIEWED_MD = `DESTAQUE 1 | SEGURANÇA
IA ladra? O cofre que o modelo abriu
https://fonte.exemplo.com/artigo

Pesquisadores mostraram que um agente conseguiu abrir o cofre sem senha.

Por que isso importa:
Porque sim.
`;

const SECRETS = {
  GOOGLE_CLIENT_ID: "client-id-xyz",
  GOOGLE_CLIENT_SECRET: "client-secret-SHOULD-NOT-LEAK",
  YOUTUBE_REFRESH_TOKEN: "refresh-SHOULD-NOT-LEAK",
  YOUTUBE_CHANNEL_ID: "UCSsppeUnBy6q-4a5hsl5u0w",
};
const ACCESS = "access-SHOULD-NOT-LEAK";
const VIDEO_ID = "abc123XYZ_9";
const PLAYLIST = "PLpodcastDiaria01";
const SESSION_URL = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=sess-1";
const NOW = new Date("2026-10-21T23:00:00Z");
const PUBLISH_AT = "2026-10-22T09:00:00.000Z";
const SCOPE_403 = JSON.stringify({
  error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] },
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}
type Route = (c: Call) => Response | undefined;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const isPodcastList = (c: Call) => c.method === "GET" && c.url.includes("/playlistItems?") && c.url.includes(`playlistId=${PLAYLIST}`);
const isPodcastInsert = (c: Call) => c.method === "POST" && c.url === `${YOUTUBE_API_BASE}/playlistItems?part=snippet`;

function podcastRoutes(opts: { present?: boolean; insert?: () => Response; list?: () => Response } = {}): Route[] {
  return [
    (c) => (c.url === "https://oauth2.googleapis.com/token" ? json(200, { access_token: ACCESS }) : undefined),
    (c) => (isPodcastList(c) ? (opts.list ? opts.list() : json(200, { items: opts.present ? [{ id: "PLI-existing" }] : [] })) : undefined),
    (c) => (isPodcastInsert(c) ? (opts.insert ? opts.insert() : json(200, { id: "PLI-new" })) : undefined),
  ];
}

/** Rotas do upload completo (como no teste de legenda, #11384), sem capa nem legenda. */
function uploadRoutes(): Route[] {
  return [
    (c) => (c.url.includes("/youtube/v3/channels") ? json(200, { items: [{ id: SECRETS.YOUTUBE_CHANNEL_ID }] }) : undefined),
    // Varredura da playlist de uploads (UU…): vazia, o vídeo é novo.
    (c) => (c.url.includes("/youtube/v3/playlistItems") && c.url.includes("playlistId=UU") ? json(200, { items: [] }) : undefined),
    (c) =>
      c.url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable")
        ? new Response(null, { status: 200, headers: { Location: SESSION_URL } })
        : undefined,
    (c) =>
      c.url === SESSION_URL && c.method === "PUT"
        ? json(200, { id: VIDEO_ID, snippet: { channelId: SECRETS.YOUTUBE_CHANNEL_ID }, status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: PUBLISH_AT } })
        : undefined,
    (c) =>
      c.url.includes("/youtube/v3/videos?part=status")
        ? json(200, { items: [{ id: VIDEO_ID, status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: PUBLISH_AT } }] })
        : undefined,
  ];
}

function mockDeps(rs: Route[]): { deps: YouTubeUploadDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      now: () => NOW,
      fetch: async (url, init) => {
        const call: Call = { url, method: init?.method ?? "GET", body: init?.body };
        calls.push(call);
        for (const r of rs) {
          const res = r(call);
          if (res) return res;
        }
        throw new Error(`rota não mockada: ${call.method} ${url}`);
      },
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "youtube-podcast-12068-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function buildPlan(): YouTubePublishPlan {
  const videoPath = join(dir, "diaria-comentada-261022.mp4");
  writeFileSync(videoPath, Buffer.from("fake-mp4-bytes"));
  return planYouTubePublish({
    aammdd: "261022",
    reviewedMd: REVIEWED_MD,
    now: NOW,
    episode: 2,
    editionUrl: "https://diar.ia.br/p/ia-ladra",
    video: { path: videoPath, exists: true, sizeBytes: 14 },
    thumb: { path: join(dir, "04-youtube-thumb.jpg"), exists: false },
  });
}

function recordFixture(extra: Partial<YouTubePublishedRecord> = {}): YouTubePublishedRecord {
  return {
    aammdd: "261022",
    episode: 2,
    title: "t",
    video_path: "v.mp4",
    thumbnail_path: null,
    audit_blocked: true,
    videoId: VIDEO_ID,
    url: `https://youtu.be/${VIDEO_ID}`,
    channelId: SECRETS.YOUTUBE_CHANNEL_ID,
    requested: { privacyStatus: "private", publishAt: PUBLISH_AT },
    thumbnail: { attempted: false, ok: false, error: null },
    state: "scheduled",
    rereadStatus: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: PUBLISH_AT },
    rereadError: null,
    uploadedAt: NOW.toISOString(),
    rereadAt: NOW.toISOString(),
    ...extra,
  };
}

const okOutcome = (record: YouTubePublishedRecord): RunUploadOutcome => ({ exitCode: 0, record, skipped: false });
const onDisk = () => JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"));
const AVISO = /^\[aviso\]/;

function podcastFixture(extra: Partial<PodcastPlaylistResult> = {}): PodcastPlaylistResult {
  return {
    playlistId: PLAYLIST,
    videoId: VIDEO_ID,
    attempted: true,
    ok: true,
    alreadyPresent: false,
    playlistItemId: "PLI-1",
    error: null,
    scopeMissing: false,
    httpStatus: null,
    at: NOW.toISOString(),
    ...extra,
  };
}

/** Grava o registro no disco (como o core faz antes do passo do podcast). */
function writeRecord(rec: YouTubePublishedRecord): void {
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), JSON.stringify(rec));
}

describe("builders e config (#12068)", () => {
  it("playlistItems.insert: part=snippet, playlistId e resourceId.videoId", () => {
    const req = buildPlaylistItemInsertRequest(ACCESS, PLAYLIST, VIDEO_ID);
    assert.equal(req.url, `${YOUTUBE_API_BASE}/playlistItems?part=snippet`);
    assert.equal(req.method, "POST");
    assert.equal(req.headers.Authorization, `Bearer ${ACCESS}`);
    assert.deepEqual(req.body, { snippet: { playlistId: PLAYLIST, resourceId: { kind: "youtube#video", videoId: VIDEO_ID } } });
  });

  it("lookup filtra pela playlist E pelo vídeo, com encoding", () => {
    const url = buildPlaylistItemsLookupUrl("PL a&b", "v/1");
    assert.ok(url.startsWith(`${YOUTUBE_API_BASE}/playlistItems?`));
    assert.match(url, /playlistId=PL%20a%26b/);
    assert.match(url, /videoId=v%2F1/);
  });

  it("loadPodcastPlaylistId: só string não-vazia vira ID", () => {
    assert.equal(loadPodcastPlaylistId({ publishing: { youtube: { podcast_playlist_id: " PLx " } } }), "PLx");
    assert.equal(loadPodcastPlaylistId({ publishing: { youtube: { podcast_playlist_id: null } } }), null);
    assert.equal(loadPodcastPlaylistId({ publishing: { youtube: { podcast_playlist_id: "  " } } }), null);
    assert.equal(loadPodcastPlaylistId({ publishing: { youtube: { podcast_playlist_id: 123 } } }), null);
    assert.equal(loadPodcastPlaylistId({ publishing: { youtube: {} } }), null);
    assert.equal(loadPodcastPlaylistId(null), null);
  });

  it("readPodcastPlaylistConfig separa ausente/null de presente-mas-inválido", () => {
    assert.deepEqual(readPodcastPlaylistConfig({ publishing: { youtube: {} } }), { kind: "absent" });
    assert.deepEqual(readPodcastPlaylistConfig({ publishing: { youtube: { podcast_playlist_id: null } } }), { kind: "absent" });
    assert.deepEqual(readPodcastPlaylistConfig({ publishing: { youtube: { podcast_playlist_id: "PLx" } } }), { kind: "ok", id: "PLx" });
    assert.equal(readPodcastPlaylistConfig({ publishing: { youtube: { podcast_playlist_id: " " } } }).kind, "invalid");
    assert.equal(readPodcastPlaylistConfig({ publishing: { youtube: { podcast_playlist_id: 123 } } }).kind, "invalid");
  });

  it("platform.config.json declara a chave do podcast (#12067)", () => {
    const cfg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "platform.config.json"), "utf8"));
    assert.ok("podcast_playlist_id" in cfg.publishing.youtube, "chave publishing.youtube.podcast_playlist_id ausente");
    const v = cfg.publishing.youtube.podcast_playlist_id;
    assert.ok(v === null || typeof v === "string");
  });
});

describe("addVideoToPodcastPlaylist (#12068)", () => {
  it("ausente na playlist: lista e insere uma vez", async () => {
    const { deps, calls } = mockDeps(podcastRoutes());
    const r = await addVideoToPodcastPlaylist(deps, ACCESS, PLAYLIST, VIDEO_ID);
    assert.equal(r.ok, true);
    assert.equal(r.alreadyPresent, false);
    assert.equal(r.playlistItemId, "PLI-new");
    const ins = calls.filter(isPodcastInsert);
    assert.equal(ins.length, 1);
    assert.deepEqual(JSON.parse(String(ins[0].body)), { snippet: { playlistId: PLAYLIST, resourceId: { kind: "youtube#video", videoId: VIDEO_ID } } });
    assert.ok(calls.findIndex(isPodcastList) < calls.findIndex(isPodcastInsert), "confere antes de inserir");
  });

  it("idempotente: já presente → não insere", async () => {
    const { deps, calls } = mockDeps(podcastRoutes({ present: true }));
    const r = await addVideoToPodcastPlaylist(deps, ACCESS, PLAYLIST, VIDEO_ID);
    assert.equal(r.ok, true);
    assert.equal(r.alreadyPresent, true);
    assert.equal(r.playlistItemId, "PLI-existing");
    assert.equal(calls.filter(isPodcastInsert).length, 0);
    assert.match(describePodcastOutcome(r), /já estava na playlist/);
  });

  it("403 de escopo no insert: scopeMissing, sem lançar, mensagem cita youtube.force-ssl", async () => {
    const { deps } = mockDeps(podcastRoutes({ insert: () => json(403, JSON.parse(SCOPE_403)) }));
    const r = await addVideoToPodcastPlaylist(deps, ACCESS, PLAYLIST, VIDEO_ID);
    assert.equal(r.ok, false);
    assert.equal(r.scopeMissing, true);
    assert.match(r.error ?? "", /youtube\.force-ssl/);
    assert.ok(!(r.error ?? "").includes(ACCESS), "nunca ecoa o token");
    assert.match(describePodcastOutcome(r), AVISO);
    const line = describePodcastOutcome(r, "261022");
    assert.match(line, /youtube-oauth-setup\.ts/);
    assert.match(line, /--upload --confirm-publish 261022/);
  });

  it("403 que não é de escopo: scopeMissing false", async () => {
    const { deps } = mockDeps(podcastRoutes({ insert: () => json(403, { error: { errors: [{ reason: "forbidden" }] } }) }));
    const r = await addVideoToPodcastPlaylist(deps, ACCESS, PLAYLIST, VIDEO_ID);
    assert.equal(r.ok, false);
    assert.equal(r.scopeMissing, false);
    assert.equal(r.httpStatus, 403);
  });

  it("insert 2xx sem id: ok com playlistItemId null", async () => {
    const { deps } = mockDeps(podcastRoutes({ insert: () => json(200, {}) }));
    const r = await addVideoToPodcastPlaylist(deps, ACCESS, PLAYLIST, VIDEO_ID);
    assert.equal(r.ok, true);
    assert.equal(r.playlistItemId, null);
    assert.equal(r.videoId, VIDEO_ID);
  });

  it("404 da playlist e rede caindo viram erro no resultado, sem lançar", async () => {
    const a = await addVideoToPodcastPlaylist(
      mockDeps(podcastRoutes({ list: () => json(404, { error: { errors: [{ reason: "playlistNotFound" }] } }) })).deps,
      ACCESS,
      PLAYLIST,
      VIDEO_ID,
    );
    assert.equal(a.ok, false);
    assert.equal(a.scopeMissing, false);
    assert.match(a.error ?? "", /playlistItems\.list respondeu 404/);
    assert.equal(a.httpStatus, 404);
    assert.match(describePodcastOutcome(a, "261022"), /platform\.config\.json/);

    const broken: YouTubeUploadDeps = { now: () => NOW, fetch: async () => { throw new Error("ECONNRESET"); } };
    const b = await addVideoToPodcastPlaylist(broken, ACCESS, PLAYLIST, VIDEO_ID);
    assert.equal(b.ok, false);
    assert.match(b.error ?? "", /ECONNRESET/);
    const line = describePodcastOutcome(b, "261022");
    assert.match(line, AVISO);
    assert.ok(line.includes("npx tsx scripts/publish-youtube.ts 261022 --upload --confirm-publish 261022"), line);
  });
});

describe("addToPodcastAfterUpload (#12068)", () => {
  it("sem ID configurado: 1 linha [info], nenhuma chamada", async () => {
    const { deps, calls } = mockDeps([]);
    const logs: string[] = [];
    const rec = recordFixture();
    const out = await addToPodcastAfterUpload(deps, { editionDir: dir, env: SECRETS, log: (l) => logs.push(l), podcastPlaylistId: null }, okOutcome(rec));
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, [PODCAST_PLAYLIST_NOT_CONFIGURED]);
    assert.equal(out.record?.podcast, undefined);
    assert.equal(out.exitCode, 0);
  });

  it("desfecho com exit 1 ou sem registro: não toca o podcast", async () => {
    const { deps, calls } = mockDeps(podcastRoutes());
    const logs: string[] = [];
    const input = { editionDir: dir, env: SECRETS, log: (l: string) => logs.push(l), podcastPlaylistId: PLAYLIST };
    await addToPodcastAfterUpload(deps, input, { exitCode: 1, record: recordFixture(), skipped: false });
    await addToPodcastAfterUpload(deps, input, { exitCode: 0, record: null, skipped: true });
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, ["[info] podcast não tentado: vídeo sem confirmação (#12068)"]);
  });

  it("config presente mas inválido: [aviso] de podcast pulado no lugar do [info]", async () => {
    const { deps, calls } = mockDeps([]);
    const logs: string[] = [];
    const warning = podcastConfigWarning("podcast_playlist_id vazio");
    await addToPodcastAfterUpload(
      deps,
      { editionDir: dir, env: SECRETS, log: (l) => logs.push(l), podcastPlaylistId: null, podcastConfigWarning: warning },
      okOutcome(recordFixture()),
    );
    assert.equal(calls.length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], AVISO);
    assert.match(logs[0], /pulado por causa do config/);
  });

  it("registro já com podcast.ok na mesma playlist: não gasta quota", async () => {
    const { deps, calls } = mockDeps(podcastRoutes());
    const rec = recordFixture({ podcast: podcastFixture() });
    await addToPodcastAfterUpload(deps, { editionDir: dir, env: SECRETS, log: () => {}, podcastPlaylistId: PLAYLIST }, okOutcome(rec));
    assert.equal(calls.length, 0);
  });

  it("falha do insert: [aviso], exit code intacto, falha gravada no registro e evento warn no run-log", async () => {
    writeRecord(recordFixture());
    const { deps } = mockDeps(podcastRoutes({ insert: () => json(500, { error: "boom" }) }));
    const logs: string[] = [];
    const events: RunLogEvent[] = [];
    const out = await addToPodcastAfterUpload(
      deps,
      { editionDir: dir, env: SECRETS, log: (l) => logs.push(l), podcastPlaylistId: PLAYLIST, logRunEvent: (e) => events.push(e) },
      okOutcome(recordFixture()),
    );
    assert.equal(out.exitCode, 0);
    assert.equal(out.record?.podcast?.ok, false);
    assert.ok(logs.some((l) => AVISO.test(l)), logs.join("\n"));
    assert.equal(onDisk().podcast.ok, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].level, "warn");
    assert.equal(events[0].edition, "261022");
  });

  it("run-log que lança não derruba o passo (fail-soft)", async () => {
    writeRecord(recordFixture());
    const { deps } = mockDeps(podcastRoutes({ insert: () => json(500, { error: "boom" }) }));
    const out = await addToPodcastAfterUpload(
      deps,
      {
        editionDir: dir,
        env: SECRETS,
        log: () => {},
        podcastPlaylistId: PLAYLIST,
        logRunEvent: () => {
          throw new Error("disk full");
        },
      },
      okOutcome(recordFixture()),
    );
    assert.equal(out.exitCode, 0);
    assert.equal(out.record?.podcast?.ok, false);
  });

  it("sucesso não emite evento no run-log", async () => {
    writeRecord(recordFixture());
    const events: RunLogEvent[] = [];
    await addToPodcastAfterUpload(
      mockDeps(podcastRoutes()).deps,
      { editionDir: dir, env: SECRETS, log: () => {}, podcastPlaylistId: PLAYLIST, logRunEvent: (e) => events.push(e) },
      okOutcome(recordFixture()),
    );
    assert.equal(events.length, 0);
  });

  it("registro ausente no disco: não cria o arquivo (o próximo --upload ainda grava o link do D1)", async () => {
    const logs: string[] = [];
    const out = await addToPodcastAfterUpload(
      mockDeps(podcastRoutes()).deps,
      { editionDir: dir, env: SECRETS, log: (l) => logs.push(l), podcastPlaylistId: PLAYLIST },
      okOutcome(recordFixture({ source: "already-on-channel" })),
    );
    assert.equal(out.record?.podcast?.ok, true);
    assert.equal(existsSync(join(dir, YOUTUBE_PUBLISHED_FILE)), false);
    assert.ok(logs.some((l) => AVISO.test(l) && l.includes("não gravado")), logs.join("\n"));
  });

  it("--force: avisa o item antigo do podcast a remover no Studio, sem apagar nada", async () => {
    writeRecord(recordFixture());
    const { deps, calls } = mockDeps(podcastRoutes());
    const logs: string[] = [];
    const old = recordFixture({ videoId: "oldVid", url: "https://youtu.be/oldVid", podcast: podcastFixture({ videoId: "oldVid", playlistItemId: "PLI-old" }) });
    await addToPodcastAfterUpload(
      deps,
      { editionDir: dir, env: SECRETS, log: (l) => logs.push(l), podcastPlaylistId: PLAYLIST, force: true },
      okOutcome(recordFixture({ previous_uploads: [old] })),
    );
    const warn = logs.find((l) => AVISO.test(l) && l.includes("PLI-old"));
    assert.ok(warn, logs.join("\n"));
    assert.match(warn, /youtu\.be\/oldVid/);
    assert.ok(!calls.some((c) => c.method === "DELETE"), "nada apagado");
    assert.equal(calls.filter(isPodcastInsert).length, 1, "o vídeo novo entra no podcast");
  });

  it("token recusado no refresh: [aviso], sem lançar", async () => {
    const { deps } = mockDeps([(c) => (c.url === "https://oauth2.googleapis.com/token" ? json(400, { error: "invalid_grant" }) : undefined)]);
    const logs: string[] = [];
    const out = await addToPodcastAfterUpload(
      deps,
      { editionDir: dir, env: SECRETS, log: (l) => logs.push(l), podcastPlaylistId: PLAYLIST },
      okOutcome(recordFixture()),
    );
    assert.equal(out.exitCode, 0);
    assert.equal(out.record?.podcast?.ok, false);
    assert.equal(out.record?.podcast?.videoId, VIDEO_ID);
    assert.ok(logs.some((l) => AVISO.test(l)), logs.join("\n"));
  });

  it("sem credencial: [aviso], nenhuma chamada", async () => {
    const { deps, calls } = mockDeps([]);
    const logs: string[] = [];
    await addToPodcastAfterUpload(deps, { editionDir: dir, env: {}, log: (l) => logs.push(l), podcastPlaylistId: PLAYLIST }, okOutcome(recordFixture()));
    assert.equal(calls.length, 0);
    assert.match(logs[0] ?? "", AVISO);
  });
});

describe("runYouTubeUpload põe o horizontal no podcast (#12068)", () => {
  it("upload novo: vídeo enviado e depois inserido na playlist, registro com podcast", async () => {
    const { deps, calls } = mockDeps([...podcastRoutes(), ...uploadRoutes()]);
    const logs: string[] = [];
    const outcome = await runYouTubeUpload(deps, {
      plan: buildPlan(),
      editionDir: dir,
      env: SECRETS,
      force: false,
      readFile: (p) => readFileSync(p),
      log: (l) => logs.push(l),
      podcastPlaylistId: PLAYLIST,
    });
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.equal(calls.filter(isPodcastInsert).length, 1);
    const putIdx = calls.findIndex((c) => c.url === SESSION_URL && c.method === "PUT");
    assert.ok(putIdx >= 0 && putIdx < calls.findIndex(isPodcastInsert), "insert só depois do vídeo");
    assert.equal(outcome.record?.podcast?.ok, true);
    assert.equal(onDisk().podcast.playlistItemId, "PLI-new");
    assert.equal(onDisk().videoId, VIDEO_ID);
  });

  it("resume: vídeo já registrado sem podcast → só o passo do podcast roda, nenhum upload", async () => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), JSON.stringify(recordFixture()));
    const { deps, calls } = mockDeps(podcastRoutes());
    const logs: string[] = [];
    const outcome = await runYouTubeUpload(deps, {
      plan: buildPlan(),
      editionDir: dir,
      env: SECRETS,
      force: false,
      readFile: (p) => readFileSync(p),
      log: (l) => logs.push(l),
      podcastPlaylistId: PLAYLIST,
    });
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.equal(outcome.skipped, true);
    assert.ok(!calls.some((c) => c.url.includes("/upload/youtube/v3/videos")), "nenhum byte de vídeo");
    assert.equal(calls.filter(isPodcastInsert).length, 1);
    assert.equal(onDisk().podcast.ok, true);
  });

  const runResume = async (deps: YouTubeUploadDeps, podcastPlaylistId: string) => {
    const logs: string[] = [];
    const outcome = await runYouTubeUpload(deps, {
      plan: buildPlan(),
      editionDir: dir,
      env: SECRETS,
      force: false,
      readFile: (p) => readFileSync(p),
      log: (l) => logs.push(l),
      podcastPlaylistId,
    });
    return { outcome, logs };
  };

  it("resume com podcast.ok:false gravado: tenta de novo e grava ok:true", async () => {
    writeRecord(recordFixture({ podcast: podcastFixture({ ok: false, playlistItemId: null, error: "boom", httpStatus: 500 }) }));
    const { deps, calls } = mockDeps(podcastRoutes());
    const { outcome, logs } = await runResume(deps, PLAYLIST);
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.equal(calls.filter(isPodcastInsert).length, 1);
    assert.equal(onDisk().podcast.ok, true);
    assert.equal(onDisk().podcast.playlistItemId, "PLI-new");
  });

  it("registro ok para PLold com config PLnew: insere em PLnew", async () => {
    writeRecord(recordFixture({ podcast: podcastFixture({ playlistId: "PLold" }) }));
    const { deps, calls } = mockDeps(podcastRoutes());
    const { outcome } = await runResume(deps, PLAYLIST);
    assert.equal(outcome.exitCode, 0);
    const ins = calls.filter(isPodcastInsert);
    assert.equal(ins.length, 1);
    assert.equal((JSON.parse(String(ins[0].body)) as { snippet: { playlistId: string } }).snippet.playlistId, PLAYLIST);
    assert.equal(onDisk().podcast.playlistId, PLAYLIST);
  });

  it("registro ok mas de outro videoId: tenta de novo", async () => {
    writeRecord(recordFixture({ podcast: podcastFixture({ videoId: "outroVid" }) }));
    const { deps, calls } = mockDeps(podcastRoutes());
    await runResume(deps, PLAYLIST);
    assert.equal(calls.filter(isPodcastInsert).length, 1);
    assert.equal(onDisk().podcast.videoId, VIDEO_ID);
  });

  it("already-on-channel: nada enviado, insert feito, source preservado, podcast.ok gravado", async () => {
    const MANUAL = "manualVid01";
    const manual = {
      id: MANUAL,
      snippet: { title: "Um título qualquer feito à mão", description: "sem utm", tags: [], publishedAt: "2026-10-21T20:00:00Z" },
      status: { uploadStatus: "processed", privacyStatus: "private", publishAt: PUBLISH_AT },
    };
    const routes: Route[] = [
      ...podcastRoutes(),
      (c) => (c.url.includes("/youtube/v3/channels") ? json(200, { items: [{ id: SECRETS.YOUTUBE_CHANNEL_ID }] }) : undefined),
      (c) =>
        c.url.includes("/youtube/v3/playlistItems") && c.url.includes("playlistId=UU")
          ? json(200, { items: [{ contentDetails: { videoId: MANUAL } }] })
          : undefined,
      (c) => (c.url.includes("/youtube/v3/videos?part=snippet,status") ? json(200, { items: [manual] }) : undefined),
    ];
    const { deps, calls } = mockDeps(routes);
    const logs: string[] = [];
    const outcome = await runYouTubeUpload(deps, {
      plan: buildPlan(),
      editionDir: dir,
      env: SECRETS,
      force: false,
      acceptPeriodMatch: MANUAL,
      readFile: (p) => readFileSync(p),
      log: (l) => logs.push(l),
      podcastPlaylistId: PLAYLIST,
    });
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.ok(!calls.some((c) => c.method === "PUT" || c.url.includes("uploadType=resumable")), "nenhum byte de vídeo");
    const ins = calls.filter(isPodcastInsert);
    assert.equal(ins.length, 1);
    assert.equal((JSON.parse(String(ins[0].body)) as { snippet: { resourceId: { videoId: string } } }).snippet.resourceId.videoId, MANUAL);
    const disk = onDisk();
    assert.equal(disk.source, "already-on-channel");
    assert.equal(disk.podcast.ok, true);
    assert.equal(disk.podcast.videoId, MANUAL);
    assert.equal(readFileSync(join(dir, "_internal/05-video-url.txt"), "utf8").trim(), `https://youtu.be/${MANUAL}`);
  });

  it("sem ID configurado: upload segue igual e loga a linha [info]", async () => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), JSON.stringify(recordFixture()));
    const { deps, calls } = mockDeps([]);
    const logs: string[] = [];
    const outcome = await runYouTubeUpload(deps, {
      plan: buildPlan(),
      editionDir: dir,
      env: SECRETS,
      force: false,
      readFile: (p) => readFileSync(p),
      log: (l) => logs.push(l),
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(calls.length, 0);
    assert.ok(logs.includes(PODCAST_PLAYLIST_NOT_CONFIGURED), logs.join("\n"));
  });
});
