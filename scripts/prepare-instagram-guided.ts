#!/usr/bin/env node
/**
 * scripts/prepare-instagram-guided.ts (#11476)
 *
 * Prepara o passo guiado do Instagram (Passo B3b do `/diaria-publica-video`)
 * na máquina que vai postar pelo Chrome, sem depender do `.mp4` comprimido que
 * o timer do `300` gera. Na 261028 só o sidecar `.json` desse arquivo chegou
 * ao Windows pelo OneDrive (o vídeo não sincroniza), o vertical local também
 * não existia, e o editor refez tudo à mão: copiou o `_Instagram_` do Drive,
 * comprimiu no ffmpeg e subiu.
 *
 * Uso:
 *   npx tsx scripts/prepare-instagram-guided.ts AAMMDD [--video PATH] [--edition-dir DIR] [--edition-url URL]
 *
 * Um comando só:
 *   1. o vídeo: `--video PATH` (ex.: o corte direto do Drive montado em `G:`)
 *      ou o corte `_Instagram_` da pasta `Final/` do Drive, achado pelo mesmo
 *      `runFetchDriveVideo --target instagram` do `fetch-drive-video.ts` e
 *      escolhido pela mesma regra do timer (`chooseInstagramVideo`): baixa em
 *      `diaria-comentada-{AAMMDD}-short-instagram.mp4` quando o id ou o
 *      `modifiedTime` do Drive mudaram (sidecar `_internal/.shorts-instagram-cut.json`),
 *      reaproveita o que já está no disco, e sem corte no Drive usa o vertical
 *      genérico só se ele já estiver no disco;
 *   2. o plano: `planShortsPublish` só com o `instagram` e a duração desse
 *      vídeo. Acima do teto da API ele vira `guided`, com a legenda e o horário
 *      (`at`) que o `publish-shorts.ts` daria;
 *   3. a compressão: a mesma do `--publish` (`prepareInstagramChromeUpload`,
 *      ffmpeg 2-pass 720x1280 mirando 9,5 MB) em
 *      `_internal/diaria-comentada-{AAMMDD}-short-instagram-chrome.mp4`.
 *
 * Saída (JSON no stdout): `upload { path, sizeBytes, fitsChromeUpload }`,
 * `caption` e `at`, prontos para o Chrome, e o `next_command` do registro
 * (`--confirm-instagram`). NUNCA publica nem grava o registro do vertical: o
 * único estado que escreve é o vídeo baixado, o sidecar do corte e o arquivo
 * comprimido (com o sidecar dele).
 *
 * Exit codes: 0 = arquivo pronto, ou nada a preparar (`already-registered`,
 * `fits-api`, `no-video`, `instagram-off`); 1 = falha (Drive, download,
 * duração ilegível, legenda não gerada); 2 = uso/config inválidos;
 * 3 = o Drive precisa do editor (ambíguo ou proporção desconhecida).
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { gFetchRetry } from "./lib/drive-helpers.ts";
import { DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS, downloadDriveFileById } from "./lib/drive-download.ts";
import { loadResolvedFacebookPages, type ResolvedFacebookPage } from "./lib/facebook-pages.ts";
import { DRIVE_VIDEO_WINDOW_HOURS } from "./lib/diaria/drive-video-source.ts";
import {
  isDestinationDone,
  loadShortsConfig,
  mp4DurationSeconds,
  shortInstagramVideoFileName,
  shortVideoFileName,
} from "./lib/diaria/short-video.ts";
import { readShortsRegistry } from "./lib/diaria/shorts-published-store.ts";
import {
  chromeUploadFileName,
  type ChromeUploadPlanFile,
  type ChromeUploadResult,
} from "./lib/diaria/instagram-chrome-upload.ts";
import {
  attachChromeUploadToPlan,
  defaultChromeUploadDeps,
  loadScheduledGrid,
  planShortsPublish,
  prepareInstagramChromeUpload,
  resolveEditionUrlInput,
  type ShortsPlanItem,
} from "./publish-shorts.ts";
import {
  INSTAGRAM_CUT_SIDECAR_FILE,
  chooseInstagramVideo,
  interpretInstagramCutLookup,
  parseCutSidecar,
  type InstagramCutLookup,
} from "./shorts-instagram-timer.ts";
import { defaultFetchDriveVideoDeps, readYouTubeDriveConfig, runFetchDriveVideo } from "./fetch-drive-video.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type GuidedVideoSource = "flag" | "instagram-cut" | "generic";

export type PrepareInstagramGuidedOutput =
  | {
      action: "guided";
      edition: string;
      video: { path: string; source: GuidedVideoSource; drive_file_id: string | null; downloaded: boolean };
      duration_seconds: number;
      upload: ChromeUploadPlanFile;
      caption: string | null;
      at: string | null;
      detail: string;
      next_command: string;
      premises: string[];
      warnings: string[];
    }
  | { action: "already-registered" | "instagram-off" | "no-video" | "fits-api" | "needs-editor" | "error"; edition: string; reason: string; video?: { path: string; source: GuidedVideoSource }; duration_seconds?: number; warnings: string[] };

export interface PrepareInstagramGuidedDeps {
  config: unknown;
  now: Date;
  pages: ResolvedFacebookPage[];
  /** Corte `_Instagram_` na pasta `Final/` do Drive (só o lookup, nada baixado). */
  lookupInstagramCut: () => Promise<InstagramCutLookup>;
  /** Baixa o arquivo do Drive por id em `dest` (download protegido, `.part`). */
  downloadDriveFile: (fileId: string, dest: string) => Promise<void>;
  /** Duração (s) do MP4; null = ilegível. */
  videoDurationSeconds: (path: string) => number | null;
  /** A compressão do `--publish` (ffmpeg); nunca lança. */
  compress: (input: { source: string; output: string; durationSeconds: number }) => ChromeUploadResult;
  log: (line: string) => void;
}

export interface PrepareInstagramGuidedInput {
  aammdd: string;
  dir: string;
  /** `--video PATH`: pula o Drive. */
  video?: string | null;
  editionUrl?: string;
}

export interface PrepareInstagramGuidedOutcome {
  exitCode: number;
  output: PrepareInstagramGuidedOutput;
}

/** Comando que registra o Reels depois do Share (Passo B3b, item 8). */
export function confirmInstagramCommand(aammdd: string): string {
  return `npx tsx scripts/publish-shorts.ts ${aammdd} --confirm-instagram`;
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export async function runPrepareInstagramGuided(
  deps: PrepareInstagramGuidedDeps,
  input: PrepareInstagramGuidedInput,
): Promise<PrepareInstagramGuidedOutcome> {
  const { aammdd, dir } = input;
  const warnings: string[] = [];
  const stop = (exitCode: number, action: Exclude<PrepareInstagramGuidedOutput["action"], "guided">, reason: string, extra: { video?: { path: string; source: GuidedVideoSource }; duration_seconds?: number } = {}): PrepareInstagramGuidedOutcome => {
    deps.log(`${exitCode === 0 ? "[ok]" : "[erro]"} instagram guiado: ${reason}`);
    return { exitCode, output: { action, edition: aammdd, reason, warnings, ...extra } };
  };

  const reviewedPath = join(dir, "02-reviewed.md");
  if (!existsSync(reviewedPath)) return stop(1, "error", `${reviewedPath} não existe`);
  let cfg: ReturnType<typeof loadShortsConfig>;
  try {
    cfg = loadShortsConfig(deps.config);
  } catch (e) {
    return stop(2, "error", `config inválida: ${(e as Error).message}`);
  }
  if (!cfg.instagram) return stop(0, "instagram-off", "publishing.shorts.instagram desligado — nada a preparar");
  const published = readShortsRegistry(dir, aammdd);
  if (isDestinationDone(published, "instagram")) {
    return stop(0, "already-registered", "o instagram já está registrado nesta edição — nada a preparar (não reposte)");
  }

  // 1. O vídeo.
  let videoPath: string;
  let source: GuidedVideoSource;
  let driveFileId: string | null = null;
  let downloaded = false;
  if (input.video) {
    videoPath = resolve(input.video);
    source = "flag";
    if (!existsSync(videoPath)) return stop(2, "error", `--video ${videoPath} não existe`);
  } else {
    const cutPath = join(dir, shortInstagramVideoFileName(aammdd));
    const sidecarPath = join(dir, INSTAGRAM_CUT_SIDECAR_FILE);
    const genericPath = join(dir, shortVideoFileName(aammdd));
    const lookup = await deps.lookupInstagramCut();
    const choice = chooseInstagramVideo({
      instagramCutPath: cutPath,
      instagramCutExists: existsSync(cutPath),
      cutSidecar: parseCutSidecar(existsSync(sidecarPath) ? readFileSync(sidecarPath, "utf8") : null),
      genericPath,
      genericExists: existsSync(genericPath),
      lookup,
    });
    if (choice.kind === "wait") {
      if (choice.alarm === "drive-needs-editor") return stop(3, "needs-editor", choice.reason);
      return stop(0, "no-video", `${choice.reason} — suba o corte em Final/ ou passe --video PATH`);
    }
    if (choice.kind === "error") return stop(1, "error", `Drive: ${choice.reason} (se for token, renovar com npx tsx scripts/oauth-setup.ts; ou passe --video PATH)`);
    videoPath = choice.path;
    if (choice.kind === "download") {
      source = "instagram-cut";
      driveFileId = choice.fileId;
      deps.log(`[ok] corte do Instagram no Drive: ${choice.name} (${choice.fileId}) → ${choice.path}`);
      try {
        await deps.downloadDriveFile(choice.fileId, choice.path);
      } catch (e) {
        return stop(1, "error", `download do corte ${choice.fileId} falhou: ${(e as Error).message}`);
      }
      downloaded = true;
      try {
        mkdirSync(dirname(sidecarPath), { recursive: true });
        writeFileAtomic(sidecarPath, JSON.stringify({ fileId: choice.fileId, modifiedTime: choice.modifiedTime, name: choice.name }, null, 2) + "\n");
      } catch (e) {
        warnings.push(`sidecar ${sidecarPath} não gravado (${(e as Error).message}) — a próxima rodada baixa o corte de novo`);
      }
    } else {
      source = choice.source;
      if (choice.note) warnings.push(choice.note);
      deps.log(`[ok] vídeo do Instagram no disco (${choice.source === "instagram-cut" ? "corte do Instagram" : "vertical genérico"}): ${choice.path}`);
    }
  }
  const video = { path: videoPath, source };

  // 2. Duração e plano.
  const duration = deps.videoDurationSeconds(videoPath);
  if (duration === null) return stop(1, "error", `duração ilegível em ${videoPath} — confira o MP4`, { video });
  const editionUrlIn = resolveEditionUrlInput(dir, input.editionUrl);
  let plan: ReturnType<typeof planShortsPublish>;
  try {
    plan = planShortsPublish({
      aammdd,
      reviewedMd: readFileSync(reviewedPath, "utf8"),
      now: deps.now,
      config: deps.config,
      pages: deps.pages,
      // Este comando nunca publica: a credencial da API não é conferida.
      instagramReady: false,
      instagramNotReadyReason: "não conferida (preparo do passo guiado, #11476)",
      published,
      // Com o timer do 300 dono do Instagram, a rodada normal veria `skip_delegated`;
      // o passo guiado é o que a rodada do timer mostraria.
      writer: cfg.instagramBackend === "timer-300" ? "instagram-timer" : "main",
      video: { path: videoPath, exists: true, sizeBytes: sizeOf(videoPath) },
      videoDurationSeconds: duration,
      editionUrl: editionUrlIn.url,
      editionUrlSource: editionUrlIn.source,
      only: ["instagram"],
      grid: loadScheduledGrid(dir, published, cfg.instagramAuthorPage, (m) => warnings.push(m), {
        instagramCollaborators: cfg.instagramCollaborators,
      }),
    });
  } catch (e) {
    return stop(2, "error", `plano: ${(e as Error).message}`, { video, duration_seconds: duration });
  }
  const item = plan.items.find((i) => i.destination === "instagram");
  if (!item) return stop(1, "error", "o plano não trouxe o destino instagram", { video, duration_seconds: duration });
  if (item.action === "skip_done") return stop(0, "already-registered", "o instagram já está registrado nesta edição", { video, duration_seconds: duration });
  if (item.action !== "guided") {
    return stop(
      0,
      "fits-api",
      `${duration.toFixed(1)} s cabem no teto da API — sem passo guiado; quem publica é o timer do 300 (ou --only instagram --publish --instagram-timer, conferindo a conta antes)`,
      { video, duration_seconds: duration },
    );
  }

  // 3. A compressão do --publish.
  const upload = deps.compress({ source: videoPath, output: join(dir, "_internal", chromeUploadFileName(aammdd)), durationSeconds: duration });
  const attached = attachChromeUploadToPlan([item], upload, { path: videoPath, sizeBytes: sizeOf(videoPath) });
  const guided = attached.items[0] as Extract<ShortsPlanItem, { action: "guided" }>;
  const allWarnings = [...warnings, // O aviso `instagram: {detail}` do plano repete o `detail` da saída.
    ...plan.warnings.filter((w) => w !== `instagram: ${item.detail}`), ...attached.warnings];
  const caption = guided.caption ?? null;
  if (!caption) allWarnings.push("legenda do Instagram não gerada — confira o 02-reviewed.md (D1)");
  const output: PrepareInstagramGuidedOutput = {
    action: "guided",
    edition: aammdd,
    video: { path: videoPath, source, drive_file_id: driveFileId, downloaded },
    duration_seconds: duration,
    upload: guided.upload ?? { path: videoPath, sizeBytes: sizeOf(videoPath), fitsChromeUpload: false },
    caption,
    at: guided.at ?? null,
    detail: guided.detail,
    next_command: confirmInstagramCommand(aammdd),
    premises: plan.premises,
    warnings: allWarnings,
  };
  deps.log(
    `${output.upload.fitsChromeUpload ? "[ok]" : "[aviso]"} instagram guiado: ${output.upload.path} ` +
      `(${output.upload.sizeBytes === null ? "?" : (output.upload.sizeBytes / 1e6).toFixed(1)} MB, cabe no file_upload: ${output.upload.fitsChromeUpload ? "sim" : "não"}), às ${output.at ?? "?"}`,
  );
  return { exitCode: caption ? 0 : 1, output };
}

// ── CLI ───────────────────────────────────────────────────────────────────

const USAGE = "uso: prepare-instagram-guided.ts AAMMDD [--video PATH] [--edition-dir DIR] [--edition-url URL]";

export type ParsedPrepareGuidedArgs =
  | { ok: true; aammdd: string; video: string | null; editionDir: string | null; editionUrl: string | undefined }
  | { ok: false; error: string };

/** Pure: argv → argumentos (erro = exit 2). */
export function parsePrepareGuidedArgs(argv: string[]): ParsedPrepareGuidedArgs {
  const { flags, values, positional } = parseArgs(argv);
  const missingValue = ["video", "edition-dir", "edition-url", "edition"].filter((f) => flags.has(f));
  if (missingValue.length) return { ok: false, error: `${missingValue.map((f) => `--${f}`).join(", ")} sem valor` };
  const unknownFlags = [...flags].filter((f) => !["help"].includes(f));
  if (unknownFlags.length) return { ok: false, error: `flag não reconhecida: ${unknownFlags.map((f) => `--${f}`).join(", ")}` };
  const candidates = [...new Set([values["edition"], ...positional].filter((x): x is string => typeof x === "string"))];
  if (candidates.length > 1) return { ok: false, error: `edição ambígua: ${candidates.join(", ")}` };
  const aammdd = candidates[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) return { ok: false, error: "AAMMDD ausente ou inválido" };
  return { ok: true, aammdd, video: values["video"] ?? null, editionDir: values["edition-dir"] ?? null, editionUrl: values["edition-url"] };
}

function defaultDeps(aammdd: string, dir: string, config: unknown): PrepareInstagramGuidedDeps {
  const drive = readYouTubeDriveConfig(config);
  const log = (line: string) => console.error(line);
  return {
    config,
    now: new Date(),
    pages: loadResolvedFacebookPages(ROOT, config).pages,
    lookupInstagramCut: async () => {
      if (!drive.folderId) return { kind: "error", reason: "sem publishing.youtube.drive_folder_id no platform.config.json" };
      const outcome = await runFetchDriveVideo(
        defaultFetchDriveVideoDeps,
        {
          aammdd,
          orientation: "vertical",
          target: "instagram",
          folderId: drive.folderId,
          editionDir: dir,
          now: new Date(),
          windowHours: drive.windowHours ?? DRIVE_VIDEO_WINDOW_HOURS,
          dryRun: false,
          force: false,
        },
        log,
      );
      return interpretInstagramCutLookup(outcome.exitCode, JSON.stringify(outcome.output));
    },
    downloadDriveFile: async (fileId, dest) => {
      await downloadDriveFileById({ driveFetch: (url, init) => gFetchRetry(url, init ?? {}) }, fileId, dest, DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS, log);
    },
    videoDurationSeconds: (path) => {
      try {
        return mp4DurationSeconds(readFileSync(path));
      } catch {
        return null;
      }
    },
    compress: (input) => prepareInstagramChromeUpload(defaultChromeUploadDeps, input),
    log,
  };
}

async function main(): Promise<number> {
  const args = parsePrepareGuidedArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`prepare-instagram-guided: ${args.error}\n${USAGE}`);
    return 2;
  }
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  } catch (e) {
    console.error(`prepare-instagram-guided: platform.config.json ilegível: ${(e as Error).message}`);
    return 2;
  }
  const dir = resolve(args.editionDir ?? editionDirFor(args.aammdd));
  const outcome = await runPrepareInstagramGuided(defaultDeps(args.aammdd, dir, config), {
    aammdd: args.aammdd,
    dir,
    video: args.video,
    editionUrl: args.editionUrl,
  });
  for (const w of outcome.output.warnings) console.error(`[aviso] ${w}`);
  console.log(JSON.stringify(outcome.output, null, 2));
  return outcome.exitCode;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("prepare-instagram-guided:", e instanceof Error ? e.message : e) });
}
