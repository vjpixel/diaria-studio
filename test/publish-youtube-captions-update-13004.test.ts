/**
 * #13004: `publish-youtube.ts --captions-only --force` com faixa pt já enviada
 * chamava `captions.insert` de novo, e o vídeo ficava com DUAS faixas em
 * português. Agora o `--force` atualiza a faixa existente (`captions.update`):
 * a do registro, ou a única faixa pt do vídeo; com 2+ faixas pt sem a do
 * registro entre elas, recusa (exit 1) sem enviar nada. `fetch` falso: nenhum
 * teste toca a rede.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YOUTUBE_PUBLISHED_FILE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import {
  YOUTUBE_CAPTIONS_LIST_ENDPOINT,
  YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT,
  buildCaptionUpdateRequest,
  decideCaptionsOnlyByTracks,
  youtubeCaptionFileName,
  type CaptionTrack,
} from "../scripts/lib/diaria/youtube-captions.ts";
import { runCaptionsOnly } from "../scripts/publish-youtube.ts";

const SECRETS = {
  GOOGLE_CLIENT_ID: "client-id-xyz",
  GOOGLE_CLIENT_SECRET: "client-secret",
  YOUTUBE_REFRESH_TOKEN: "refresh",
  YOUTUBE_CHANNEL_ID: "UCSsppeUnBy6q-4a5hsl5u0w",
};
const VIDEO_ID = "QRbXMprk9o0";
const SRT = "1\n00:00:00,000 --> 00:00:02,500\nOlá, diar.ia.br\n";

const track = (id: string, over: Record<string, unknown> = {}) => ({ id, snippet: { language: "pt-BR", name: "Português (Brasil)", trackKind: "standard", isDraft: false, ...over } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call {
  method: string;
  url: string;
  body?: string;
}

function mockDeps(items: unknown[], opts: { updateStatus?: number } = {}): { deps: YouTubeUploadDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      now: () => new Date("2026-11-13T12:00:00Z"),
      fetch: async (url, init) => {
        const method = init?.method ?? "GET";
        const body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : undefined;
        calls.push({ method, url, body });
        if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "access" });
        if (url.includes("/youtube/v3/channels")) return json(200, { items: [{ id: SECRETS.YOUTUBE_CHANNEL_ID }] });
        if (url.startsWith(YOUTUBE_CAPTIONS_LIST_ENDPOINT + "?") && method === "GET") return json(200, { items });
        if (url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT) && method === "PUT") {
          const st = opts.updateStatus ?? 200;
          const id = (JSON.parse(body!.split("\r\n")[3]) as { id: string }).id;
          return st === 200 ? json(200, { id }) : json(st, { error: { message: `update falhou ${st}` } });
        }
        if (url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT) && method === "POST") return json(200, { id: "NOVA" });
        throw new Error(`rota não mockada: ${method} ${url}`);
      },
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "publish-youtube-captions-update-13004-"));
  writeFileSync(join(dir, youtubeCaptionFileName("261029")), SRT);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedRecord(captionId: string) {
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(
    join(dir, YOUTUBE_PUBLISHED_FILE),
    JSON.stringify({ aammdd: "261029", videoId: VIDEO_ID, url: `https://youtu.be/${VIDEO_ID}`, captions: { attempted: true, ok: true, captionId, language: "pt-BR", path: null, error: null, scopeMissing: false, at: "2026-11-01T00:00:00Z" } }),
  );
}
const onDisk = () => JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"));
const uploads = (calls: Call[]) => calls.filter((c) => c.url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT)).map((c) => c.method);

async function run(deps: YouTubeUploadDeps, opts: { videoId?: string } = {}) {
  const logs: string[] = [];
  const outcome = await runCaptionsOnly(deps, {
    aammdd: "261029",
    editionDir: dir,
    captionsPath: join(dir, youtubeCaptionFileName("261029")),
    env: SECRETS,
    force: true,
    videoId: opts.videoId,
    readFile: (p) => readFileSync(p),
    log: (l) => logs.push(l),
  });
  return { outcome, logs: logs.join("\n") };
}

describe("decideCaptionsOnlyByTracks com --force (#13004, puro)", () => {
  const t = (id: string, over: Partial<CaptionTrack> = {}): CaptionTrack => ({ id, language: "pt-BR", name: "", trackKind: "standard", isDraft: false, lastUpdated: null, ...over });

  it("uma faixa pt: atualiza ela", () => {
    const d = decideCaptionsOnlyByTracks([t("asr1", { trackKind: "asr" }), t("a")], true);
    assert.equal(d.send, true);
    assert.equal(d.updateId, "a");
    assert.match(d.line, /atualiza a faixa a/);
  });

  it("2+ faixas pt: a do registro é a atualizada; sem ela entre as faixas, recusa", () => {
    assert.equal(decideCaptionsOnlyByTracks([t("a"), t("b", { language: "pt" })], true, "b").updateId, "b");
    const r = decideCaptionsOnlyByTracks([t("a"), t("b")], true, "zzz");
    assert.equal(r.send, false);
    assert.equal(r.refused, true);
    assert.match(r.line, /2 faixas pt standard/);
  });

  it("sem faixa pt: insert (nenhum updateId); sem --force, nada", () => {
    assert.equal(decideCaptionsOnlyByTracks([], true).updateId, undefined);
    assert.equal(decideCaptionsOnlyByTracks([t("a")], false).send, false);
  });
});

describe("buildCaptionUpdateRequest (#13004)", () => {
  it("PUT multipart no endpoint de upload com o id da faixa e o SRT", () => {
    const req = buildCaptionUpdateRequest("tok", "CAP1", Buffer.from(SRT));
    assert.equal(req.method, "PUT");
    assert.ok(req.url.startsWith(YOUTUBE_CAPTIONS_UPLOAD_ENDPOINT + "?uploadType=multipart&part=snippet"));
    assert.deepEqual(req.resource, { id: "CAP1", snippet: { isDraft: false } });
    const body = req.body.toString("utf8");
    assert.ok(body.includes('{"id":"CAP1","snippet":{"isDraft":false}}'));
    assert.ok(body.includes("Olá, diar.ia.br"));
    assert.equal(req.headers.Authorization, "Bearer tok");
  });
});

describe("runCaptionsOnly --force (#13004)", () => {
  it("regressão: --video-id com uma faixa pt = captions.update na mesma faixa, nenhum captions.insert", async () => {
    const { deps, calls } = mockDeps([track("asr1", { trackKind: "asr" }), track("std1")]);
    const { outcome, logs } = await run(deps, { videoId: VIDEO_ID });
    assert.equal(outcome.exitCode, 0, logs);
    assert.deepEqual(uploads(calls), ["PUT"]);
    assert.equal(outcome.captions?.captionId, "std1");
    assert.match(logs, /faixa std1 atualizada/);
  });

  it("--video-id com 2 faixas pt: exit 1, nada enviado", async () => {
    const { deps, calls } = mockDeps([track("a"), track("b", { language: "pt" })]);
    const { outcome, logs } = await run(deps, { videoId: VIDEO_ID });
    assert.equal(outcome.exitCode, 1);
    assert.deepEqual(uploads(calls), []);
    assert.match(logs, /\[erro\] --force: o vídeo tem 2 faixas/);
  });

  it("com registro: atualiza a faixa registrada mesmo com outra faixa pt no vídeo; registro marca updated", async () => {
    seedRecord("REG");
    const { deps, calls } = mockDeps([track("REG"), track("studio", { language: "pt" })]);
    const { outcome, logs } = await run(deps);
    assert.equal(outcome.exitCode, 0, logs);
    assert.deepEqual(uploads(calls), ["PUT"]);
    const put = calls.find((c) => c.method === "PUT")!;
    assert.ok(put.body!.includes('"id":"REG"'));
    assert.equal(onDisk().captions.captionId, "REG");
    assert.equal(onDisk().captions.updated, true);
  });

  it("com registro e o update falhando: exit 1 e o registro segue com a faixa antiga", async () => {
    seedRecord("REG");
    const { deps } = mockDeps([track("REG")], { updateStatus: 500 });
    const { outcome } = await run(deps);
    assert.equal(outcome.exitCode, 1);
    assert.equal(onDisk().captions.captionId, "REG");
    assert.equal(onDisk().captions.ok, true);
    assert.equal(onDisk().captions.updated, undefined);
  });

  it("com registro cuja faixa sumiu do vídeo e nenhuma pt: insere uma nova", async () => {
    seedRecord("REG");
    const { deps, calls } = mockDeps([track("asr1", { trackKind: "asr" })]);
    const { outcome, logs } = await run(deps);
    assert.equal(outcome.exitCode, 0, logs);
    assert.deepEqual(uploads(calls), ["POST"]);
    assert.equal(onDisk().captions.captionId, "NOVA");
  });
});
