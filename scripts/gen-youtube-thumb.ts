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
 *     [--layout bottom|top]           (default bottom = padrão da 261021, #11942)
 *     [--enhance-portrait]            (contraste +25%, nitidez, saturação leve, alfa preservado, #11228)
 *     [--out PATH] [--edition-dir DIR]
 *   Layout `bottom` (#11942, default): close-up grande à esquerda, gancho no
 *   canto INFERIOR direito (pode cobrir o ombro, nunca mais que isso),
 *   gradiente na base e vinheta. Layout `top` (#11220): gancho de 2 a 4
 *   palavras no canto SUPERIOR direito, encolhido
 *   para não invadir a cabeça do retrato (#11228). Gancho em 2 linhas
 *   alinhadas à direita (#11740): quebra explícita com `|` (ou `\n`), até 4
 *   palavras por linha — `--hook "Confiou no chatbot|e morreu"`.
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
 *   Sem o bruto no Drive (#11532): `--frames-from-drive FILE_ID --from-final`
 *   com o id do horizontal exportado em `Final/` (o que `fetch-drive-video.ts
 *   --orientation horizontal --dry-run` lista). Fallback explícito: não
 *   espelha (a exportação já vem desespelhada), avisa da resolução menor, e o
 *   `--pick-frame` desses frames nunca espelha.
 *
 * Retrato em close-up pelo Codex (#11942), com o frame escolhido só como
 * referência de identidade e a expressão variando:
 *   npx tsx scripts/gen-youtube-thumb.ts AAMMDD --portrait-prompts [--expressions desconfiado,surpreso,preocupado] [--ref IMG]
 *     → `_internal/youtube-thumb-portraits/prompt-{N}.json` + os comandos
 *       `node scripts/codex-image.js` de cada opção (o script não chama o Codex)
 *   npx tsx scripts/gen-youtube-thumb.ts AAMMDD --portrait-sheet
 *     → a folha numerada `opcoes.jpg` com as opções geradas (mostrar ao editor)
 *   npx tsx scripts/gen-youtube-thumb.ts AAMMDD --pick-portrait N
 *     → copia a opção N para `escolhido.jpg` (entrada do recorte rembg)
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
  parseThumbLayout,
  planShortCoverFrame,
} from "./lib/diaria/youtube-thumb.ts";
import {
  THUMB_PORTRAITS_DIR,
  THUMB_PORTRAITS_META,
  THUMB_PORTRAITS_SHEET,
  THUMB_PORTRAIT_PICKED,
  buildPortraitPrompt,
  parseExpressions,
  portraitOptionFileName,
  portraitPromptFileName,
  type PortraitsMeta,
} from "./lib/diaria/youtube-thumb-portrait.ts";
import sharp from "sharp";
import {
  THUMB_FRAMES_DIR,
  THUMB_FRAMES_META,
  THUMB_FRAMES_SHEET,
  THUMB_FRAME_PICKED,
  buildFrameSheet,
  frameTimes,
  framesSourceWarnings,
  pickFrameNeedsFlop,
  planDriveFrameArgs,
  redactFfmpegArgs,
  resolveThumbMirrored,
  thumbFrameFileName,
  type MirroredOrigin,
  type ThumbFramesMeta,
} from "./lib/diaria/youtube-thumb-frames.ts";

const USAGE =
  "uso: gen-youtube-thumb.ts AAMMDD --hook \"IA ladra?\" (2 linhas: \"Confiou no chatbot|e morreu\") --portrait PNG [--background IMG] [--layout bottom|top] [--enhance-portrait] [--out PATH] [--edition-dir DIR]\n" +
  "     gen-youtube-thumb.ts AAMMDD --frames-from-drive FILE_ID [--from-final] [--count N | --times T1,T2,...] [--mirrored | --no-mirrored] [--edition-dir DIR]\n" +
  "     gen-youtube-thumb.ts AAMMDD --pick-frame N [--mirrored | --no-mirrored] [--edition-dir DIR]\n" +
  "     gen-youtube-thumb.ts AAMMDD --portrait-prompts [--expressions desconfiado,surpreso,preocupado] [--ref IMG] [--edition-dir DIR]\n" +
  "     gen-youtube-thumb.ts AAMMDD --portrait-sheet [--edition-dir DIR]\n" +
  "     gen-youtube-thumb.ts AAMMDD --pick-portrait N [--edition-dir DIR]\n" +
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
  fromFinal = false,
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
  for (const w of framesSourceWarnings({ fromFinal, width: meta.videoMediaMetadata?.width, height: meta.videoMediaMetadata?.height })) {
    console.error(`[aviso] ${w}`);
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
function thumbMirrored(dir: string, flags: Set<string>, values: Record<string, string>, fromFinal = false): { mirrored: boolean; from: MirroredOrigin } {
  for (const k of ["mirrored", "no-mirrored"]) {
    if (values[k] !== undefined) throw new Error(`--${k} não leva valor (recebeu ${JSON.stringify(values[k])}): ponha a flag depois do AAMMDD`);
  }
  if (flags.has("mirrored") && flags.has("no-mirrored")) throw new Error("--mirrored e --no-mirrored juntos");
  const flag = flags.has("mirrored") ? true : flags.has("no-mirrored") ? false : undefined;
  if (flag !== undefined) return resolveThumbMirrored({ flag });
  if (fromFinal) return resolveThumbMirrored({ final: true });
  const state = join(dir, MONTAGEM_STATE_DIR);
  return resolveThumbMirrored({
    blocks: readOptionalJson(join(state, "blocks.json")),
    source: readOptionalJson(join(state, "source.json")),
  });
}

/**
 * #11942: grava um prompt do `codex-image.js` por expressão (o frame escolhido
 * como referência de identidade) e imprime os comandos de geração.
 */
function portraitPrompts(dir: string, values: Record<string, string>): number {
  const expressions = parseExpressions(values["expressions"]);
  const ref = resolve(values["ref"] ?? join(dir, THUMB_FRAMES_DIR, THUMB_FRAME_PICKED));
  if (!existsSync(ref)) {
    console.error(`gen-youtube-thumb: frame de referência ${ref} não existe — rode antes --frames-from-drive e --pick-frame N (ou passe --ref IMG)`);
    return 1;
  }
  const outDir = join(dir, THUMB_PORTRAITS_DIR);
  mkdirSync(outDir, { recursive: true });
  const options = expressions.map((expression, i) => {
    const n = i + 1;
    const prompt = join(outDir, portraitPromptFileName(n));
    const out = join(outDir, portraitOptionFileName(n));
    writeFileAtomic(prompt, JSON.stringify(buildPortraitPrompt(expression, ref), null, 2) + "\n");
    return { n, expression, prompt, out, command: `node scripts/codex-image.js ${prompt} ${out}` };
  });
  const meta: PortraitsMeta = { reference: ref, expressions };
  writeFileAtomic(join(outDir, THUMB_PORTRAITS_META), JSON.stringify(meta, null, 2) + "\n");
  console.error(`[ok] ${options.length} prompts de retrato (${expressions.join(", ")}) — gere cada um com o comando do JSON e depois rode --portrait-sheet`);
  console.log(JSON.stringify({ reference: ref, options }, null, 2));
  return 0;
}

/** #11942: folha numerada das opções de retrato geradas, para o editor escolher. */
async function portraitSheet(dir: string): Promise<number> {
  const outDir = join(dir, THUMB_PORTRAITS_DIR);
  const meta = readOptionalJson(join(outDir, THUMB_PORTRAITS_META)) as PortraitsMeta | undefined;
  if (!meta || !Array.isArray(meta.expressions) || meta.expressions.length === 0) {
    console.error(`gen-youtube-thumb: ${join(outDir, THUMB_PORTRAITS_META)} ausente ou vazio — rode antes --portrait-prompts`);
    return 1;
  }
  const paths = meta.expressions.map((_, i) => join(outDir, portraitOptionFileName(i + 1)));
  const missing = paths.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    console.error(`gen-youtube-thumb: faltam opções geradas pelo Codex: ${missing.join(", ")} — rode os comandos do --portrait-prompts`);
    return 1;
  }
  const sheet = join(outDir, THUMB_PORTRAITS_SHEET);
  writeFileAtomic(sheet, await buildFrameSheet(paths.map((p) => readFileSync(p))));
  console.error(`[ok] folha com ${paths.length} retratos (${meta.expressions.map((e, i) => `${i + 1}=${e}`).join(", ")}) — mostre ${sheet} ao editor e rode --pick-portrait N`);
  console.log(sheet);
  return 0;
}

/** #11942: copia a opção de retrato escolhida pelo editor para `escolhido.jpg` (entrada do rembg). */
function pickPortrait(dir: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error("gen-youtube-thumb: --pick-portrait exige o número da opção (1, 2, ...) da folha de retratos");
    return 2;
  }
  const outDir = join(dir, THUMB_PORTRAITS_DIR);
  const src = join(outDir, portraitOptionFileName(n));
  if (!existsSync(src)) {
    console.error(`gen-youtube-thumb: ${src} não existe — gere as opções com --portrait-prompts + codex-image.js`);
    return 1;
  }
  const dst = join(outDir, THUMB_PORTRAIT_PICKED);
  copyFileSync(src, dst);
  console.log(dst);
  return 0;
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
    // #11532: --from-final = o FILE_ID é o horizontal exportado em Final/
    // (fallback sem o bruto no Drive): não espelha e avisa da resolução menor.
    const fromFinal = flags.has("from-final");
    if (values["from-final"] !== undefined) throw new Error(`--from-final não leva valor (recebeu ${JSON.stringify(values["from-final"])}): ponha a flag depois do AAMMDD`);
    const mirror = thumbMirrored(dir, flags, values, fromFinal);
    console.error(`[video] mirrored=${mirror.mirrored} (${mirror.from})${mirror.mirrored ? ": frames desespelhados (hflip)" : ""}`);
    return framesFromDrive(dir, fileId, values, mirror, fromFinal);
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

  // #11942: opções de retrato em close-up pelo Codex, com o frame escolhido
  // como referência de identidade e a expressão variando.
  for (const k of ["portrait-prompts", "portrait-sheet"]) {
    if (values[k] !== undefined) throw new Error(`--${k} não leva valor (recebeu ${JSON.stringify(values[k])}): ponha a flag depois do AAMMDD`);
  }
  if (flags.has("portrait-prompts")) return portraitPrompts(dir, values);
  if (flags.has("portrait-sheet")) return portraitSheet(dir);
  if (values["pick-portrait"] !== undefined || flags.has("pick-portrait")) return pickPortrait(dir, values["pick-portrait"]);

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
  // #11942: valida o layout antes de qualquer trabalho (default `bottom`, o padrão da 261021).
  if (flags.has("layout")) throw new Error("--layout exige o valor: bottom (default) ou top");
  const layout = parseThumbLayout(values["layout"]);
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
    layout,
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
