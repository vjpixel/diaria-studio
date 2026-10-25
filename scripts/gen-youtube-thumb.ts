/**
 * gen-youtube-thumb.ts (#10800)
 *
 * Gera as capas do YouTube da edição no padrão diar.ia.br (processo aprovado
 * pelo editor em 22/10/2026, comentários do #10800). Só a parte determinística:
 * os insumos com IA (retrato do editor pelo Codex + recorte `rembg`, outpaint
 * 16:9 do fundo, gancho derivado do D1) vêm prontos, conduzidos pela skill
 * `/diaria-youtube`. Não toca rede nem o YouTube.
 *
 * Horizontal → `{edição}/04-youtube-thumb.jpg` (1280x720, ≤ 2 MB), o arquivo
 * que `publish-youtube.ts` já envia via `thumbnails.set`:
 *   npx tsx scripts/gen-youtube-thumb.ts AAMMDD --hook "IA ladra?" --portrait retrato.png
 *     [--background fundo-16x9.png]   (default: {edição}/04-d1-2x1.jpg, com aviso de recorte)
 *     [--out PATH] [--edition-dir DIR]
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

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const USAGE =
  "uso: gen-youtube-thumb.ts AAMMDD --hook \"IA ladra?\" --portrait PNG [--background IMG] [--out PATH] [--edition-dir DIR]\n" +
  "     gen-youtube-thumb.ts AAMMDD --short-cover --at SEGUNDOS [--video MP4] [--out PATH] [--edition-dir DIR]";

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
  const root = fileURLToPath(new URL("../", import.meta.url));
  const rembg = spawnSync(join(root, ".venv-rembg", "Scripts", "python.exe"),
    [join(root, "scripts", "setup-rembg.py"), "--check"], { encoding: "utf8", timeout: 60_000 });
  if (rembg.error || rembg.status !== 0) {
    console.error(`gen-youtube-thumb: rembg ausente ou inválido. No Neo (Windows x64), execute: py -3.11 scripts/setup-rembg.py. Veja docs/setup.md. ${rembg.error?.message ?? rembg.stderr?.trim()}`);
    return 1;
  }
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
