/**
 * #12275: na 261105 `fetch-drive-video.ts --download` ligou `--promote` sozinho
 * (`promote: download || flags.has("promote")`) e copiou o vídeo escolhido de
 * `Editado/` para `Final/` no Drive do editor, criando a pasta, sem aviso e sem
 * como desligar. Agora `--download` só baixa; a cópia sai só com `--promote`
 * explícito, e o log avisa antes de escrever no Drive. `--no-promote` é aceito
 * (no-op). Sem rede (Drive mockado).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveVideoFile } from "../scripts/lib/diaria/drive-video-source.ts";
import {
  parseFetchDriveVideoArgs,
  runFetchDriveVideo,
  type DriveFetchInit,
  type FetchDriveVideoDeps,
  type FetchDriveVideoInput,
} from "../scripts/fetch-drive-video.ts";

const CFG = { folderId: "cfg-folder", windowHours: 36 };
const FOLDER = "application/vnd.google-apps.folder";
const BYTES = Buffer.from("fake-mp4-bytes");

const YT5: DriveVideoFile = {
  id: "yt5",
  name: "Diaria comentada_Youtube_V5.mp4",
  mimeType: "video/mp4",
  createdTime: "2026-11-05T20:00:00Z",
  modifiedTime: "2026-11-05T20:00:00Z",
  size: String(BYTES.length),
  videoMediaMetadata: { width: 1920, height: 1080 },
};

/** Edição só com `Editado/` (sem `Final/`), como na 261105. */
function mockDrive() {
  const posts: string[] = [];
  const media: string[] = [];
  const deps: FetchDriveVideoDeps = {
    async driveFetch(url: string, init?: DriveFetchInit) {
      const u = new URL(url);
      if (init?.method === "POST") {
        posts.push(u.pathname);
        if (u.pathname.endsWith("/copy")) return Response.json({ id: "yt5-copy" });
        return Response.json({ id: "new-final" });
      }
      if (u.searchParams.get("alt") === "media") {
        media.push(url);
        return new Response(new Uint8Array(BYTES), { headers: { "content-type": "video/mp4" } });
      }
      if (u.pathname.endsWith("/files")) {
        const q = u.searchParams.get("q") ?? "";
        if (q.includes("'sub-editado'")) return Response.json({ files: [YT5] });
        if (q.includes("'ed'")) return Response.json({ files: [{ id: "sub-editado", name: "Editado", mimeType: FOLDER }] });
        return Response.json({ files: [{ id: "ed", name: "261105", mimeType: FOLDER }] });
      }
      return Response.json({ id: "root", mimeType: FOLDER });
    },
  };
  return { deps, posts, media };
}

async function run(opts: Partial<FetchDriveVideoInput>) {
  const dir = mkdtempSync(join(tmpdir(), "fdv-12275-"));
  const logs: string[] = [];
  const drive = mockDrive();
  try {
    const out = await runFetchDriveVideo(
      drive.deps,
      {
        aammdd: "261105",
        orientation: "horizontal",
        folderId: "root",
        editionDir: dir,
        now: new Date("2026-11-05T23:00:00Z"),
        windowHours: 36,
        dryRun: false,
        force: false,
        ...opts,
      },
      (l) => logs.push(l),
    );
    const downloaded = existsSync(join(dir, "diaria-comentada-261105.mp4"));
    return { out, logs, posts: drive.posts, media: drive.media, downloaded };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#12275 parse: --download não liga a promoção; só --promote explícito liga", () => {
  const dl = parseFetchDriveVideoArgs(["--edition", "261105", "--orientation", "horizontal", "--download"], CFG);
  assert.ok(dl.ok);
  assert.equal(dl.ok && dl.dryRun, false);
  assert.equal(dl.ok && dl.promote, false, "o caso do incidente: --download sozinho não escreve no Drive");
  const both = parseFetchDriveVideoArgs(["--edition", "261105", "--orientation", "horizontal", "--download", "--promote"], CFG);
  assert.equal(both.ok && both.promote, true);
});

test("#12275 parse: --no-promote aceito como no-op; junto com --promote é erro", () => {
  const off = parseFetchDriveVideoArgs(["--edition", "261105", "--orientation", "horizontal", "--download", "--no-promote"], CFG);
  assert.ok(off.ok, JSON.stringify(off));
  assert.equal(off.ok && off.promote, false);
  const clash = parseFetchDriveVideoArgs(["--edition", "261105", "--orientation", "horizontal", "--promote", "--no-promote"], CFG);
  assert.equal(clash.ok, false);
  const valued = parseFetchDriveVideoArgs(["--edition", "261105", "--orientation", "horizontal", "--no-promote", "x"], CFG);
  assert.equal(valued.ok, false, "--no-promote não leva valor");
});

test("#12275: --download sem --promote baixa e não chama a cópia no Drive", async () => {
  const promote = parseFetchDriveVideoArgs(["--edition", "261105", "--orientation", "horizontal", "--download"], CFG);
  assert.ok(promote.ok);
  const { out, logs, posts, media, downloaded } = await run({ promote: promote.ok && promote.promote });
  assert.equal(posts.length, 0, `nenhum POST no Drive (cópia/criação de Final/): ${posts.join(", ")}`);
  assert.equal(media.length, 1, "o vídeo foi baixado");
  assert.equal(downloaded, true);
  assert.equal((out.output as { promoted?: unknown }).promoted, undefined);
  assert.ok(logs.some((l) => /não copiado para Final\//.test(l)), logs.join("\n"));
  assert.ok(!logs.some((l) => /\[aviso\] --promote/.test(l)), logs.join("\n"));
});

test("#12275: --download --promote copia para Final/ e avisa antes", async () => {
  const { out, logs, posts } = await run({ promote: true });
  assert.ok(posts.some((p) => /\/files\/yt5\/copy$/.test(p)), `cópia chamada: ${posts.join(", ")}`);
  assert.equal((out.output as { promoted?: { status?: string } }).promoted?.status, "copied");
  const warn = logs.findIndex((l) => /\[aviso\] --promote: copiando Diaria comentada_Youtube_V5\.mp4 de Editados\/ para Final\//.test(l));
  const done = logs.findIndex((l) => /copiado para Final\//.test(l) && /\[ok\]/.test(l));
  assert.ok(warn >= 0, logs.join("\n"));
  assert.ok(done > warn, "o aviso sai antes da cópia");
});
