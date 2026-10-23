#!/usr/bin/env node
/**
 * scripts/check-video-before-publish.ts (#10943)
 *
 * Aviso do `/diaria-5-publicacao` (Passo 0b): o D1 vai sair com o link do
 * vídeo do dia? Lê `_internal/05-video-url.txt` e
 * `_internal/05-youtube-published.json` da edição. Miolo em
 * `lib/diaria/video-before-publish.ts`.
 *
 * Uso:
 *   npx tsx scripts/check-video-before-publish.ts AAMMDD [--edition-dir DIR]
 *
 * Saída: JSON `{status, videoUrl, warning}` no stdout; com aviso, a linha
 * `[aviso] ...` no stderr. Exit 0 SEMPRE que a checagem roda (é aviso, não
 * gate: vídeo ausente nunca bloqueia a Etapa 5). Exit 2 só para uso inválido
 * ou pasta da edição inexistente.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { assessVideoBeforePublish } from "./lib/diaria/video-before-publish.ts";

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
  if (result.warning) console.error(`[aviso] ${result.warning}`);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(), {
    onError: (e) => console.error("check-video-before-publish:", e instanceof Error ? e.message : e),
  });
}
