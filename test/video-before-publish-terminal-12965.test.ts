/**
 * #12965 — link gravado em `_internal/05-video-url.txt` de um vídeo que o
 * YouTube marcou como failed/rejected/deleted (`terminal_upload_status` no
 * registro do upload, #12655) BLOQUEIA a Etapa 5. Antes, o gate devolvia só
 * `link-may-not-open` (aviso) e newsletter + social saíam com o link de um
 * vídeo que nunca abre.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assessVideoBeforePublish,
  BLOCKING_STATUSES,
  NON_DISPENSABLE_STATUSES,
  PUBLISH_CONSENT_FILE,
  STAGE5_DONE_FILE,
} from "../scripts/lib/diaria/video-before-publish.ts";
import { decideYouTubeStep, youtubeStepLevel } from "../scripts/stage5-youtube.ts";
import { checkExternalEffect } from "../scripts/lib/diaria/publica-effect-gate.ts";

const VIDEO_ID = "QRbXMprk9o0";
const LINK = `https://youtu.be/${VIDEO_ID}`;
const D1_SLOT = new Date("2026-11-11T15:00:00.000Z");
const NOW = new Date("2026-11-10T22:00:00.000Z");

function record(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    aammdd: "261111",
    videoId: VIDEO_ID,
    url: LINK,
    state: "published",
    rereadStatus: { uploadStatus: "rejected", privacyStatus: "public" },
    audit_blocked: false,
    ...extra,
  });
}

function withDir<T>(files: Record<string, string>, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "video-terminal-12965-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const opts = { now: NOW, d1SlotAt: D1_SLOT };

describe("#12965: vídeo marcado failed/rejected/deleted com link gravado", () => {
  for (const terminal of ["failed", "rejected", "deleted"]) {
    it(`terminal_upload_status=${terminal} → video-terminal, blocking: true, sem link para o D1`, () => {
      withDir(
        {
          "_internal/05-video-url.txt": `${LINK}\n`,
          "_internal/05-youtube-published.json": record({ terminal_upload_status: terminal }),
        },
        (dir) => {
          const r = assessVideoBeforePublish(dir, "261111", opts);
          assert.equal(r.status, "video-terminal");
          assert.equal(r.blocking, true);
          assert.equal(r.videoUrl, null, "o link não vai para o D1");
          assert.match(r.warning ?? "", new RegExp(terminal));
          assert.match(r.warning ?? "", /link-video-d1\.ts 261111 --save --video-url/);
          assert.match(r.warning ?? "", /set-d1-no-video\.ts 261111/);
        },
      );
    });
  }

  it("o status é bloqueante e não dispensável", () => {
    assert.equal(BLOCKING_STATUSES.has("video-terminal"), true);
    assert.equal(NON_DISPENSABLE_STATUSES.has("video-terminal"), true);
  });

  it("retry de canal (Etapa 5 já concluída) continua BLOQUEANDO", () => {
    withDir(
      {
        "_internal/05-video-url.txt": `${LINK}\n`,
        "_internal/05-youtube-published.json": record({ terminal_upload_status: "rejected" }),
        [STAGE5_DONE_FILE]: "{}",
      },
      (dir) => {
        const r = assessVideoBeforePublish(dir, "261111", opts);
        assert.equal(r.status, "video-terminal");
        assert.equal(r.blocking, true);
        assert.doesNotMatch(r.warning ?? "", /não bloqueia/);
      },
    );
  });

  it("--skip youtube no consent não dispensa", () => {
    withDir(
      {
        "_internal/05-video-url.txt": `${LINK}\n`,
        "_internal/05-youtube-published.json": record({ terminal_upload_status: "deleted" }),
        [PUBLISH_CONSENT_FILE]: JSON.stringify({ youtube: "skipped" }),
      },
      (dir) => assert.equal(assessVideoBeforePublish(dir, "261111", opts).blocking, true),
    );
  });

  it("link de OUTRO vídeo (regravado com link-video-d1 --video-url) sai do bloqueio", () => {
    withDir(
      {
        "_internal/05-video-url.txt": "https://youtu.be/AAAAAAAAAAA\n",
        "_internal/05-youtube-published.json": record({ terminal_upload_status: "rejected" }),
      },
      (dir) => assert.equal(assessVideoBeforePublish(dir, "261111", opts).status, "link-ready"),
    );
  });

  it("edição marcada sem vídeo vence o registro terminal", () => {
    withDir(
      {
        "_internal/05-video-url.txt": `${LINK}\n`,
        "_internal/05-youtube-published.json": record({ terminal_upload_status: "rejected" }),
        "_internal/no-video.json": JSON.stringify({ no_video: true }),
      },
      (dir) => assert.equal(assessVideoBeforePublish(dir, "261111", opts).status, "no-video-marked"),
    );
  });

  it("§5b-youtube: needs-editor, bloqueia, nível warn, sem link no D1", () => {
    withDir(
      {
        "_internal/05-video-url.txt": `${LINK}\n`,
        "_internal/05-youtube-published.json": record({ terminal_upload_status: "failed" }),
      },
      (dir) => {
        const step = decideYouTubeStep(dir, "261111");
        assert.equal(step.outcome, "needs-editor");
        assert.equal(step.blocking, true);
        assert.equal(step.d1_link, false);
        assert.equal(step.video_url, undefined);
        assert.equal(youtubeStepLevel(step), "warn");
      },
    );
  });

  it("gate de efeito da /diaria-publica recusa stage5 e stage6-schedule (cenário da issue)", () => {
    withDir(
      {
        "_internal/05-video-url.txt": `${LINK}\n`,
        "_internal/05-youtube-published.json": record({ terminal_upload_status: "rejected" }),
      },
      (dir) => {
        const videoGate = assessVideoBeforePublish(dir, "261111", opts);
        for (const phase of ["stage5", "stage6-schedule"] as const) {
          const r = checkExternalEffect({ phase, part: "sessao", store: null, currentPlanSha256: null, videoGate, host: "h" });
          assert.equal(r.ok, false, phase);
        }
      },
    );
  });
});
