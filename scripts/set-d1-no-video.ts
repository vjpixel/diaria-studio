/**
 * scripts/set-d1-no-video.ts (#11125)
 *
 * Marca (ou desmarca) uma edição como "sem vídeo": o D1 da newsletter sai com
 * o hero puro, sem o convite "Clique e assista a notícia comentada" e sem link
 * pro vídeo/canal. Ver `scripts/lib/diaria/d1-no-video.ts`.
 *
 * Uso:
 *   npx tsx scripts/set-d1-no-video.ts AAMMDD [--reason "texto"] [--edition-dir DIR]
 *   npx tsx scripts/set-d1-no-video.ts AAMMDD --clear [--edition-dir DIR]
 *
 * Marcar já apaga a cópia `04-d1-2x1-play.jpg` e o carimbo
 * `_internal/04-d1-play.json` que sobraram. A chave `d1_play` de
 * `06-public-images.json` sai no próximo `upload-images-public.ts --mode
 * newsletter`, e o HTML precisa ser re-renderizado (Stage 4) para refletir.
 * Só mexe em arquivos locais da edição; não publica nada.
 *
 * Exit: 0 ok · 1 diretório da edição ausente · 2 uso inválido.
 */

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { clearNoVideo, markNoVideo } from "./lib/diaria/d1-no-video.ts";
import { D1_PLAY_HERO_FILE, D1_PLAY_STAMP_FILE } from "./lib/diaria/d1-video-hero.ts";

export function main(argv: string[] = process.argv.slice(2)): number {
  const { flags, values, positional } = parseArgs(argv);
  const aammdd = positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error('uso: set-d1-no-video.ts AAMMDD [--clear] [--reason "texto"] [--edition-dir DIR]');
    return 2;
  }
  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  if (!existsSync(dir)) {
    console.error(`set-d1-no-video: ${dir} não existe`);
    return 1;
  }
  if (flags.has("clear")) {
    const had = clearNoVideo(dir);
    console.error(
      had
        ? `[ok] marcador removido — rode upload-images-public.ts --mode newsletter para regerar o convite do D1 e re-renderize`
        : `[ok] a edição não estava marcada como sem vídeo — nada a fazer`,
    );
    return 0;
  }
  const p = markNoVideo(dir, values["reason"]);
  rmSync(join(dir, D1_PLAY_HERO_FILE), { force: true });
  rmSync(join(dir, D1_PLAY_STAMP_FILE), { force: true });
  console.error(
    `[ok] ${p} gravado — D1 sem convite de vídeo. Próximo passo: upload-images-public.ts --mode newsletter (tira d1_play do cache) e re-render do HTML`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(), { onError: (e) => console.error("set-d1-no-video:", e instanceof Error ? e.message : e) });
}
