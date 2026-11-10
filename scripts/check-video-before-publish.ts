#!/usr/bin/env node
/**
 * scripts/check-video-before-publish.ts (#10943, gate desde #12588)
 *
 * Pré-requisito do `/diaria-5-publicacao` (Passo 0b): sem o link do vídeo no
 * D1 (`_internal/05-video-url.txt`), sem a edição marcada sem vídeo
 * (`_internal/no-video.json`) e sem `--skip youtube`, a Etapa 5 para ANTES do
 * dispatch. Miolo em `lib/diaria/video-before-publish.ts`. Também para
 * com a edição marcada sem vídeo e o convite ainda no cache de imagens ou no
 * HTML final (`no-video-stale`, #12618), e só avisa quando o vídeo do link
 * pode não abrir para o leitor (`link-may-not-open`, #12598). O gate da
 * Etapa 6 roda o mesmo comando para repetir esse aviso.
 *
 * Uso:
 *   npx tsx scripts/check-video-before-publish.ts AAMMDD [--edition-dir DIR]
 *
 * Saída: JSON `{status, videoUrl, blocking, warning}` no stdout; com texto,
 * a linha `[halt]` (bloqueio) ou `[aviso]` no stderr.
 * Exit 0 = pode publicar; exit 3 = bloqueado (renderizar o halt banner com o
 * `warning`); exit 2 = uso inválido ou pasta da edição inexistente.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { assessVideoBeforePublish } from "./lib/diaria/video-before-publish.ts";

export const EXIT_BLOCKED = 3;

export function main(argv: string[] = process.argv.slice(2)): number {
  const { values, positional } = parseArgs(argv);
  const aammdd = positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error("uso: check-video-before-publish.ts AAMMDD [--edition-dir DIR]");
    return 2;
  }
  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  if (!existsSync(dir)) {
    console.error(`check-video-before-publish: ${dir} não existe`);
    return 2;
  }
  const result = assessVideoBeforePublish(dir, aammdd);
  if (result.warning) console.error(`[${result.blocking ? "halt" : "aviso"}] ${result.warning}`);
  console.log(JSON.stringify(result, null, 2));
  return result.blocking ? EXIT_BLOCKED : 0;
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(), {
    onError: (e) => console.error("check-video-before-publish:", e instanceof Error ? e.message : e),
  });
}
