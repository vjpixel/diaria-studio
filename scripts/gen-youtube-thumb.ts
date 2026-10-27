/**
 * gen-youtube-thumb.ts (#10800)
 *
 * Gera as capas do YouTube da edição no padrão diar.ia.br (processo aprovado
 * pelo editor em 22/10/2026, comentários do #10800). Só a parte determinística:
 * os insumos com IA (retrato do editor pelo Codex + recorte `rembg`, outpaint
 * 16:9 do fundo, gancho derivado do D1) vêm prontos, conduzidos pela skill
 * `/diaria-publica-video` (Parte A). Nunca toca o YouTube; só o modo
 * `--frames-from-drive` lê o Drive (leitura, OAuth do projeto).
 *
 * Horizontal → `{edição}/04-youtube-thumb.jpg` (1280x720, ≤ 2 MB), o arquivo
 * que `publish-youtube.ts` já envia via `thumbnails.set`:
 *   npx tsx scripts/gen-youtube-thumb.ts AAMMDD --hook "IA ladra?" --portrait retrato.png
 *     [--background fundo-16x9.png]   (default: {edição}/04-d1-2x1.jpg, com aviso de recorte)
 *     [--enhance-portrait]            (contraste +25%, nitidez, saturação leve, alfa preservado, #11228)
 *     [--out PATH] [--edition-dir DIR]
 *   Gancho de 2 a 4 palavras no canto SUPERIOR direito (#11220), encolhido
 *   para não invadir a cabeça do retrato (#11228).
 *
 * Opções de retrato a partir do BRUTO 4K no Drive (#11228), sem baixar o vídeo:
 *   npx tsx scripts/gen-youtube-thumb.ts AAMMDD --frames-from-drive FILE_ID [--count 5 | --times 12,30.5,48]
 *     → `_internal/youtube-thumb-frames/frame-{N}.png` + a folha numerada `opcoes.jpg`
 *       (mostrar ao editor; ele escolhe o número)
 *   npx tsx scripts/gen-youtube-thumb.ts AAMMDD --pick-frame N
 *     → copia o frame N para `_internal/youtube-thumb-frames/escolhido.png`
 *       (entrada do recorte rembg, que gera o `--portrait`)
 *   Bruto espelhado (#11378): os dois modos aplicam o `mirrored` em vigor, com
 *   a precedência da `/diaria-video-montagem` — `--mirrored`/`--no-mirrored` >
 *   `_internal/video-montagem/blocks.json` > `source.json` > true. O
 *   `--frames-from-drive` extrai com `hflip` e grava `frames.json`; o
 *   `--pick-frame` só espelha se o aplicado na extração diferir do em vigor.
 *   As flags vão depois do AAMMDD.
 *
 * Short → `{edição}/04-youtube-short-capa.jpg`, um frame do vertical dentro
 * da janela do lettering do título (0–3,5 s):
 *   npx tsx scripts/gen-youtube-thumb.ts AAMMDD --short-cover --at 1.8
 *     [--video PATH]   (default: {edição}/diaria-comentada-{AAMMDD}-short.mp4)
 *     [--out PATH] [--edition-dir DIR]
 *
 * Saída: o caminho gravado no stdout; avisos no stderr com `[aviso]`.
 * Georgia precisa existir na máquina (guard `assertBrandSerifAvailable`, #4090).
 */

import { copyFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { assertBrandSerifAvailable } from "./lib/shared/assert-brand-font.ts";
import { YOUTUBE_THUMB_FILE } from "./lib/diaria/youtube-video.ts";
import {
  YOUTUBE_SHORT_COVER_FILE,
  composeYouTubeThumb,
  planShortCoverFrame,
} from "./lib/diaria/youtube-thumb.ts";
import sharp from "sharp";
import {
  THUMB_FRAMES_DIR,
  THUMB_FRAMES_META,
  THUMB_FRAMES_SHEET,
  THUMB_FRAME_PICKED,
  buildFrameSheet,
  frameTimes,
  pickFrameNeedsFlop,
  planDriveFrameArgs,
  redactFfmpegArgs,
  resolveThumbMirrored,
  thumbFrameFileName,
  type MirroredOrigin,
  type ThumbFramesMeta,
} from "./lib/diaria/youtube-thumb-frames.ts";

const USAGE =
  "uso: gen-youtube-thumb.ts AAMMDD --hook \"IA ladra?\" --portrait PNG [--background IMG] [--enhance-portrait] [--out PATH] [--edition-dir DIR]\n" +
  "     gen-youtube-thumb.ts AAMMDD --frames-from-drive FILE_ID [--count N | --times T1,T2,...] [--mirrored | --no-mirrored] [--edition-dir DIR]\n" +
  "     gen-youtube-thumb.ts AAMMDD --pick-frame N [--mirrored | --no-mirrored] [--edition-dir DIR]\n" +
  "     gen-youtube-thumb.ts AAMMDD --short-cover --at SEGUNDOS [--video MP4] [--out PATH] [--edition-dir DIR]";

/**
 * #11228: extrai N frames do vídeo BRUTO direto da Drive API (sem baixar o
 * arquivo) e monta a folha de opções numerada. Só leitura no Drive.
 */
async function framesFromDrive(
  dir: string,
  fileId: string,
  values: Record<string, string>,
  mirror: { mirrored: boolean; from: MirroredOrigin },
): Promise<number> {
  const { getAccessToken } = await import("./google-auth.ts");
  const { gFetchRetry } = await import("./lib/drive-helpers.ts");
  const { DRIVE_API } = await import("./lib/drive-constants.ts");
  const token = await getAccessToken();
  const params = new URLSearchParams({ fields: "id,name,mimeType,videoMediaMetadata(durationMillis,width,height)", supportsAllDrives: "true" });
  const res = await gFetchRetry(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    console.error(`gen-youtube-thumb: metadado do arquivo ${fileId} no Drive falhou (HTTP ${res.status}) — confira o id e o acesso da conta OAuth do projeto (oauth-setup.ts)`);
    return 1;
  }
  const meta = (await res.json()) as { name?: string; mimeType?: string; videoMediaMetadata?: { durationMillis?: string; width?: number; height?: number } };
  if (!meta.mimeType?.startsWith("video/")) {
    console.error(`gen-youtube-thumb: ${fileId} (${meta.name ?? "?"}) não é vídeo (mimeType ${meta.mimeType ?? "?"})`);
    return 1;
  }
  const durationMs = Number(meta.videoMediaMetadata?.durationMillis);
  const durationS = Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : null;
  const count = values["count"] !== undefined ? Number(values["count"]) : undefined;
  const times = frameTimes(durationS, { count, explicit: values["times"] });

  const outDir = join(dir, THUMB_FRAMES_DIR);
  mkdirSync(outDir, { recursive: true });
  const frames: { n: number; at: number; path: string }[] = [];
  for (const [i, at] of times.entries()) {
    const out = join(outDir, thumbFrameFileName(i + 1));
    const args = planDriveFrameArgs({ fileId, accessToken: token, atSeconds: at, out, mirrored: mirror.mirrored });
    const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 5 * 60_000 });
    if (r.error || r.status !== 0 || !existsSync(out)) {
      console.error(
        `gen-youtube-thumb: ffmpeg falhou no frame ${i + 1} (${at}s): ${r.error?.message ?? r.stderr?.trim() ?? `exit ${r.status}`}\n` +
          `  comando: ffmpeg ${redactFfmpegArgs(args).join(" ")}`,
      );
      return 1;
    }
    frames.push({ n: i + 1, at, path: out });
  }
  const framesMeta: ThumbFramesMeta = { mirrored_applied: mirror.mirrored, mirrored_from: mirror.from };
  writeFileAtomic(join(outDir, THUMB_FRAMES_META), JSON.stringify(framesMeta, null, 2) + "\n");
  const sheet = join(outDir, THUMB_FRAMES_SHEET);
  writeFileAtomic(sheet, await buildFrameSheet(frames.map((f) => readFileSync(f.path))));
  console.error(`[ok] ${frames.length} opções de ${meta.name ?? fileId} (${meta.videoMediaMetadata?.width ?? "?"}x${meta.videoMediaMetadata?.height ?? "?"}) — mostre ${sheet} ao editor e rode --pick-frame N com o número escolhido`);
  console.log(JSON.stringify({ source: { id: fileId, name: meta.name ?? null, duration_s: durationS }, mirrored: mirror, sheet, frames }, null, 2));
  return 0;
}

/** Estado da `/diaria-video-montagem` na edição (o `stateDir` default dela). */
const MONTAGEM_STATE_DIR = join("_internal", "video-montagem");

/** JSON opcional: ausente → undefined; ilegível → erro (nunca default silencioso). */
function readOptionalJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} ilegível (${e instanceof Error ? e.message : e}): corrija, ou passe --mirrored/--no-mirrored`);
  }
}

/**
 * #11378: o `mirrored` em vigor para os frames da capa — a flag, ou o
 * `blocks.json`/`source.json` da montagem desta edição, ou o default dela.
 */
function thumbMirrored(dir: string, flags: Set<string>, values: Record<string, string>): { mirrored: boolean; from: MirroredOrigin } {
  for (const k of ["mirrored", "no-mirrored"]) {
    if (values[k] !== undefined) throw new Error(`--${k} não leva valor (recebeu ${JSON.stringify(values[k])}): ponha a flag depois do AAMMDD`);
  }
  if (flags.has("mirrored") && flags.has("no-mirrored")) throw new Error("--mirrored e --no-mirrored juntos");
  const flag = flags.has("mirrored") ? true : flags.has("no-mirrored") ? false : undefined;
  if (flag !== undefined) return resolveThumbMirrored({ flag });
  const state = join(dir, MONTAGEM_STATE_DIR);
  return resolveThumbMirrored({
    blocks: readOptionalJson(join(state, "blocks.json")),
    source: readOptionalJson(join(state, "source.json")),
  });
}

/** Vídeo vertical da edição (convenção usada em 261022). */
export function youtubeShortVideoFileName(aammdd: string): string {
  return `diaria-comentada-${aammdd}-short.mp4`;
}

async function main(): Promise<number> {
  const { flags, values, positional } = parseArgs(process.argv.slice(2));
  const aammdd = values["edition"] ?? positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error(USAGE);
    return 2;
  }
  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));

  if (values["frames-from-drive"] !== undefined || flags.has("frames-from-drive")) {
    const fileId = values["frames-from-drive"]?.trim();
    if (!fileId) {
      console.error("gen-youtube-thumb: --frames-from-drive exige o FILE_ID do vídeo bruto no Drive");
      return 2;
    }
    const mirror = thumbMirrored(dir, flags, values);
    console.error(`[video] mirrored=${mirror.mirrored} (${mirror.from})${mirror.mirrored ? ": frames desespelhados (hflip)" : ""}`);
    return framesFromDrive(dir, fileId, values, mirror);
  }

  if (values["pick-frame"] !== undefined || flags.has("pick-frame")) {
    const n = Number(values["pick-frame"]);
    if (!Number.isInteger(n) || n < 1) {
      console.error("gen-youtube-thumb: --pick-frame exige o número da opção (1, 2, ...) da folha opcoes.jpg");
      return 2;
    }
    const src = join(dir, THUMB_FRAMES_DIR, thumbFrameFileName(n));
    if (!existsSync(src)) {
      console.error(`gen-youtube-thumb: ${src} não existe — rode antes --frames-from-drive FILE_ID`);
      return 1;
    }
    const dst = join(dir, THUMB_FRAMES_DIR, THUMB_FRAME_PICKED);
    // #11378: frames do --frames-from-drive já saem desespelhados (frames.json);
    // frames sem esse metadado (anteriores) são desespelhados aqui.
    const mirror = thumbMirrored(dir, flags, values);
    const framesMeta = readOptionalJson(join(dir, THUMB_FRAMES_DIR, THUMB_FRAMES_META)) as ThumbFramesMeta | undefined;
    if (pickFrameNeedsFlop(mirror.mirrored, framesMeta ?? null)) {
      writeFileAtomic(dst, await sharp(readFileSync(src)).flop().png().toBuffer());
      console.error(`[video] mirrored=${mirror.mirrored} (${mirror.from}): frame ${n} espelhado horizontalmente na escolha`);
    } else {
      copyFileSync(src, dst);
    }
    console.log(dst);
    return 0;
  }

  if (flags.has("short-cover")) {
    const at = Number(values["at"]);
    if (values["at"] === undefined) {
      console.error("gen-youtube-thumb: --short-cover exige --at SEGUNDOS (frame com o lettering do título, 0–3,5 s)");
      return 2;
    }
    const video = resolve(values["video"] ?? join(dir, youtubeShortVideoFileName(aammdd)));
    if (!existsSync(video)) {
      console.error(`gen-youtube-thumb: vídeo vertical não encontrado em ${video} (passe --video)`);
      return 1;
    }
    const out = resolve(values["out"] ?? join(dir, YOUTUBE_SHORT_COVER_FILE));
    const plan = planShortCoverFrame(video, at, out);
    for (const w of plan.warnings) console.error(`[aviso] ${w}`);
    mkdirSync(dirname(out), { recursive: true });
    const r = spawnSync("ffmpeg", plan.args, { encoding: "utf8" });
    if (r.error || r.status !== 0 || !existsSync(out)) {
      console.error(`gen-youtube-thumb: ffmpeg falhou: ${r.error?.message ?? r.stderr?.trim() ?? `exit ${r.status}`}`);
      return 1;
    }
    console.log(out);
    return 0;
  }

  const hook = values["hook"];
  const portraitPath = values["portrait"];
  if (!hook || !portraitPath) {
    console.error("gen-youtube-thumb: a capa horizontal exige --hook e --portrait (retrato recortado, PNG com transparência)");
    console.error(USAGE);
    return 2;
  }
  const backgroundPath = resolve(values["background"] ?? join(dir, "04-d1-2x1.jpg"));
  // #11162: sem checagem do venv do rembg aqui. Este script só consome o
  // --portrait JÁ recortado; quem exige o ambiente é o passo de recorte
  // (`setup-rembg.py --input/--output` chama `check()` antes de recortar).
  // A garantia de que o recorte rodou é a recusa de retrato sem transparência
  // em `composeYouTubeThumb`, que vale em qualquer máquina.
  for (const p of [resolve(portraitPath), backgroundPath]) {
    if (!existsSync(p)) {
      console.error(`gen-youtube-thumb: ${p} não existe`);
      return 1;
    }
  }

  await assertBrandSerifAvailable("gen-youtube-thumb");
  const { jpeg, warnings } = await composeYouTubeThumb({
    background: readFileSync(backgroundPath),
    portrait: readFileSync(resolve(portraitPath)),
    hook,
    enhancePortrait: flags.has("enhance-portrait"),
  });
  for (const w of warnings) console.error(`[aviso] ${w}`);
  const out = resolve(values["out"] ?? join(dir, YOUTUBE_THUMB_FILE));
  mkdirSync(dirname(out), { recursive: true });
  writeFileAtomic(out, jpeg);
  console.log(out);
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("gen-youtube-thumb:", e instanceof Error ? e.message : e) });
}
