/**
 * #13712 — export fora do Drive: `fetch-drive-video.ts --drive-root` lê o disco e
 * `gen-youtube-thumb.ts --frames-from-file` extrai frames do bruto local.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeLocalDriveDeps } from "../scripts/lib/diaria/local-drive-deps.ts";
import { parseFetchDriveVideoArgs, runFetchDriveVideo } from "../scripts/fetch-drive-video.ts";
import { planFileFrameArgs } from "../scripts/lib/diaria/youtube-thumb-frames.ts";

const CLI = fileURLToPath(new URL("../scripts/gen-youtube-thumb.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))).href;
const roots: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "local-drive-13712-"));
  roots.push(d);
  return d;
};
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("fetch-drive-video --drive-root (#13712)", () => {
  it("parse: --drive-root dispensa pasta do Drive e usa o id local", () => {
    const r = parseFetchDriveVideoArgs(["--edition", "261119", "--orientation", "horizontal", "--drive-root", "C:/x"], { folderId: null, windowHours: null });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.driveRoot, "C:/x");
      assert.equal(r.folderId, "local:");
    }
  });

  it("acha o horizontal em {raiz}/{AAMMDD}/Final/ do disco (antes: action none)", async () => {
    const root = tmp();
    const ed = tmp();
    mkdirSync(join(root, "261119", "Final"), { recursive: true });
    writeFileSync(join(root, "261119", "Final", "Diaria comentada_Horizontal_V1.mp4"), "x".repeat(10));
    const deps = makeLocalDriveDeps(root, () => ({ width: 3840, height: 2160, durationMillis: "60000" }));
    const out = await runFetchDriveVideo(deps, {
      aammdd: "261119", orientation: "horizontal", folderId: "local:", editionDir: ed,
      now: new Date(), windowHours: 48, dryRun: true, force: false,
    }, () => {});
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.action, "dry-run");
  });

  it("download copia o arquivo local para a pasta da edição", async () => {
    const root = tmp();
    const ed = tmp();
    mkdirSync(join(root, "261119", "Final"), { recursive: true });
    writeFileSync(join(root, "261119", "Final", "Diaria comentada_Horizontal_V1.mp4"), "video-bytes");
    const deps = makeLocalDriveDeps(root, () => ({ width: 3840, height: 2160 }));
    const out = await runFetchDriveVideo(deps, {
      aammdd: "261119", orientation: "horizontal", folderId: "local:", editionDir: ed,
      now: new Date(), windowHours: 48, dryRun: false, force: false,
    }, () => {});
    assert.equal(out.output.action, "downloaded");
    assert.equal(readFileSync(join(ed, "diaria-comentada-261119.mp4"), "utf8"), "video-bytes");
  });

  it("id fora da raiz é recusado", async () => {
    const deps = makeLocalDriveDeps(tmp());
    const res = await deps.driveFetch("https://x/files/" + encodeURIComponent("local:../etc"));
    assert.equal(res.status, 400);
  });
});

describe("gen-youtube-thumb --frames-from-file (#13712)", () => {
  it("planFileFrameArgs: sem token, hflip só espelhado", () => {
    const a = planFileFrameArgs({ path: "/v.mp4", atSeconds: 3, out: "/o.png", mirrored: false });
    assert.ok(!a.includes("-vf"));
    assert.ok(!a.join(" ").includes("Authorization"));
    const m = planFileFrameArgs({ path: "/v.mp4", atSeconds: 3, out: "/o.png", mirrored: true });
    assert.equal(m[m.indexOf("-vf") + 1], "hflip");
    assert.equal(m.at(-1), "/o.png");
  });

  it("CLI: extrai a folha do arquivo local e avisa do espelhamento default", (t) => {
    if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("sem ffmpeg");
    const dir = tmp();
    const video = join(dir, "bruto.mp4");
    const mk = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10", "-t", "4", "-pix_fmt", "yuv420p", "-y", video]);
    if (mk.status !== 0) return t.skip("ffmpeg sem testsrc/libx264");
    const ed = join(dir, "ed");
    mkdirSync(ed);
    const r = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI, "261119", "--frames-from-file", video, "--count", "2", "--edition-dir", ed], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(ed, "_internal", "youtube-thumb-frames", "opcoes.jpg")));
    assert.match(r.stderr, /DEFAULT/);
  });
});
