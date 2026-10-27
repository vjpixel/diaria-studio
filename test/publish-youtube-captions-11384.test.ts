/**
 * #11384: o `publish-youtube.ts --upload` passa a enviar a legenda SRT do
 * horizontal (`captions.insert`, pt-BR, sem rascunho) e registra o `captionId`
 * em `_internal/05-youtube-published.json`; `--captions-only` envia só a
 * legenda para o vídeo já registrado (pelo `videoId`). Token sem
 * `youtube.force-ssl` → `[aviso]` com o comando de setup, e o vídeo segue
 * (fail-soft). `fetch` mockado: nenhum teste toca a rede nem a API.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YOUTUBE_PUBLISHED_FILE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import {
  YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT,
  buildCaptionInsertRequest,
  isCaptionScopeError,
  youtubeCaptionFileName,
} from "../scripts/lib/diaria/youtube-captions.ts";
import { YOUTUBE_OAUTH_SCOPES, missingGrantedScopes, missingOptionalScopes } from "../scripts/lib/youtube-oauth.ts";
import { planYouTubePublish, runCaptionsOnly, runYouTubeUpload, type YouTubePublishPlan } from "../scripts/publish-youtube.ts";

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
const CAPTION_ID = "AUieDaYcap1";
const SESSION_URL = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=sess-1";
const NOW = new Date("2026-10-21T23:00:00Z");
const PUBLISH_AT = "2026-10-22T09:00:00.000Z";
const SRT = "1\n00:00:00,000 --> 00:00:02,500\nOlá, diar.ia.br\n";
const SCOPE_403 = JSON.stringify({
  error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED" },
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
type Route = (c: Call) => Response | undefined;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function routes(caption: Route): Route[] {
  return [
    (c) => (c.url === "https://oauth2.googleapis.com/token" ? json(200, { access_token: ACCESS }) : undefined),
    (c) => (c.url.includes("/youtube/v3/channels") ? json(200, { items: [{ id: SECRETS.YOUTUBE_CHANNEL_ID }] }) : undefined),
    (c) => (c.url.includes("/youtube/v3/playlistItems") ? json(200, { items: [] }) : undefined),
    (c) =>
      c.url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable")
        ? new Response(null, { status: 200, headers: { Location: SESSION_URL } })
        : undefined,
    (c) =>
      c.url === SESSION_URL && c.method === "PUT"
        ? json(200, { id: VIDEO_ID, snippet: { channelId: SECRETS.YOUTUBE_CHANNEL_ID }, status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: PUBLISH_AT } })
        : undefined,
    (c) => (c.url.includes("/thumbnails/set") ? json(200, { items: [] }) : undefined),
    (c) => (c.url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT) ? caption(c) : undefined),
    (c) =>
      c.url.includes("/youtube/v3/videos?part=status")
        ? json(200, { items: [{ id: VIDEO_ID, status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: PUBLISH_AT } }] })
        : undefined,
  ];
}
const captionOk: Route = () => json(200, { id: CAPTION_ID, snippet: { language: "pt-BR" } });
const captionNoScope: Route = () => json(403, JSON.parse(SCOPE_403));

function mockDeps(rs: Route[]): { deps: YouTubeUploadDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      now: () => NOW,
      fetch: async (url, init) => {
        const call: Call = {
          url,
          method: init?.method ?? "GET",
          headers: { ...((init?.headers ?? {}) as Record<string, string>) },
          body: init?.body,
        };
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
  dir = mkdtempSync(join(tmpdir(), "publish-youtube-captions-11384-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function buildPlan(opts: { srt?: boolean } = {}): YouTubePublishPlan {
  const videoPath = join(dir, "diaria-comentada-261022.mp4");
  writeFileSync(videoPath, Buffer.from("fake-mp4-bytes"));
  const captionsPath = join(dir, youtubeCaptionFileName("261022"));
  if (opts.srt !== false) writeFileSync(captionsPath, SRT);
  return planYouTubePublish({
    aammdd: "261022",
    reviewedMd: REVIEWED_MD,
    now: NOW,
    episode: 2,
    editionUrl: "https://diar.ia.br/p/ia-ladra",
    video: { path: videoPath, exists: true, sizeBytes: 14 },
    thumb: { path: join(dir, "04-youtube-thumb.jpg"), exists: false },
    captions: { path: captionsPath, exists: opts.srt !== false },
  });
}

async function upload(deps: YouTubeUploadDeps, plan: YouTubePublishPlan) {
  const logs: string[] = [];
  const outcome = await runYouTubeUpload(deps, {
    plan,
    editionDir: dir,
    env: SECRETS,
    force: false,
    readFile: (p) => readFileSync(p),
    log: (l) => logs.push(l),
  });
  return { outcome, logs };
}

const captionCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT));
const onDisk = () => JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"));

describe("request do captions.insert (#11384)", () => {
  it("multipart com snippet pt-BR, isDraft false, o videoId e o SRT", () => {
    const req = buildCaptionInsertRequest(ACCESS, VIDEO_ID, Buffer.from(SRT), "BOUND");
    assert.equal(req.url, `${YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT}?uploadType=multipart&part=snippet`);
    assert.equal(req.headers["Content-Type"], "multipart/related; boundary=BOUND");
    assert.equal(req.headers.Authorization, `Bearer ${ACCESS}`);
    assert.equal(req.headers["Content-Length"], String(req.body.length));
    assert.deepEqual(req.snippet, { videoId: VIDEO_ID, language: "pt-BR", name: "Português (Brasil)", isDraft: false });
    const text = req.body.toString("utf8");
    const parts = text.split("--BOUND");
    assert.equal(parts.length, 4, "abertura, json, srt, fechamento");
    assert.match(parts[1], /application\/json/);
    assert.deepEqual(JSON.parse(parts[1].split("\r\n\r\n")[1].trim()), { snippet: req.snippet });
    assert.ok(parts[2].includes(SRT), "o SRT vai intacto");
    assert.equal(parts[3], "--\r\n");
  });

  it("isCaptionScopeError reconhece o 403 de escopo e só ele", () => {
    assert.equal(isCaptionScopeError(403, SCOPE_403), true);
    assert.equal(isCaptionScopeError(403, '{"error":{"errors":[{"reason":"forbidden"}]}}'), false);
    assert.equal(isCaptionScopeError(401, SCOPE_403), false);
  });

  it("o setup pede youtube.force-ssl, mas só upload+readonly são obrigatórios", () => {
    assert.ok((YOUTUBE_OAUTH_SCOPES as readonly string[]).includes("https://www.googleapis.com/auth/youtube.force-ssl"));
    const old = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
    assert.deepEqual(missingGrantedScopes(old), [], "token antigo ainda serve para o vídeo");
    assert.deepEqual(missingOptionalScopes(old), ["https://www.googleapis.com/auth/youtube.force-ssl"]);
    assert.deepEqual(missingOptionalScopes(YOUTUBE_OAUTH_SCOPES.join(" ")), []);
  });
});

describe("--upload envia a legenda junto (#11384)", () => {
  it("com o .srt: captions.insert depois do vídeo e captionId no registro", async () => {
    const { deps, calls } = mockDeps(routes(captionOk));
    const { outcome, logs } = await upload(deps, buildPlan());
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    const cc = captionCalls(calls);
    assert.equal(cc.length, 1);
    assert.equal(cc[0].method, "POST");
    assert.match(Buffer.from(cc[0].body as Uint8Array).toString("utf8"), new RegExp(`"videoId":"${VIDEO_ID}"`));
    assert.equal(outcome.record?.captions?.captionId, CAPTION_ID);
    assert.equal(onDisk().captions.captionId, CAPTION_ID);
    assert.equal(onDisk().captions.language, "pt-BR");
    assert.ok(logs.some((l) => l.includes(`captionId ${CAPTION_ID}`)), logs.join("\n"));
  });

  it("token sem youtube.force-ssl: vídeo sobe (exit 0), [aviso] com o comando de setup, scopeMissing no registro", async () => {
    const { deps } = mockDeps(routes(captionNoScope));
    const { outcome, logs } = await upload(deps, buildPlan());
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.equal(outcome.record?.videoId, VIDEO_ID);
    assert.equal(onDisk().videoId, VIDEO_ID, "o registro do vídeo é gravado mesmo sem legenda");
    assert.equal(onDisk().captions.ok, false);
    assert.equal(onDisk().captions.scopeMissing, true);
    assert.equal(onDisk().captions.captionId, null);
    const aviso = logs.find((l) => l.startsWith("[aviso] legenda NÃO enviada"));
    assert.ok(aviso, logs.join("\n"));
    assert.match(aviso!, /youtube-oauth-setup\.ts/);
    assert.match(aviso!, /--captions-only/);
    assert.ok(!logs.join("\n").includes(ACCESS));
  });

  it("erro 500 na legenda também não derruba o vídeo", async () => {
    const { deps } = mockDeps(routes(() => json(500, { error: "boom" })));
    const { outcome } = await upload(deps, buildPlan());
    assert.equal(outcome.exitCode, 0);
    assert.equal(onDisk().captions.ok, false);
    assert.equal(onDisk().captions.scopeMissing, false);
  });

  it("sem o .srt: nenhum captions.insert e [premissa] no plano", async () => {
    const plan = buildPlan({ srt: false });
    assert.equal(plan.captions, null);
    assert.ok(plan.premises.some((p) => /sem legenda/.test(p)));
    const { deps, calls } = mockDeps(routes(captionOk));
    const { outcome } = await upload(deps, plan);
    assert.equal(outcome.exitCode, 0);
    assert.equal(captionCalls(calls).length, 0);
    assert.equal(onDisk().captions, undefined);
  });
});

describe("--captions-only (#11384)", () => {
  function seedRecord(extra: Record<string, unknown> = {}) {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(
      join(dir, YOUTUBE_PUBLISHED_FILE),
      JSON.stringify({ aammdd: "261022", videoId: VIDEO_ID, url: `https://youtu.be/${VIDEO_ID}`, ...extra }),
    );
  }
  async function captionsOnly(deps: YouTubeUploadDeps, opts: { force?: boolean; srt?: boolean } = {}) {
    const captionsPath = join(dir, youtubeCaptionFileName("261022"));
    if (opts.srt !== false) writeFileSync(captionsPath, SRT);
    const logs: string[] = [];
    const outcome = await runCaptionsOnly(deps, {
      aammdd: "261022",
      editionDir: dir,
      captionsPath,
      env: SECRETS,
      force: opts.force ?? false,
      readFile: (p) => readFileSync(p),
      log: (l) => logs.push(l),
    });
    return { outcome, logs };
  }

  it("envia só a legenda pelo videoId do registro: token → canal → captions.insert, sem tocar no vídeo", async () => {
    seedRecord();
    const { deps, calls } = mockDeps(routes(captionOk));
    const { outcome, logs } = await captionsOnly(deps);
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.deepEqual(
      calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
      ["POST /token", "GET /youtube/v3/channels", "POST /upload/youtube/v3/captions"],
    );
    assert.equal(onDisk().captions.captionId, CAPTION_ID);
    assert.equal(onDisk().videoId, VIDEO_ID, "preserva o registro do vídeo");
  });

  it("legenda já registrada: não envia de novo sem --force", async () => {
    seedRecord({ captions: { ok: true, captionId: "old" } });
    const { deps, calls } = mockDeps(routes(captionOk));
    const { outcome } = await captionsOnly(deps);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.skipped, true);
    assert.equal(calls.length, 0);
    const forced = await captionsOnly(mockDeps(routes(captionOk)).deps, { force: true });
    assert.equal(forced.outcome.record?.captions?.captionId, CAPTION_ID);
  });

  it("token sem o escopo: exit 0 (fail-soft) com o comando de setup", async () => {
    seedRecord();
    const { deps } = mockDeps(routes(captionNoScope));
    const { outcome, logs } = await captionsOnly(deps);
    assert.equal(outcome.exitCode, 0);
    assert.ok(logs.some((l) => /\[aviso\].*youtube-oauth-setup\.ts/.test(l)), logs.join("\n"));
    assert.equal(onDisk().captions.scopeMissing, true);
  });

  it("sem registro do vídeo ou sem .srt: exit 1, nada chamado", async () => {
    const a = mockDeps(routes(captionOk));
    assert.equal((await captionsOnly(a.deps)).outcome.exitCode, 1);
    assert.equal(a.calls.length, 0);
    seedRecord();
    rmSync(join(dir, youtubeCaptionFileName("261022")));
    const b = mockDeps(routes(captionOk));
    assert.equal((await captionsOnly(b.deps, { srt: false })).outcome.exitCode, 1);
    assert.equal(b.calls.length, 0);
  });
});
