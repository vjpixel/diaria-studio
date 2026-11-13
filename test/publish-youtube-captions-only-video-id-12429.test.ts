/**
 * #12429: `publish-youtube.ts --captions-only --video-id VIDEO_ID` envia só a
 * legenda para um vídeo do canal SEM registro na edição (261021 e 261022 estão
 * fora dos 25 uploads que o `--accept-period-match` varre, e aquele modo ainda
 * mexe em playlist). Só legenda: token → canal → `captions.list` →
 * `captions.insert`; nada de playlist, `videos.update`, thumbnail nem registro.
 * `--dry-run` não chama nada. `fetch` mockado: nenhum teste toca a rede.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YOUTUBE_PUBLISHED_FILE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import {
  YOUTUBE_CAPTIONS_LIST_ENDPOINT,
  YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT,
  decideCaptionsOnlyByTracks,
  isYouTubeVideoId,
  youtubeCaptionFileName,
  youtubeCaptionNoPlanMarkerPath,
  type CaptionTrack,
} from "../scripts/lib/diaria/youtube-captions.ts";
import { countSrtCues, resolveCaptionsOnlyTarget, runCaptionsOnly } from "../scripts/publish-youtube.ts";

const SECRETS = {
  GOOGLE_CLIENT_ID: "client-id-xyz",
  GOOGLE_CLIENT_SECRET: "client-secret-SHOULD-NOT-LEAK",
  YOUTUBE_REFRESH_TOKEN: "refresh-SHOULD-NOT-LEAK",
  YOUTUBE_CHANNEL_ID: "UCSsppeUnBy6q-4a5hsl5u0w",
};
const VIDEO_ID = "QRbXMprk9o0";
const OTHER_ID = "MMyBVHVQELI";
const CAPTION_ID = "AUieDaYcapX";
const SRT = "1\n00:00:00,000 --> 00:00:02,500\nOlá, diar.ia.br\n\n2\n00:00:02,500 --> 00:00:04,000\nTchau\n";
const RECORD_PATH = "/x/_internal/05-youtube-published.json";

interface Call {
  url: string;
  method: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const asr = { id: "asr1", snippet: { language: "pt-BR", name: "", trackKind: "asr", isDraft: false } };
const sentPt = { id: "std1", snippet: { language: "pt-BR", name: "Português (Brasil)", trackKind: "standard", isDraft: false } };

interface MockOpts {
  /** Corpo do erro do `captions.list` quando `listStatus` != 200. */
  listErrorBody?: unknown;
  /** Status do `captions.insert` (default 200). */
  insertStatus?: number;
  /** Status do `captions.update` (#13004, default 200). */
  updateStatus?: number;
  /** Canal que o token vê (default o esperado). */
  channelId?: string;
}

function mockDeps(listItems: unknown[], listStatus = 200, opts: MockOpts = {}): { deps: YouTubeUploadDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      now: () => new Date("2026-11-13T12:00:00Z"),
      fetch: async (url, init) => {
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "access" });
        if (url.includes("/youtube/v3/channels")) return json(200, { items: [{ id: opts.channelId ?? SECRETS.YOUTUBE_CHANNEL_ID }] });
        if (url.startsWith(YOUTUBE_CAPTIONS_LIST_ENDPOINT) && method === "GET") {
          return listStatus === 200 ? json(200, { items: listItems }) : json(listStatus, opts.listErrorBody ?? { error: { message: "boom" } });
        }
        if (url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT) && method === "PUT") {
          const st = opts.updateStatus ?? 200;
          const id = JSON.parse(String(Buffer.from(init?.body as Uint8Array)).split("\r\n")[3]).id as string;
          return st === 200 ? json(200, { id }) : json(st, { error: { message: `update falhou ${st}` } });
        }
        if (url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT) && method === "POST") {
          const st = opts.insertStatus ?? 200;
          return st === 200 ? json(200, { id: CAPTION_ID }) : json(st, { error: { message: `insert falhou ${st}` } });
        }
        throw new Error(`rota não mockada: ${method} ${url}`);
      },
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "publish-youtube-captions-only-12429-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const captionsPath = () => join(dir, youtubeCaptionFileName("261021"));
const recordPath = () => join(dir, YOUTUBE_PUBLISHED_FILE);

async function run(deps: YouTubeUploadDeps, opts: { videoId?: string; force?: boolean; dryRun?: boolean; reviewed?: boolean; env?: Record<string, string> } = {}) {
  const logs: string[] = [];
  const outcome = await runCaptionsOnly(deps, {
    aammdd: "261021",
    editionDir: dir,
    captionsPath: captionsPath(),
    env: opts.env ?? SECRETS,
    force: opts.force ?? false,
    captionsReviewed: opts.reviewed,
    videoId: "videoId" in opts ? opts.videoId : VIDEO_ID,
    dryRun: opts.dryRun,
    readFile: (p) => readFileSync(p),
    log: (l) => logs.push(l),
  });
  return { outcome, logs: logs.join("\n") };
}

const pathsOf = (calls: Call[]) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);

describe("resolveCaptionsOnlyTarget (#12429, puro)", () => {
  const done = { kind: "done" as const, record: { aammdd: "261021", videoId: VIDEO_ID, url: `https://youtu.be/${VIDEO_ID}` } as never };

  it("sem registro: o --video-id vira o alvo; sem ele, recusa apontando o --video-id", () => {
    assert.deepEqual(resolveCaptionsOnlyTarget({ kind: "none" }, VIDEO_ID, RECORD_PATH), { kind: "video-id", videoId: VIDEO_ID });
    const r = resolveCaptionsOnlyTarget({ kind: "none" }, undefined, RECORD_PATH);
    assert.equal(r.kind, "refuse");
    assert.match((r as { reason: string }).reason, /--video-id VIDEO_ID/);
  });

  it("com registro: o vídeo dele; --video-id igual passa, diferente é recusado", () => {
    assert.equal(resolveCaptionsOnlyTarget(done, undefined, RECORD_PATH).kind, "record");
    assert.equal(resolveCaptionsOnlyTarget(done, VIDEO_ID, RECORD_PATH).kind, "record");
    const r = resolveCaptionsOnlyTarget(done, OTHER_ID, RECORD_PATH);
    assert.equal(r.kind, "refuse");
    assert.match((r as { reason: string }).reason, /difere do vídeo registrado/);
  });

  it("registro incerto ou ilegível e ID malformado: recusa", () => {
    assert.equal(resolveCaptionsOnlyTarget({ kind: "pending", sentinel: { status: "in_progress" } as never }, VIDEO_ID, RECORD_PATH).kind, "refuse");
    assert.equal(resolveCaptionsOnlyTarget({ kind: "error", message: "ilegível" }, VIDEO_ID, RECORD_PATH).kind, "refuse");
    const bad = resolveCaptionsOnlyTarget({ kind: "none" }, "https://youtu.be/QRbXMprk9o0", RECORD_PATH);
    assert.equal(bad.kind, "refuse");
    assert.match((bad as { reason: string }).reason, /não é um ID de vídeo/);
  });

  it("isYouTubeVideoId e countSrtCues", () => {
    assert.equal(isYouTubeVideoId(VIDEO_ID), true);
    assert.equal(isYouTubeVideoId("MMyBVHVQEL"), false);
    assert.equal(isYouTubeVideoId("MMyBVHVQEL!"), false);
    assert.equal(countSrtCues(SRT), 2);
    assert.equal(countSrtCues(SRT.replace(/\n/g, "\r\n")), 2);
  });
});

describe("decideCaptionsOnlyByTracks (#12429, puro)", () => {
  const t = (over: Partial<CaptionTrack>): CaptionTrack => ({ id: "x", language: "pt-BR", name: "", trackKind: "standard", isDraft: false, lastUpdated: null, ...over });

  it("sem faixa ou só a automática: envia", () => {
    assert.equal(decideCaptionsOnlyByTracks([], false).send, true);
    assert.equal(decideCaptionsOnlyByTracks([t({ trackKind: "asr" }), t({ language: "en" })], false).send, true);
  });

  it("pt-BR standard já enviada (publicada ou rascunho): não envia sem --force", () => {
    assert.equal(decideCaptionsOnlyByTracks([t({ id: "a" })], false).send, false);
    const draft = decideCaptionsOnlyByTracks([t({ id: "b", isDraft: true })], false);
    assert.equal(draft.send, false);
    assert.match(draft.line, /b \(rascunho\)/);
    const forced = decideCaptionsOnlyByTracks([t({ id: "a" })], true);
    assert.equal(forced.send, true);
    assert.match(forced.line, /\[premissa\] --force/);
  });

  it("faixa standard `pt` (enviada pelo Studio) ou `pt-PT` conta como já enviada; só `asr` pt não", () => {
    const studio = decideCaptionsOnlyByTracks([t({ id: "s", language: "pt" })], false);
    assert.equal(studio.send, false);
    assert.match(studio.line, /já tem faixa pt enviada \(s\)/);
    assert.equal(decideCaptionsOnlyByTracks([t({ id: "p", language: "pt-PT" })], false).send, false);
    assert.equal(decideCaptionsOnlyByTracks([t({ id: "s", language: "pt" })], true).send, true);
    const none = decideCaptionsOnlyByTracks([t({ language: "pt", trackKind: "asr" }), t({ language: "en" })], false);
    assert.equal(none.send, true);
    assert.equal(none.line, "[info] o vídeo não tem faixa pt `standard` enviada: envia");
  });
});

describe("runCaptionsOnly --video-id (#12429)", () => {
  it("vídeo sem registro: token → canal → captions.list → captions.insert, sem playlist/vídeo, sem gravar registro", async () => {
    writeFileSync(captionsPath(), SRT);
    const { deps, calls } = mockDeps([asr]);
    const { outcome, logs } = await run(deps);
    assert.equal(outcome.exitCode, 0, logs);
    assert.deepEqual(pathsOf(calls), ["POST /token", "GET /youtube/v3/channels", "GET /youtube/v3/captions", "POST /upload/youtube/v3/captions"]);
    assert.ok(calls.every((c) => !/playlist|\/videos|thumbnails/.test(c.url)), "nunca toca playlist, vídeo ou capa");
    const listCall = calls.find((c) => c.url.startsWith(YOUTUBE_CAPTIONS_LIST_ENDPOINT));
    assert.match(listCall!.url, new RegExp(`videoId=${VIDEO_ID}`));
    assert.equal(outcome.captions?.captionId, CAPTION_ID);
    assert.equal(outcome.videoId, VIDEO_ID);
    assert.equal(outcome.record, null);
    assert.equal(existsSync(recordPath()), false, "o registro da edição segue inexistente");
    assert.match(logs, /--captions-list --video-id QRbXMprk9o0/);
  });

  it("faixa pt-BR já enviada: nada enviado sem --force; com --force, atualiza a mesma faixa (#13004)", async () => {
    writeFileSync(captionsPath(), SRT);
    const a = mockDeps([asr, sentPt]);
    const skipped = await run(a.deps);
    assert.equal(skipped.outcome.exitCode, 0);
    assert.equal(skipped.outcome.skipped, true);
    assert.ok(!a.calls.some((c) => c.method === "POST" && c.url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT)));
    const b = mockDeps([asr, sentPt]);
    const forced = await run(b.deps, { force: true });
    assert.equal(forced.outcome.captions?.ok, true);
    assert.equal(forced.outcome.captions?.updated, true);
    assert.equal(forced.outcome.captions?.captionId, "std1");
    assert.ok(!b.calls.some((c) => c.method === "POST" && c.url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT)), "nada de captions.insert");
  });

  it("captions.list falha: exit 1, nada enviado, o retry leva o --video-id", async () => {
    writeFileSync(captionsPath(), SRT);
    const { deps, calls } = mockDeps([], 500);
    const { outcome, logs } = await run(deps);
    assert.equal(outcome.exitCode, 1);
    assert.ok(!calls.some((c) => c.method === "POST" && c.url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT)));
    assert.match(logs, /--captions-only --video-id QRbXMprk9o0/);
  });

  it("token sem youtube.force-ssl (403 de escopo no captions.list): exit 1, sem POST, linha com --captions-only --video-id", async () => {
    writeFileSync(captionsPath(), SRT);
    const scopeBody = { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } };
    const { deps, calls } = mockDeps([], 403, { listErrorBody: scopeBody });
    const { outcome, logs } = await run(deps);
    assert.equal(outcome.captions?.scopeMissing, true, logs);
    assert.equal(outcome.exitCode, 1, "sem registro, a legenda é o único objetivo: escopo faltando não é sucesso");
    assert.ok(!calls.some((c) => c.method === "POST" && c.url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT)));
    assert.match(logs, /--captions-only --video-id QRbXMprk9o0/);
    assert.equal(existsSync(recordPath()), false);
  });

  for (const status of [400, 500]) {
    it(`captions.insert falha (HTTP ${status}): exit 1, nada gravado`, async () => {
      writeFileSync(captionsPath(), SRT);
      const { deps, calls } = mockDeps([asr], 200, { insertStatus: status });
      const { outcome, logs } = await run(deps);
      assert.equal(outcome.exitCode, 1, logs);
      assert.equal(outcome.captions?.ok, false);
      assert.ok(calls.some((c) => c.method === "POST" && c.url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT)));
      assert.match(logs, /--captions-only --video-id QRbXMprk9o0/);
      assert.equal(existsSync(recordPath()), false);
    });
  }

  it("token de outro canal: exit 1, para no GET /channels", async () => {
    writeFileSync(captionsPath(), SRT);
    const { deps, calls } = mockDeps([asr], 200, { channelId: "UCoutroCanalQualquer00000" });
    const { outcome, logs } = await run(deps);
    assert.equal(outcome.exitCode, 1, logs);
    assert.deepEqual(pathsOf(calls), ["POST /token", "GET /youtube/v3/channels"]);
    assert.match(logs, /não é do canal esperado/);
  });

  it("registro de outro vídeo: recusa sem chamar a API e sem mexer no registro", async () => {
    writeFileSync(captionsPath(), SRT);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const rec = JSON.stringify({ aammdd: "261021", videoId: OTHER_ID, url: `https://youtu.be/${OTHER_ID}` });
    writeFileSync(recordPath(), rec);
    const { deps, calls } = mockDeps([]);
    const { outcome, logs } = await run(deps);
    assert.equal(outcome.exitCode, 1);
    assert.equal(calls.length, 0);
    assert.match(logs, /difere do vídeo registrado/);
    assert.equal(readFileSync(recordPath(), "utf8"), rec);
  });

  it("SRT sem plano não revisado: recusa mesmo com --video-id; --captions-reviewed libera", async () => {
    writeFileSync(captionsPath(), SRT);
    writeFileSync(youtubeCaptionNoPlanMarkerPath(captionsPath()), "{}");
    const a = mockDeps([]);
    assert.equal((await run(a.deps)).outcome.exitCode, 1);
    assert.equal(a.calls.length, 0);
    const b = mockDeps([]);
    assert.equal((await run(b.deps, { reviewed: true })).outcome.exitCode, 0);
  });
});

describe("runCaptionsOnly --dry-run (#12429)", () => {
  it("só o plano: nenhuma chamada, nada gravado, exit 0 (mesmo sem credencial)", async () => {
    writeFileSync(captionsPath(), SRT);
    const { deps, calls } = mockDeps([]);
    const { outcome, logs } = await run(deps, { dryRun: true, env: {} });
    assert.equal(outcome.exitCode, 0, logs);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(recordPath()), false);
    assert.match(logs, /\[dry-run\] enviaria .* \(\d+ bytes, 2 blocos\) como legenda pt-BR do vídeo QRbXMprk9o0/);
    assert.match(logs, /nenhuma playlist, título ou metadado/);
    assert.match(logs, /\[aviso\] faltam/);
  });

  it("dry-run mantém as recusas: sem .srt ou sem registro nem --video-id = exit 1", async () => {
    const { deps, calls } = mockDeps([]);
    assert.equal((await run(deps, { dryRun: true })).outcome.exitCode, 1);
    writeFileSync(captionsPath(), SRT);
    assert.equal((await run(deps, { dryRun: true, videoId: undefined })).outcome.exitCode, 1);
    assert.equal(calls.length, 0);
  });
});

describe("CLI --captions-only --video-id --dry-run (#12429, spawnSync)", () => {
  it("aceita a combinação, não chama a rede e imprime o plano em JSON", () => {
    writeFileSync(captionsPath(), SRT);
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/publish-youtube.ts", "261021", "--edition-dir", dir, "--captions-only", "--video-id", VIDEO_ID, "--dry-run"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.dry_run, true);
    assert.equal(out.videoId, VIDEO_ID);
    assert.equal(out.registered, false);
    assert.equal(out.captions, null);
    assert.equal(existsSync(recordPath()), false);
  });

  it("vídeo registrado com faixa antiga falha: o JSON do dry-run sai com captions null, não a faixa antiga", () => {
    writeFileSync(captionsPath(), SRT);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const old = { attempted: true, ok: false, captionId: null, language: "pt-BR", path: captionsPath(), error: "antigo", scopeMissing: true, at: "2026-10-21T10:00:00Z" };
    writeFileSync(recordPath(), JSON.stringify({ aammdd: "261021", videoId: VIDEO_ID, url: `https://youtu.be/${VIDEO_ID}`, captions: old }));
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/publish-youtube.ts", "261021", "--edition-dir", dir, "--captions-only", "--dry-run"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.dry_run, true);
    assert.equal(out.registered, true);
    assert.equal(out.captions, null);
  });
});
