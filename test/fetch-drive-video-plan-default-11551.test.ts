/**
 * #11551: na edição 261029 uma checagem do `fetch-drive-video.ts` por ssh no
 * 300 baixou o vídeo de verdade (312 MB). Agora o CLI só planeja sem
 * `--download` (nenhum byte em disco), imprime tamanho e destino antes de
 * baixar e recusa acima do teto (`--max-mb`) sem `--force`. Sem rede.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveVideoFile } from "../scripts/lib/diaria/drive-video-source.ts";
import {
  DEFAULT_MAX_DOWNLOAD_MB,
  parseFetchDriveVideoArgs,
  readYouTubeDriveConfig,
  runFetchDriveVideo,
  type FetchDriveVideoDeps,
  type FetchDriveVideoInput,
} from "../scripts/fetch-drive-video.ts";

const CFG = { folderId: "cfg-folder", windowHours: 36 };
const FOLDER = "application/vnd.google-apps.folder";
const BYTES = Buffer.from("fake-mp4-bytes-312MB");

const YT: DriveVideoFile = {
  id: "yt",
  name: "Diaria comentada_Youtube_V5.mp4",
  mimeType: "video/mp4",
  createdTime: "2026-10-28T20:00:00Z",
  modifiedTime: "2026-10-28T20:00:00Z",
  size: String(BYTES.length),
  videoMediaMetadata: { width: 1920, height: 1080 },
};

function mockDrive() {
  const media: string[] = [];
  const deps: FetchDriveVideoDeps = {
    async driveFetch(url) {
      const u = new URL(url);
      if (u.pathname.endsWith("/files")) {
        const q = u.searchParams.get("q") ?? "";
        if (q.includes("'final'")) return Response.json({ files: [YT] });
        if (q.includes("'ed'")) return Response.json({ files: [{ id: "final", name: "Final", mimeType: FOLDER }] });
        return Response.json({ files: [{ id: "ed", name: "261029", mimeType: FOLDER }] });
      }
      if (u.searchParams.get("alt") === "media") {
        media.push(url);
        return new Response(new Uint8Array(BYTES), { headers: { "content-type": "video/mp4" } });
      }
      return Response.json({ id: "root", mimeType: FOLDER });
    },
  };
  return { deps, media };
}

async function withRun(input: Partial<FetchDriveVideoInput>, check: (r: { out: Awaited<ReturnType<typeof runFetchDriveVideo>>; dir: string; media: string[]; logs: string[] }) => void) {
  const dir = mkdtempSync(join(tmpdir(), "fdv-11551-"));
  try {
    const { deps, media } = mockDrive();
    const logs: string[] = [];
    const out = await runFetchDriveVideo(
      deps,
      { aammdd: "261029", orientation: "horizontal", folderId: "root", editionDir: dir, now: new Date("2026-10-28T23:00:00Z"), windowHours: 36, dryRun: true, force: false, ...input },
      (l) => logs.push(l),
    );
    check({ out, dir, media, logs });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parse: sem --download o CLI só planeja; --download baixa e promove; os dois juntos = erro", () => {
  const plain = parseFetchDriveVideoArgs(["--edition", "261029", "--orientation", "horizontal"], CFG);
  assert.equal(plain.ok && plain.dryRun, true, "o caso do incidente: verificação sem flag não baixa");
  assert.equal(plain.ok && plain.promote, false);
  assert.equal(plain.ok && plain.maxBytes, DEFAULT_MAX_DOWNLOAD_MB * 1e6);
  const dl = parseFetchDriveVideoArgs(["--edition", "261029", "--orientation", "horizontal", "--download", "--max-mb", "500"], CFG);
  assert.equal(dl.ok && dl.dryRun, false);
  assert.equal(dl.ok && dl.promote, true);
  assert.equal(dl.ok && dl.maxBytes, 500e6);
  const promote = parseFetchDriveVideoArgs(["--edition", "261029", "--orientation", "vertical", "--promote"], CFG);
  assert.equal(promote.ok && promote.promote, true);
  for (const argv of [
    ["--edition", "261029", "--orientation", "horizontal", "--download", "--dry-run"],
    ["--edition", "261029", "--orientation", "horizontal", "--download", "--max-mb", "0"],
    ["--edition", "261029", "--orientation", "horizontal", "--max-mb"],
  ]) {
    assert.equal(parseFetchDriveVideoArgs(argv, CFG).ok, false, argv.join(" "));
  }
});

test("config: publishing.youtube.drive_max_download_mb vira o teto default", () => {
  const cfg = readYouTubeDriveConfig({ publishing: { youtube: { drive_folder_id: "f", drive_max_download_mb: 800 } } });
  assert.equal(cfg.maxDownloadMb, 800);
  const p = parseFetchDriveVideoArgs(["--edition", "261029", "--orientation", "horizontal", "--download"], cfg);
  assert.equal(p.ok && p.maxBytes, 800e6);
});

test("plano (dryRun): nenhum byte gravado nem pedido ao Drive; o log diz tamanho e destino", () =>
  withRun({ dryRun: true }, ({ out, dir, media, logs }) => {
    assert.equal(out.output.action, "dry-run");
    assert.equal(media.length, 0, "nenhum alt=media");
    assert.deepEqual(readdirSync(dir), [], "nada no disco");
    assert.ok(logs.some((l) => l.startsWith("[plano]") && l.includes("MB") && l.includes("diaria-comentada-261029.mp4")));
  }));

test("acima do teto: exit 1 size-limit, nada baixado; --force passa", async () => {
  await withRun({ dryRun: false, maxBytes: 5 }, ({ out, dir, media }) => {
    assert.equal(out.exitCode, 1);
    assert.equal(out.output.action, "error");
    if (out.output.action === "error") assert.equal((out.output as { phase: string }).phase, "size-limit");
    assert.equal(media.length, 0);
    assert.equal(existsSync(join(dir, "diaria-comentada-261029.mp4")), false);
  });
  await withRun({ dryRun: false, maxBytes: 5, force: true }, ({ out, dir }) => {
    assert.equal(out.output.action, "downloaded");
    assert.equal(readFileSync(join(dir, "diaria-comentada-261029.mp4"), "utf8"), BYTES.toString());
  });
});

test("download explícito abaixo do teto: baixa e loga tamanho/destino antes", () =>
  withRun({ dryRun: false, maxBytes: 1e9 }, ({ out, logs }) => {
    assert.equal(out.output.action, "downloaded");
    assert.ok(logs.some((l) => l.startsWith("[download]") && l.includes("diaria-comentada-261029.mp4")));
  }));

test("stage5-youtube: o fetch que sobe o vídeo passa --download (senão o novo default não baixaria)", () => {
  const src = readFileSync(new URL("../scripts/stage5-youtube.ts", import.meta.url), "utf8");
  assert.match(src, /runTsx\(\[\.\.\.fetchArgs, "--download"\]\)/);
});
