/**
 * test/link-video-d1-same-time-11548.test.ts (#11548)
 *
 * Regressão: na 261029 o horizontal estava agendado para 09:00Z (06:00 BRT),
 * o mesmo horário do envio da newsletter, e `link-video-d1.ts` recusou o
 * `--save` por falta da auditoria do YouTube API Services (#10865). Decisão do
 * editor: não recusar. Agendado até o envio do D1 grava com aviso; depois do
 * envio, privado sem data e estado desconhecido continuam recusados.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NEWSLETTER_PUBLISHED_FILE,
  gateVideoLink,
  newsletterSendAt,
  readYouTubeRecordSummary,
  videoLinkEligibility,
} from "../scripts/lib/diaria/youtube-video-link-gate.ts";
import { D1_VIDEO_URL_FILE } from "../scripts/lib/diaria/d1-video-link.ts";
import { YOUTUBE_PUBLISHED_FILE } from "../scripts/lib/diaria/youtube-upload.ts";
import { YOUTUBE_API_PROJECT_AUDITED } from "../scripts/lib/diaria/youtube-video.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VIDEO_ID = "abc123XYZ_9";
const VIDEO_URL = `https://youtu.be/${VIDEO_ID}`;
const SEND = new Date("2026-10-29T09:00:00Z"); // 06:00 BRT de 261029
const D1_SLOT = new Date("2026-10-29T12:45:00Z");
const unaudited = { projectAudited: false, d1SlotAt: D1_SLOT, newsletterSendAt: SEND };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "link-video-d1-11548-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(rel: string, data: unknown) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data));
}

describe("videoLinkEligibility sem auditoria, contra o envio do D1 (#11548)", () => {
  it("publishAt 09:00Z com o D1 às 09:00Z passa, com aviso", () => {
    const v = videoLinkEligibility({ state: "scheduled", publishAt: "2026-10-29T09:00:00Z", ...unaudited });
    assert.equal(v.ok, true);
    assert.ok(v.ok && v.warning && /mesmo horário do D1/.test(v.warning));
  });
  it("publishAt antes do envio também passa", () => {
    assert.equal(videoLinkEligibility({ state: "scheduled", publishAt: "2026-10-29T08:30:00Z", ...unaudited }).ok, true);
  });
  it("publishAt 10:00Z (depois do envio) recusa", () => {
    const v = videoLinkEligibility({ state: "scheduled", publishAt: "2026-10-29T10:00:00Z", ...unaudited });
    assert.equal(v.ok, false);
    assert.match(v.reason, /DEPOIS do envio/);
  });
  it("private sem data recusa", () => {
    assert.equal(videoLinkEligibility({ state: "draft", publishAt: null, ...unaudited }).ok, false);
  });
  it("agendado sem publishAt legível recusa", () => {
    assert.equal(videoLinkEligibility({ state: "scheduled", publishAt: null, ...unaudited }).ok, false);
    assert.equal(videoLinkEligibility({ state: "scheduled", publishAt: "amanhã", ...unaudited }).ok, false);
  });
  it("estado unknown recusa", () => {
    assert.equal(videoLinkEligibility({ state: "unknown", publishAt: "2026-10-29T09:00:00Z", ...unaudited }).ok, false);
  });
  it("sem horário de envio conhecido, a recusa de antes (#10865) continua", () => {
    const v = videoLinkEligibility({ state: "scheduled", publishAt: "2026-10-29T09:00:00Z", projectAudited: false, d1SlotAt: D1_SLOT });
    assert.equal(v.ok, false);
    assert.match(v.reason, /auditoria/);
  });
  it("gateVideoLink repassa o envio e o aviso", () => {
    writeJson(YOUTUBE_PUBLISHED_FILE, {
      aammdd: "261029",
      videoId: VIDEO_ID,
      url: VIDEO_URL,
      state: "scheduled",
      rereadStatus: { privacyStatus: "private", publishAt: "2026-10-29T09:00:00.000Z" },
    });
    const g = gateVideoLink({ videoUrl: VIDEO_URL, record: readYouTubeRecordSummary(dir), d1SlotAt: D1_SLOT, projectAudited: false, newsletterSendAt: SEND });
    assert.equal(g.ok, true);
    assert.match(g.warning ?? "", /mesmo horário do D1/);
  });
});

describe("newsletterSendAt (#11548)", () => {
  it("sem registro do Stage 5: 06:00 BRT do dia da edição", () => {
    const r = newsletterSendAt(dir, "261029");
    assert.equal(r.at?.toISOString(), "2026-10-29T09:00:00.000Z");
    assert.match(r.source, /06:00 BRT/);
  });
  it("com scheduled_at do broadcast: usa ele", () => {
    writeJson(NEWSLETTER_PUBLISHED_FILE, { scheduled_at: "2026-10-29T09:30:00Z" });
    assert.equal(newsletterSendAt(dir, "261029").at?.toISOString(), "2026-10-29T09:30:00.000Z");
  });
  it("registro ilegível cai no default e diz isso", () => {
    const p = join(dir, NEWSLETTER_PUBLISHED_FILE);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{nope");
    const r = newsletterSendAt(dir, "261029");
    assert.equal(r.at?.toISOString(), "2026-10-29T09:00:00.000Z");
    assert.match(r.source, /ilegível/);
  });
});

describe("link-video-d1.ts --save com o vídeo agendado para o horário do D1 (#11548)", { skip: YOUTUBE_API_PROJECT_AUDITED }, () => {
  const script = join(ROOT, "scripts", "link-video-d1.ts");
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", script, "261029", "--edition-dir", dir, ...args], { encoding: "utf8", cwd: ROOT });
  const record = (publishAt: string) =>
    writeJson(YOUTUBE_PUBLISHED_FILE, {
      aammdd: "261029",
      videoId: VIDEO_ID,
      url: VIDEO_URL,
      state: "scheduled",
      rereadStatus: { privacyStatus: "private", publishAt },
    });

  it("09:00Z (06:00 BRT, envio do D1): grava sem --assume-public, com aviso", () => {
    record("2026-10-29T09:00:00.000Z");
    const r = cli(["--save"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\[aviso\].*mesmo horário do D1/);
    assert.equal(readFileSync(join(dir, D1_VIDEO_URL_FILE), "utf8").trim(), VIDEO_URL);
  });
  it("10:00Z: recusa e não grava", () => {
    record("2026-10-29T10:00:00.000Z");
    const r = cli(["--save"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /recusado/);
    assert.equal(existsSync(join(dir, D1_VIDEO_URL_FILE)), false);
  });
});
