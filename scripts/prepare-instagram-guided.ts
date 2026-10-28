/** Prepara o passo B3b no Windows a partir do corte Instagram do Drive (#11476).
 * Não publica, não altera registros e não usa o MP4/sidecar do 300.
 * npx tsx scripts/prepare-instagram-guided.ts AAMMDD [--edition-dir DIR]
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { runFetchDriveVideo, defaultFetchDriveVideoDeps, readYouTubeDriveConfig } from "./fetch-drive-video.ts";
import { downloadDriveFileById, DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS } from "./lib/drive-download.ts";
import { mp4DurationSeconds, loadShortsConfig } from "./lib/diaria/short-video.ts";
import { chromeUploadFileName, fitsChromeUpload } from "./lib/diaria/instagram-chrome-upload.ts";
import { planShortsPublish, prepareInstagramChromeUpload, defaultChromeUploadDeps, resolveEditionUrlInput, loadScheduledGrid } from "./publish-shorts.ts";
import { loadResolvedFacebookPages } from "./lib/facebook-pages.ts";
import { readShortsRegistry } from "./lib/diaria/shorts-published-store.ts";
import { DRIVE_VIDEO_WINDOW_HOURS } from "./lib/diaria/drive-video-source.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function prepareGuidedInstagram(
  input: { aammdd: string; dir: string; config: unknown },
  deps = {
    select: runFetchDriveVideo,
    drive: defaultFetchDriveVideoDeps,
    download: downloadDriveFileById,
    readVideo: (path: string) => readFileSync(path),
    compress: prepareInstagramChromeUpload,
    compression: defaultChromeUploadDeps,
    now: () => new Date(),
  },
) {
  const { aammdd, dir, config } = input;
  const cfg = readYouTubeDriveConfig(config);
  if (!cfg.folderId) throw new Error("publishing.youtube.drive_folder_id ausente");
  const selected = await deps.select(deps.drive, {
    aammdd, orientation: "vertical", target: "instagram", folderId: cfg.folderId,
    editionDir: dir, now: deps.now(), windowHours: cfg.windowHours ?? DRIVE_VIDEO_WINDOW_HOURS,
    dryRun: true, force: false,
  }, console.error);
  if (selected.output.action !== "print-id") {
    throw new Error(`corte Instagram não selecionado: ${JSON.stringify(selected.output)}`);
  }
  // Separado do short das outras redes: nunca o substitui nem reutiliza um sidecar remoto.
  const source = join(dir, "_internal", `diaria-comentada-${aammdd}-instagram-drive.mp4`);
  await deps.download(deps.drive, selected.output.file.id, source, DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS, console.error);
  const file = deps.readVideo(source);
  const duration = mp4DurationSeconds(file);
  if (duration === null) throw new Error("duração do corte Instagram não lida");
  const { pages } = loadResolvedFacebookPages(ROOT, config);
  const editionUrl = resolveEditionUrlInput(dir, undefined);
  const published = readShortsRegistry(dir, aammdd);
  const shortsCfg = loadShortsConfig(config);
  const plan = planShortsPublish({
    aammdd, reviewedMd: readFileSync(join(dir, "02-reviewed.md"), "utf8"),
    now: deps.now(), config, pages, instagramReady: false,
    writer: "instagram-timer", published,
    grid: loadScheduledGrid(dir, published, shortsCfg.instagramAuthorPage, console.error, { instagramCollaborators: shortsCfg.instagramCollaborators }),
    video: { path: source, exists: true, sizeBytes: file.length }, videoDurationSeconds: duration,
    editionUrl: editionUrl.url, editionUrlSource: editionUrl.source, only: ["instagram"],
  });
  const item = plan.items.find((i) => i.destination === "instagram");
  if (!item || item.action !== "guided" || !item.caption || !item.at) {
    throw new Error(`Instagram não tem passo guiado pendente: ${JSON.stringify(item)}`);
  }
  const upload = deps.compress(deps.compression, {
    source, output: join(dir, "_internal", chromeUploadFileName(aammdd)), durationSeconds: duration,
  });
  if (!upload.ok) throw new Error(upload.error);
  if (!fitsChromeUpload(upload.sizeBytes)) throw new Error("arquivo comprimido excede 10 MB do Chrome");
  return { ...item, upload: { path: upload.path, sizeBytes: upload.sizeBytes, fitsChromeUpload: true }, warnings: [...plan.warnings, ...(upload.warning ? [upload.warning] : [])] };
}

async function main() {
  const { positional, values, flags } = parseArgs(process.argv.slice(2));
  if (positional.length !== 1 || !/^\d{6}$/.test(positional[0]) || flags.size || Object.keys(values).some((k) => k !== "edition-dir")) {
    throw new Error("uso: prepare-instagram-guided.ts AAMMDD [--edition-dir DIR]");
  }
  const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  console.log(JSON.stringify(await prepareGuidedInstagram({
    aammdd: positional[0], dir: resolve(values["edition-dir"] ?? editionDirFor(positional[0])), config,
  }), null, 2));
}
if (isMainModule(import.meta.url)) main().catch((e) => { console.error(`prepare-instagram-guided: ${e.message}`); process.exitCode = 1; });
