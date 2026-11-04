import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runThumbnailOnly } from "../scripts/publish-youtube.ts";
import { YOUTUBE_PUBLISHED_FILE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";

const env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", YOUTUBE_REFRESH_TOKEN: "refresh", YOUTUBE_CHANNEL_ID: "channel" };
for (const scenario of ["success", "api-error", "wrong-channel", "missing-record", "pending", "wrong-edition", "missing-file", "missing-creds"]) {
  test(`thumbnail-only: ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "thumbnail-only-"));
    try {
      mkdirSync(join(dir, "_internal"));
      const path = join(dir, YOUTUBE_PUBLISHED_FILE);
      const original = { aammdd: scenario === "wrong-edition" ? "261103" : "261104", videoId: "video", title: "Título", captions: { ok: true }, previous_uploads: [{ videoId: "old" }], thumbnail: { attempted: true, ok: false, error: "old" }, ...(scenario === "pending" ? { status: "in_progress" } : {}) };
      if (scenario !== "missing-record") writeFileSync(path, JSON.stringify(original));
      const calls: string[] = [];
      const deps: YouTubeUploadDeps = {
        now: () => new Date("2026-11-04T05:00:00Z"),
        fetch: async (url, init) => {
          calls.push(url);
          if (url.includes("oauth2")) return Response.json({ access_token: "access" });
          if (url.includes("/channels")) return Response.json({ items: [{ id: scenario === "wrong-channel" ? "other" : "channel" }] });
          assert.match(url, /thumbnails\/set\?videoId=video$/);
          assert.equal(init?.method, "POST");
          assert.deepEqual(Buffer.from(init?.body as Uint8Array), Buffer.from("jpeg"));
          return Response.json({}, { status: scenario === "api-error" ? 403 : 200 });
        },
      };
      const outcome = await runThumbnailOnly(deps, {
        aammdd: "261104", editionDir: dir, thumbnailPath: "/custom.jpg", env: scenario === "missing-creds" ? {} : env,
        readFile: () => { if (scenario === "missing-file") throw new Error("ENOENT"); return Buffer.from("jpeg"); }, log: () => {},
      });
      assert.equal(outcome.exitCode, scenario === "success" ? 0 : 1);
      if (scenario === "success") {
        assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...original, thumbnail_path: "/custom.jpg", thumbnail: { attempted: true, ok: true, error: null, replacedAt: "2026-11-04T05:00:00.000Z" } });
        assert.equal(calls.length, 3);
      } else if (scenario !== "missing-record") {
        assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);
      }
      if (["missing-record", "pending", "wrong-edition", "missing-file", "missing-creds"].includes(scenario)) assert.equal(calls.length, 0);
      if (scenario === "wrong-channel") assert.equal(calls.length, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
test("CLI: thumbnail-only bypasses reviewed/video and confirmation; rejects conflicting modes and missing path", () => {
  const dir = mkdtempSync(join(tmpdir(), "thumbnail-cli-"));
  try {
    for (const [args, code, message] of [
      [["--thumbnail-only"], 1, /precisa do vídeo registrado/],
      [["--thumbnail-only", "--upload"], 2, /exclusivos/],
      [["--thumbnail-only", "--thumbnail"], 2, /exige PATH/],
    ] as const) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/publish-youtube.ts", "261104", "--edition-dir", dir, ...args], { encoding: "utf8" });
      assert.equal(result.status, code, result.stderr);
      assert.match(result.stderr, message);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
