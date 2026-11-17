/**
 * check-youtube-audio.ts (#13403) — o áudio que o YouTube registrou do vídeo está bom?
 *
 * Checagem sob demanda do guard pós-upload (`scripts/lib/diaria/youtube-audio-check.ts`).
 * O `publish-youtube.ts --upload` e o `publish-shorts.ts --publish` já leem
 * `fileDetails`, mas logo depois do upload o processamento quase sempre ainda
 * não terminou (`audio_check.status: "pending"`): este script relê quando
 * terminar. Só LÊ o YouTube (`videos.list?part=fileDetails,processingDetails`,
 * 1 unidade de quota, token do canal `YOUTUBE_*`).
 *
 * Com `--edition AAMMDD`, regrava o `audio_check` no registro da edição, sob o
 * lock do arquivo: `_internal/05-youtube-published.json` (horizontal) ou a
 * entrada `youtube_shorts` de `_internal/06-shorts-published.json` (vertical).
 * `--part` escolhe; sem ele, a parte é a do registro cujo vídeo tem este id.
 * No áudio degradado, depois de gravar, abre o alarme ao editor (issue
 * `youtube-audio-degraded`, `notifyEditor`), salvo `--no-alarm`.
 *
 * Uso:
 *   npx tsx scripts/check-youtube-audio.ts --id VIDEO_ID
 *   npx tsx scripts/check-youtube-audio.ts --id VIDEO_ID --edition AAMMDD [--part horizontal|vertical]
 *   npx tsx scripts/check-youtube-audio.ts --id VIDEO_ID --source Final/vertical.mp4   (origem sem áudio = nada a conferir)
 *   npx tsx scripts/check-youtube-audio.ts --id VIDEO_ID --no-alarm
 *   (--edition-dir DIR troca a pasta da edição: testes / edição fora do lugar)
 *
 * Saída: JSON no stdout (`audio_check`, e `record` quando gravou). Exit 0 =
 * áudio ok (ou origem sem áudio); 1 = degradado; 3 = processamento ainda não
 * terminou (rodar de novo mais tarde); 2 = uso errado, credencial ausente,
 * falha de leitura ou registro não regravado.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  alarmYouTubeAudioDegraded,
  checkYouTubeAudio,
  describeYouTubeAudioCheck,
  mp4HasAudioTrack,
  notifyYouTubeAudioDegraded,
  writeYouTubeRecordAudioCheck,
  type YouTubeAudioAlarmFn,
  type YouTubeAudioCheck,
} from "./lib/diaria/youtube-audio-check.ts";
import { readShortsRegistry, shortsRegistryPath, updateShortEntry } from "./lib/diaria/shorts-published-store.ts";
import {
  YOUTUBE_PUBLISHED_FILE,
  defaultYouTubeUploadDeps,
  missingYouTubeCredentials,
  refreshYouTubeAccessToken,
  type YouTubeUploadDeps,
} from "./lib/diaria/youtube-upload.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "uso: check-youtube-audio.ts --id VIDEO_ID [--edition AAMMDD [--part horizontal|vertical] [--edition-dir DIR]] [--source MP4] [--no-alarm]";
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export type AudioCheckPart = "horizontal" | "vertical";

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

/** Qual registro da edição tem este vídeo. null = nenhum. Lê só, nunca grava. */
export function inferAudioCheckPart(dir: string, aammdd: string, videoId: string): AudioCheckPart | null {
  const horizontal = join(dir, YOUTUBE_PUBLISHED_FILE);
  if (existsSync(horizontal)) {
    try {
      const rec = JSON.parse(readFileSync(horizontal, "utf8")) as { videoId?: unknown };
      if (rec?.videoId === videoId) return "horizontal";
    } catch {
      // ilegível: tenta o vertical
    }
  }
  try {
    const reg = readShortsRegistry(dir, aammdd);
    if (reg.entries.some((e) => e.destination === "youtube_shorts" && e.id === videoId)) return "vertical";
  } catch {
    // sem registro do vertical
  }
  return null;
}

/** Regrava `audio_check` no registro da parte. Lança se o registro não for deste vídeo. */
export function persistAudioCheck(dir: string, aammdd: string, part: AudioCheckPart, videoId: string, check: YouTubeAudioCheck): string {
  if (part === "horizontal") {
    const path = join(dir, YOUTUBE_PUBLISHED_FILE);
    writeYouTubeRecordAudioCheck(path, aammdd, videoId, check);
    return path;
  }
  updateShortEntry(dir, aammdd, "main", "youtube_shorts", (entry) => {
    if (entry.id !== videoId) throw new Error(`a entrada youtube_shorts é de outro vídeo (${entry.id})`);
    return { ...entry, audio_check: check };
  });
  return shortsRegistryPath(dir, "main");
}

export interface CheckYouTubeAudioCliDeps {
  upload: YouTubeUploadDeps;
  env: Record<string, string | undefined>;
  readFile: (p: string) => Buffer;
  alarm: YouTubeAudioAlarmFn;
  /** Pasta da edição a partir do AAMMDD (produção: `data/editions/AAMM/AAMMDD`). */
  editionDir: (aammdd: string) => string;
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
  const aammdd = values["edition"]?.trim();
  if (aammdd !== undefined && !/^\d{6}$/.test(aammdd)) {
    deps.err(`check-youtube-audio: --edition ${JSON.stringify(aammdd)} inválido (AAMMDD)\n${USAGE}`);
    return 2;
  }
  const partArg = values["part"];
  if (partArg !== undefined && partArg !== "horizontal" && partArg !== "vertical") {
    deps.err(`check-youtube-audio: --part ${JSON.stringify(partArg)} inválido (horizontal ou vertical)\n${USAGE}`);
    return 2;
  }
  if ((partArg || values["edition-dir"]) && !aammdd) {
    deps.err(`check-youtube-audio: --part e --edition-dir pedem --edition\n${USAGE}`);
    return 2;
  }
  let target: { dir: string; aammdd: string; part: AudioCheckPart } | null = null;
  if (aammdd) {
    const dir = values["edition-dir"] ? resolve(values["edition-dir"]) : deps.editionDir(aammdd);
    const part = (partArg as AudioCheckPart | undefined) ?? inferAudioCheckPart(dir, aammdd, id);
    if (!part) {
      deps.err(`check-youtube-audio: nenhum registro da edição ${aammdd} tem o vídeo ${id} (${dir}); passe --part horizontal|vertical`);
      return 2;
    }
    target = { dir, aammdd, part };
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
  let check: YouTubeAudioCheck;
  if (sourceHasAudio === false) {
    check = await checkYouTubeAudio(deps.upload, "", id, false);
  } else {
    const missing = missingYouTubeCredentials(deps.env);
    if (missing.length) {
      deps.err(`check-youtube-audio: faltam ${missing.join(", ")} no ambiente (rode scripts/youtube-oauth-setup.ts)`);
      return 2;
    }
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
  let recordPath: string | null = null;
  let recordError: string | null = null;
  if (target) {
    try {
      recordPath = persistAudioCheck(target.dir, target.aammdd, target.part, id, check);
    } catch (e) {
      recordError = (e as Error).message;
    }
  }
  deps.out(JSON.stringify({ video_id: id, audio_check: check, ...(recordPath ? { record: recordPath } : {}) }, null, 2));
  const line = describeYouTubeAudioCheck(check, id, target?.aammdd);
  if (line) deps.err(line);
  if (check.status === "ok") deps.err(`[ok] áudio do YouTube em ${id}: ${check.bitrate_bps} bps`);
  if (recordPath) deps.err(`[ok] audio_check gravado em ${recordPath}`);
  if (recordError) deps.err(`[aviso] audio_check NÃO gravado no registro: ${recordError}`);
  // O alarme sai depois da gravação (ou da tentativa).
  const label = target ? `${target.part === "horizontal" ? "horizontal" : "vertical (Short)"} da edição ${target.aammdd}` : `vídeo ${id}`;
  const url = target?.part === "vertical" ? `https://youtube.com/shorts/${id}` : `https://youtu.be/${id}`;
  if (!flags.has("no-alarm")) await alarmYouTubeAudioDegraded(check, { videoId: id, url, label }, deps.alarm, deps.err);
  const code = audioCheckExitCode(check);
  return recordError && code === 0 ? 2 : code;
}

async function main(): Promise<number> {
  loadProjectEnv(ROOT);
  return runCheckYouTubeAudio(process.argv.slice(2), {
    upload: defaultYouTubeUploadDeps,
    env: process.env,
    readFile: (p) => readFileSync(p),
    alarm: (check, ctx) => notifyYouTubeAudioDegraded(check, ctx, { cwd: ROOT }),
    editionDir: (aammdd) => resolve(ROOT, editionDirFor(aammdd)),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}

if (isMainModule(import.meta.url)) {
  runCli(main, { errorCode: 2, onError: (e) => console.error("check-youtube-audio:", e instanceof Error ? e.message : e) });
}
