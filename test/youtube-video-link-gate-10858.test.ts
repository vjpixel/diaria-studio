/**
 * test/youtube-video-link-gate-10858.test.ts (#10858)
 *
 * Regressão: upload grava o link mesmo privado (#10960), com aviso.
 *   - A elegibilidade pública continua disponível para diagnóstico;
 *   - `link-video-d1.ts` lê `_internal/05-youtube-published.json` e recusa o
 *     vídeo privado (exit 1, nada gravado), salvo `--assume-public`.
 * Nenhum teste toca rede: o upload usa `fetch` mockado.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  d1SocialSlotAt,
  gateVideoLink,
  readYouTubeRecordSummary,
  videoLinkEligibility,
} from "../scripts/lib/diaria/youtube-video-link-gate.ts";
import { readD1VideoUrl } from "../scripts/lib/diaria/d1-video-link-file.ts";
import { D1_VIDEO_URL_FILE } from "../scripts/lib/diaria/d1-video-link.ts";
import { YOUTUBE_PUBLISHED_FILE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import { YOUTUBE_API_PROJECT_AUDITED } from "../scripts/lib/diaria/youtube-video.ts";
import { planYouTubePublish, runYouTubeUpload, writeD1VideoUrlAfterUpload } from "../scripts/publish-youtube.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VIDEO_ID = "abc123XYZ_9";
const VIDEO_URL = `https://youtu.be/${VIDEO_ID}`;
// 06:00 BRT de 261022 (o agendamento do plano) e o post do D1 às 09:45 BRT.
const PUBLISH_AT = "2026-10-22T09:00:00.000Z";
const D1_SLOT = new Date("2026-10-22T12:45:00Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "youtube-video-link-gate-10858-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeRecord(rec: Record<string, unknown>) {
  const p = join(dir, YOUTUBE_PUBLISHED_FILE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(rec));
}

const urlFile = () => join(dir, D1_VIDEO_URL_FILE);

describe("videoLinkEligibility (#10858)", () => {
  it("público passa", () => {
    assert.equal(videoLinkEligibility({ state: "published", publishAt: null, d1SlotAt: null }).ok, true);
  });
  it("privado sem agendamento (draft) NÃO passa", () => {
    const v = videoLinkEligibility({ state: "draft", publishAt: null, d1SlotAt: D1_SLOT });
    assert.equal(v.ok, false);
    assert.match(v.reason, /privado/);
  });
  it("estado não confirmado NÃO passa", () => {
    assert.equal(videoLinkEligibility({ state: "unknown", publishAt: null, d1SlotAt: D1_SLOT }).ok, false);
    assert.equal(videoLinkEligibility({ state: null, publishAt: null, d1SlotAt: D1_SLOT }).ok, false);
  });
  it("projeto auditado: agendado antes do post do D1 passa; depois, ou sem horário do D1, não", () => {
    const audited = { projectAudited: true };
    assert.equal(videoLinkEligibility({ state: "scheduled", publishAt: PUBLISH_AT, d1SlotAt: D1_SLOT, ...audited }).ok, true);
    assert.equal(
      videoLinkEligibility({ state: "scheduled", publishAt: "2026-10-22T15:00:00Z", d1SlotAt: D1_SLOT, ...audited }).ok,
      false,
    );
    assert.equal(videoLinkEligibility({ state: "scheduled", publishAt: PUBLISH_AT, d1SlotAt: null, ...audited }).ok, false);
    assert.equal(videoLinkEligibility({ state: "scheduled", publishAt: null, d1SlotAt: D1_SLOT, ...audited }).ok, false);
  });
});

describe("videoLinkEligibility sem auditoria do projeto GCP (#10865)", () => {
  it("agendado antes do D1 NÃO passa com projeto não auditado", () => {
    const v = videoLinkEligibility({ state: "scheduled", publishAt: PUBLISH_AT, d1SlotAt: D1_SLOT, projectAudited: false });
    assert.equal(v.ok, false);
    assert.match(v.reason, /auditoria/);
  });
  it("default segue YOUTUBE_API_PROJECT_AUDITED", () => {
    const v = videoLinkEligibility({ state: "scheduled", publishAt: PUBLISH_AT, d1SlotAt: D1_SLOT });
    assert.equal(v.ok, YOUTUBE_API_PROJECT_AUDITED);
  });
  it("público continua passando sem auditoria", () => {
    assert.equal(videoLinkEligibility({ state: "published", publishAt: null, d1SlotAt: null, projectAudited: false }).ok, true);
  });
  it("gateVideoLink repassa a auditoria", () => {
    writeRecord({
      aammdd: "261022",
      videoId: VIDEO_ID,
      url: VIDEO_URL,
      state: "scheduled",
      rereadStatus: { privacyStatus: "private", publishAt: PUBLISH_AT },
    });
    const record = readYouTubeRecordSummary(dir);
    assert.equal(gateVideoLink({ videoUrl: VIDEO_URL, record, d1SlotAt: D1_SLOT, projectAudited: false }).ok, false);
    assert.equal(gateVideoLink({ videoUrl: VIDEO_URL, record, d1SlotAt: D1_SLOT, projectAudited: true }).ok, true);
  });
});

describe("d1SocialSlotAt (#10858)", () => {
  it("horário fixo do D1 em BRT, com day_offset", () => {
    const social = { fallback_schedule: { d1_time: "09:45", d2_time: "12:15", d3_time: "17:15", day_offset: 0 } };
    assert.equal(d1SocialSlotAt("261022", social)?.toISOString(), "2026-10-22T12:45:00.000Z");
    const offset = { fallback_schedule: { ...social.fallback_schedule, day_offset: 1 } };
    assert.equal(d1SocialSlotAt("261022", offset)?.toISOString(), "2026-10-23T12:45:00.000Z");
  });
  it("sem horário do D1 ou edição inválida → null", () => {
    assert.equal(d1SocialSlotAt("261022", {}), null);
    assert.equal(d1SocialSlotAt("xx", { fallback_schedule: { d1_time: "09:45" } }), null);
  });
  it("o config real produz um horário (rotação #10305 incluída)", () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    assert.ok(d1SocialSlotAt("261022", cfg.publishing.social) instanceof Date);
  });
});

describe("gateVideoLink (#10858)", () => {
  it("registro deste vídeo privado → recusa", () => {
    writeRecord({ aammdd: "261022", videoId: VIDEO_ID, url: VIDEO_URL, state: "draft", rereadStatus: { privacyStatus: "private" } });
    const g = gateVideoLink({ videoUrl: VIDEO_URL, record: readYouTubeRecordSummary(dir), d1SlotAt: D1_SLOT });
    assert.equal(g.ok, false);
    assert.equal(g.record_matched, true);
  });
  it("sem registro, ou registro de outro vídeo → libera sem conferência", () => {
    assert.equal(gateVideoLink({ videoUrl: VIDEO_URL, record: null, d1SlotAt: D1_SLOT }).ok, true);
    writeRecord({ videoId: "zzzzzzzzzzz", url: "https://youtu.be/zzzzzzzzzzz", state: "draft" });
    const g = gateVideoLink({ videoUrl: VIDEO_URL, record: readYouTubeRecordSummary(dir), d1SlotAt: D1_SLOT });
    assert.equal(g.ok, true);
    assert.equal(g.record_matched, false);
  });
  it("registro corrompido lança (nunca vira 'sem registro')", () => {
    const p = join(dir, YOUTUBE_PUBLISHED_FILE);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{nope");
    assert.throws(() => readYouTubeRecordSummary(dir), /ilegível/);
  });
});

describe("writeD1VideoUrlAfterUpload (#10858)", () => {
  const base = { aammdd: "261022", url: VIDEO_URL };
  it("vídeo private grava o link com aviso (#10960)", () => {
    const logs: string[] = [];
    const ok = writeD1VideoUrlAfterUpload(dir, { ...base, state: "draft", rereadStatus: { privacyStatus: "private" } }, D1_SLOT, (l) => logs.push(l));
    assert.equal(ok, true);
    assert.equal(readFileSync(urlFile(), "utf8").trim(), VIDEO_URL);
    assert.match(logs.join("\n"), /aviso.*mesmo assim.*10960/s);
  });
  it("público grava; agendado antes do D1 grava", () => {
    assert.equal(writeD1VideoUrlAfterUpload(dir, { ...base, state: "published", rereadStatus: { privacyStatus: "public" } }, null, () => {}), true);
    assert.equal(readFileSync(urlFile(), "utf8").trim(), VIDEO_URL);
    rmSync(urlFile());
    const sched = { ...base, state: "scheduled" as const, rereadStatus: { privacyStatus: "private", publishAt: PUBLISH_AT } };
    assert.equal(writeD1VideoUrlAfterUpload(dir, sched, D1_SLOT, () => {}, true), true);
  });
  it("agendado sem auditoria grava com aviso (#10960)", () => {
    const logs: string[] = [];
    const sched = { ...base, state: "scheduled" as const, rereadStatus: { privacyStatus: "private", publishAt: PUBLISH_AT } };
    assert.equal(writeD1VideoUrlAfterUpload(dir, sched, D1_SLOT, (l) => logs.push(l), false), true);
    assert.equal(readFileSync(urlFile(), "utf8").trim(), VIDEO_URL);
    assert.match(logs.join("\n"), /aviso.*auditoria/s);
  });
  it("não sobrescreve outra URL já gravada", () => {
    mkdirSync(dirname(urlFile()), { recursive: true });
    writeFileSync(urlFile(), "https://youtu.be/zzzzzzzzzzz\n");
    assert.equal(writeD1VideoUrlAfterUpload(dir, { ...base, state: "published", rereadStatus: null }, null, () => {}), false);
    assert.equal(readFileSync(urlFile(), "utf8").trim(), "https://youtu.be/zzzzzzzzzzz");
  });
});

// ── runYouTubeUpload ponta a ponta, fetch mockado ─────────────────────────

const SECRETS = {
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "csecret",
  YOUTUBE_REFRESH_TOKEN: "rtoken",
  YOUTUBE_CHANNEL_ID: "UCSsppeUnBy6q-4a5hsl5u0w",
};
const SESSION_URL = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=sess-1";
const REVIEWED_MD = `DESTAQUE 1 | SEGURANÇA
IA ladra? O cofre que o modelo abriu
https://fonte.exemplo.com/artigo

Pesquisadores mostraram que um agente conseguiu abrir o cofre sem senha.

Por que isso importa:
Porque sim.
`;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function deps(rereadStatus: Record<string, unknown>): YouTubeUploadDeps {
  return {
    now: () => new Date("2026-10-21T23:00:00Z"),
    fetch: async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "at" });
      if (url.includes("/youtube/v3/channels")) return json(200, { items: [{ id: SECRETS.YOUTUBE_CHANNEL_ID }] });
      if (url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { Location: SESSION_URL } });
      if (url === SESSION_URL && init?.method === "PUT") return json(200, { id: VIDEO_ID, status: rereadStatus });
      if (url.includes("/thumbnails/set")) return json(200, {});
      if (url.includes("/videos?part=status")) return json(200, { items: [{ id: VIDEO_ID, status: rereadStatus }] });
      throw new Error(`rota não mockada: ${url}`);
    },
  };
}

async function upload(rereadStatus: Record<string, unknown>, projectAudited?: boolean) {
  const videoPath = join(dir, "diaria-comentada-261022.mp4");
  writeFileSync(videoPath, Buffer.from("fake-mp4"));
  const plan = planYouTubePublish({
    aammdd: "261022",
    reviewedMd: REVIEWED_MD,
    now: new Date("2026-10-21T23:00:00Z"),
    episode: 2,
    editionUrl: "https://diar.ia.br/p/ia-ladra",
    video: { path: videoPath, exists: true, sizeBytes: 8 },
    thumb: { path: join(dir, "04-youtube-thumb.jpg"), exists: false },
    projectAudited,
  });
  const logs: string[] = [];
  const outcome = await runYouTubeUpload(deps(rereadStatus), {
    plan,
    editionDir: dir,
    env: SECRETS,
    force: false,
    readFile: (p) => readFileSync(p),
    log: (l) => logs.push(l),
    d1SlotAt: D1_SLOT,
  });
  return { outcome, logs };
}

describe("publish-youtube --upload → 05-video-url.txt (#10858)", () => {
  it("upload privado sem auditoria alimenta o link do D1 (#10960)", async () => {
    const { outcome, logs } = await upload({ uploadStatus: "uploaded", privacyStatus: "private" });
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.equal(outcome.record?.state, "draft");
    assert.deepEqual(readD1VideoUrl(dir), { url: VIDEO_URL, warning: null });
    assert.equal(outcome.videoUrlWritten, true);
    assert.equal(readFileSync(urlFile(), "utf8").trim(), VIDEO_URL);
    assert.match(logs.join("\n"), /aviso.*10960/s);
  });
  it("projeto auditado: upload agendado para 06:00 BRT (antes do D1) grava o link", async () => {
    const { outcome, logs } = await upload({ uploadStatus: "uploaded", privacyStatus: "private", publishAt: PUBLISH_AT }, true);
    assert.equal(outcome.record?.state, "scheduled", logs.join("\n"));
    assert.equal(outcome.videoUrlWritten, true);
    assert.equal(readFileSync(urlFile(), "utf8").trim(), VIDEO_URL);
  });
  it("projeto NÃO auditado: upload agendado grava o link (#10960)", async () => {
    const { outcome, logs } = await upload({ uploadStatus: "uploaded", privacyStatus: "private", publishAt: PUBLISH_AT }, false);
    assert.equal(outcome.exitCode, 0, logs.join("\n"));
    assert.equal(outcome.record?.state, "scheduled");
    assert.equal(outcome.videoUrlWritten, true);
    assert.equal(readFileSync(urlFile(), "utf8").trim(), VIDEO_URL);
    assert.match(logs.join("\n"), /aviso.*10960/s);
  });
});

// ── CLI link-video-d1 ──────────────────────────────────────────────────────

describe("link-video-d1.ts lê o registro do upload (#10858)", () => {
  const script = join(ROOT, "scripts", "link-video-d1.ts");
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", script, "261022", "--edition-dir", dir, ...args], { encoding: "utf8", cwd: ROOT });

  it("vídeo private no registro: recusa (exit 1) e não grava nada", () => {
    writeRecord({ aammdd: "261022", videoId: VIDEO_ID, url: VIDEO_URL, state: "draft", rereadStatus: { privacyStatus: "private" } });
    const r = cli(["--video-url", `https://www.youtube.com/watch?v=${VIDEO_ID}`, "--save"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /recusado/);
    assert.equal(existsSync(urlFile()), false);
  });
  it("sem --video-url usa a url do registro; --assume-public libera o privado", () => {
    writeRecord({ aammdd: "261022", videoId: VIDEO_ID, url: VIDEO_URL, state: "draft", rereadStatus: { privacyStatus: "private" } });
    assert.equal(cli(["--save"]).status, 1);
    const r = cli(["--save", "--assume-public"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(urlFile(), "utf8").trim(), VIDEO_URL);
  });
  it("vídeo agendado antes do D1 no registro: recusa enquanto o projeto não é auditado (#10865)", { skip: YOUTUBE_API_PROJECT_AUDITED }, () => {
    writeRecord({
      aammdd: "261022",
      videoId: VIDEO_ID,
      url: VIDEO_URL,
      state: "scheduled",
      rereadStatus: { privacyStatus: "private", publishAt: PUBLISH_AT },
    });
    const r = cli(["--save"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /auditoria/);
    assert.equal(existsSync(urlFile()), false);
    assert.equal(cli(["--save", "--assume-public"]).status, 0);
  });
  it("vídeo público no registro: grava sem flag extra", () => {
    writeRecord({ aammdd: "261022", videoId: VIDEO_ID, url: VIDEO_URL, state: "published", rereadStatus: { privacyStatus: "public" } });
    const r = cli(["--save"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).video_link_gate.ok, true);
  });
});
