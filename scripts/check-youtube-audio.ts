/**
 * check-youtube-audio.ts (#13403) — o áudio que o YouTube registrou do vídeo está bom?
 *
 * Checagem sob demanda do guard pós-upload (`scripts/lib/diaria/youtube-audio-check.ts`).
 * O `publish-youtube.ts --upload` e o `publish-shorts.ts --publish` já leem
 * `fileDetails`, mas logo depois do upload o processamento quase sempre ainda
 * não terminou (`audio_check: { pending: true }`): este script relê quando
 * terminar. Só LÊ (`videos.list?part=fileDetails,processingDetails`, 1 unidade
 * de quota, token do canal `YOUTUBE_*`). No áudio degradado abre o alarme ao
 * editor (issue `youtube-audio-degraded`, `notifyEditor`), salvo `--no-alarm`.
 *
 * Uso:
 *   npx tsx scripts/check-youtube-audio.ts --id VIDEO_ID
 *   npx tsx scripts/check-youtube-audio.ts --id VIDEO_ID --source Final/vertical.mp4   (origem sem áudio = nada a conferir)
 *   npx tsx scripts/check-youtube-audio.ts --id VIDEO_ID --no-alarm
 *
 * Saída: JSON no stdout (`audio_check`). Exit 0 = áudio ok (ou origem sem
 * áudio); 1 = degradado; 3 = processamento ainda não terminou (rodar de novo
 * mais tarde); 2 = uso errado, credencial ausente ou falha de leitura.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  checkYouTubeAudio,
  mp4HasAudioTrack,
  notifyYouTubeAudioDegraded,
  reportYouTubeAudioCheck,
  type YouTubeAudioAlarmFn,
  type YouTubeAudioCheck,
} from "./lib/diaria/youtube-audio-check.ts";
import {
  defaultYouTubeUploadDeps,
  missingYouTubeCredentials,
  refreshYouTubeAccessToken,
  type YouTubeUploadDeps,
} from "./lib/diaria/youtube-upload.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "uso: check-youtube-audio.ts --id VIDEO_ID [--source MP4] [--no-alarm]";
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Pure: exit code do resultado. */
export function audioCheckExitCode(check: YouTubeAudioCheck): number {
  switch (check.status) {
    case "ok":
    case "no_source_audio":
      return 0;
    case "degraded":
      return 1;
    case "pending":
      return 3;
    default:
      return 2;
  }
}

export interface CheckYouTubeAudioCliDeps {
  upload: YouTubeUploadDeps;
  env: Record<string, string | undefined>;
  readFile: (p: string) => Buffer;
  alarm: YouTubeAudioAlarmFn;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** CLI com I/O injetável (testes sem rede). */
export async function runCheckYouTubeAudio(argv: string[], deps: CheckYouTubeAudioCliDeps): Promise<number> {
  const { values, flags } = parseArgs(argv);
  const id = values["id"]?.trim();
  if (!id || !YOUTUBE_VIDEO_ID_RE.test(id)) {
    deps.err(id ? `check-youtube-audio: --id ${JSON.stringify(id)} não parece id de vídeo do YouTube (11 caracteres)` : USAGE);
    return 2;
  }
  let sourceHasAudio: boolean | null = null;
  if (values["source"]) {
    try {
      sourceHasAudio = mp4HasAudioTrack(deps.readFile(resolve(values["source"])));
    } catch (e) {
      deps.err(`check-youtube-audio: origem ${values["source"]} ilegível (${(e as Error).message})`);
      return 2;
    }
  }
  const missing = missingYouTubeCredentials(deps.env);
  if (missing.length) {
    deps.err(`check-youtube-audio: faltam ${missing.join(", ")} no ambiente (rode scripts/youtube-oauth-setup.ts)`);
    return 2;
  }
  let check: YouTubeAudioCheck;
  if (sourceHasAudio === false) {
    check = await checkYouTubeAudio(deps.upload, "", id, false);
  } else {
    let token: string;
    try {
      token = await refreshYouTubeAccessToken(deps.upload, {
        clientId: (deps.env.GOOGLE_CLIENT_ID ?? "").trim(),
        clientSecret: (deps.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
        refreshToken: (deps.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
        channelId: (deps.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
      });
    } catch (e) {
      deps.err(`check-youtube-audio: token do YouTube indisponível (${(e as Error).message})`);
      return 2;
    }
    check = await checkYouTubeAudio(deps.upload, token, id, sourceHasAudio);
  }
  deps.out(JSON.stringify({ video_id: id, audio_check: check }, null, 2));
  const alarm = flags.has("no-alarm") ? undefined : deps.alarm;
  await reportYouTubeAudioCheck(check, { videoId: id, url: `https://youtu.be/${id}`, label: `vídeo ${id}` }, deps.err, alarm);
  if (check.status === "ok") deps.err(`[ok] áudio do YouTube em ${id}: ${check.bitrate_bps} bps`);
  return audioCheckExitCode(check);
}

async function main(): Promise<number> {
  loadProjectEnv(ROOT);
  return runCheckYouTubeAudio(process.argv.slice(2), {
    upload: defaultYouTubeUploadDeps,
    env: process.env,
    readFile: (p) => readFileSync(p),
    alarm: (check, ctx) => notifyYouTubeAudioDegraded(check, ctx, { cwd: ROOT }),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}

if (isMainModule(import.meta.url)) {
  runCli(main, { errorCode: 2, onError: (e) => console.error("check-youtube-audio:", e instanceof Error ? e.message : e) });
}
