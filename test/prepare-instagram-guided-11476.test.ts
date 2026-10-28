import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGuidedInstagram } from "../scripts/prepare-instagram-guided.ts";
import { defaultChromeUploadDeps } from "../scripts/publish-shorts.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "instagram-11476-"));
  writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo do destaque. Segunda frase.\n");
  const config = { publishing: { youtube: { drive_folder_id: "folder" }, shorts: {
    facebook_pages: [], instagram: true, instagram_backend: "timer-300", instagram_api_max_seconds: 40,
  } } };
  // MP4 mínimo com moov/mvhd, timescale=1000 e duração de 75 s.
  const mp4 = Buffer.alloc(36);
  mp4.writeUInt32BE(36, 0); mp4.write("moov", 4);
  mp4.writeUInt32BE(28, 8); mp4.write("mvhd", 12);
  mp4.writeUInt32BE(1000, 28); mp4.writeUInt32BE(75000, 32);
  const calls: string[] = [];
  const deps: NonNullable<Parameters<typeof prepareGuidedInstagram>[1]> = {
    now: () => new Date("2026-10-28T10:00:00Z"),
    drive: { driveFetch: async () => { throw new Error("rede inesperada"); } },
    select: async (_deps, input) => {
      assert.equal(input.target, "instagram"); assert.equal(input.orientation, "vertical");
      assert.equal(input.dryRun, true); calls.push("select");
      return { exitCode: 0, output: { action: "print-id", selection: "found", edition: input.aammdd,
        orientation: "vertical", folder_id: "folder", local_path: "unused", edition_folder_id: "edition",
        final_folder_ids: ["final"], target: "instagram", next_command: null,
        file: { id: "instagram-cut", name: "Diaria comentada_Instagram_V1.mp4", size: 36, width: 720, height: 1280, createdTime: null, scope: "final-folder", modifiedTime: null },
      } };
    },
    download: async (_deps, id, path) => {
      assert.equal(id, "instagram-cut"); assert.match(path, /instagram-drive\.mp4$/);
      assert.ok(!existsSync(join(dir, "diaria-comentada-261028-short.mp4")));
      calls.push("download"); return { bytes: 36, name: "Diaria comentada_Instagram_V1.mp4" };
    },
    readVideo: () => mp4,
    compression: defaultChromeUploadDeps,
    compress: (_deps, input) => {
      assert.equal(input.durationSeconds, 75); assert.match(input.source, /instagram-drive\.mp4$/);
      calls.push("compress"); return { ok: true, path: input.output, sizeBytes: 9_500_000, videoKbps: 914, reused: false };
    },
  };
  return { dir, config, deps, calls };
}

it("#11476 prepara o corte do Drive sem MP4 do 300 nem vertical local, sem registrar publicação", async () => {
  const f = fixture();
  try {
    const result = await prepareGuidedInstagram({ aammdd: "261028", dir: f.dir, config: f.config }, f.deps);
    assert.deepEqual(f.calls, ["select", "download", "compress"]);
    assert.match(result.upload.path, /short-instagram-chrome\.mp4$/);
    assert.equal(result.upload.fitsChromeUpload, true);
    assert.ok(result.caption?.includes("Título do D1"));
    assert.ok(result.at && Number.isFinite(Date.parse(result.at)));
    assert.deepEqual(readdirSync(f.dir), ["02-reviewed.md"]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it("#11476 não oferece upload acima de 10 MB ou com compressão falha", async () => {
  const f = fixture();
  try {
    f.deps.compress = () => ({ ok: true, path: "large.mp4", sizeBytes: 10_000_001, videoKbps: 250, reused: false });
    await assert.rejects(prepareGuidedInstagram({ aammdd: "261028", dir: f.dir, config: f.config }, f.deps), /excede 10 MB/);
    f.deps.compress = () => ({ ok: false, error: "ffmpeg ausente" });
    await assert.rejects(prepareGuidedInstagram({ aammdd: "261028", dir: f.dir, config: f.config }, f.deps), /ffmpeg ausente/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it("#11476 seleção ausente/ambígua aborta antes de baixar ou comprimir", async () => {
  const f = fixture();
  try {
    f.deps.select = async () => ({ exitCode: 0, output: { action: "none", selection: "none", reason: "sem corte",
      edition: "261028", orientation: "vertical", folder_id: "folder", local_path: "unused",
      edition_folder_id: null, final_folder_ids: [], target: "instagram" } });
    await assert.rejects(prepareGuidedInstagram({ aammdd: "261028", dir: f.dir, config: f.config }, f.deps), /não selecionado/);
    assert.deepEqual(f.calls, []);
    f.deps.select = async () => ({ exitCode: 3, output: { action: "needs-editor", selection: "ambiguous", candidates: [],
      edition: "261028", orientation: "vertical", folder_id: "folder", local_path: "unused",
      edition_folder_id: "edition", final_folder_ids: ["final"], target: "instagram" } });
    await assert.rejects(prepareGuidedInstagram({ aammdd: "261028", dir: f.dir, config: f.config }, f.deps), /não selecionado/);
    assert.deepEqual(f.calls, []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
