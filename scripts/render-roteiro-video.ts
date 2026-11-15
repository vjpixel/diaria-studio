#!/usr/bin/env node
/**
 * scripts/render-roteiro-video.ts (#13120)
 *
 * Gera a página do roteiro do vídeo (`_internal/roteiro-d1.html`) a partir do
 * `_internal/roteiro-falas.json` da edição, em vez de a skill
 * `/diaria-video-roteiro` escrever o HTML à mão. Com uma fonte só, os boxes
 * "Na tela", os cortes e as cópias de cada fala nos três vídeos nunca
 * divergem do JSON que a montagem e a publicação leem. Layout e regras:
 * `scripts/lib/diaria/roteiro-pagina.ts`.
 *
 * O JSON é validado antes (o mesmo `validarRoteiroFalas` do
 * `video-roteiro-blocos.ts`); inválido = exit 2, nada gravado. Os `[aviso]` do
 * validador (gancho, título, capa, duração) saem no stderr, sem mudar o exit.
 *
 * O link do artefato (`<!-- artifact: URL -->`, 1ª linha) é preservado da
 * página que já existe no destino, para a skill republicar no mesmo endereço;
 * `--artifact-url` sobrepõe.
 *
 * Uso: npx tsx scripts/render-roteiro-video.ts AAMMDD [--falas PATH] [--out PATH] [--artifact-url URL] [--stdout]
 *   AAMMDD:          edição (lê e grava em `data/editions/{AAMM}/{AAMMDD}/_internal/`)
 *   --falas:         outro caminho para o JSON do roteiro
 *   --out:           outro caminho para a página (default `_internal/roteiro-d1.html`)
 *   --artifact-url:  link do artefato a gravar na 1ª linha
 *   --stdout:        imprime a página em vez de gravar
 *
 * Exit: 0 = página gerada (o caminho no stdout); 3 = sem roteiro-falas.json; 2 = uso, JSON inválido ou seta no texto.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { artifactUrlDe, renderRoteiroPagina } from "./lib/diaria/roteiro-pagina.ts";
import { avisosDuracao, avisosGanchoETitulo, parseRoteiroFalas, ROTEIRO_FALAS_FILE } from "./lib/diaria/roteiro-videos.ts";
import { lerDuracaoConfig } from "./video-roteiro-blocos.ts";

export const ROTEIRO_PAGINA_FILE = "_internal/roteiro-d1.html";
export const EXIT_SEM_ROTEIRO = 3;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function main(
  argv: string[] = process.argv.slice(2),
  io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => console.log(s), err: (s) => console.error(s) },
  root: string = ROOT,
): number {
  const { values, flags, positional } = parseArgs(argv);
  const edition = positional[0];
  if (!edition || !/^\d{6}$/.test(edition)) {
    io.err("uso: render-roteiro-video.ts AAMMDD [--falas PATH] [--out PATH] [--artifact-url URL] [--stdout]");
    return 2;
  }
  const dir = editionDir(edition);
  const falasPath = values["falas"] ?? join(dir, ROTEIRO_FALAS_FILE);
  if (!existsSync(falasPath)) {
    io.err(`[render-roteiro-video] sem ${falasPath}: grave o roteiro-falas.json (Passo 5 da /diaria-video-roteiro) antes de gerar a página`);
    return EXIT_SEM_ROTEIRO;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(falasPath, "utf8"));
  } catch (e) {
    io.err(`[render-roteiro-video] não li ${falasPath}: ${(e as Error).message}`);
    return 2;
  }
  const lido = parseRoteiroFalas(raw);
  if (!lido.ok) {
    io.err(`[render-roteiro-video] ${falasPath} inválido:\n  ${lido.problemas.join("\n  ")}`);
    return 2;
  }
  const artifactFlag = values["artifact-url"];
  if (artifactFlag !== undefined && !/^https:\/\/\S+$/.test(artifactFlag)) {
    io.err("[render-roteiro-video] --artifact-url precisa ser uma URL https");
    return 2;
  }
  const outPath = values["out"] ?? join(dir, ROTEIRO_PAGINA_FILE);
  const artifactUrl = artifactFlag ?? (existsSync(outPath) ? artifactUrlDe(readFileSync(outPath, "utf8")) ?? undefined : undefined);
  const cfg = lerDuracaoConfig(root, io.err);
  for (const a of [...avisosGanchoETitulo(lido.roteiro), ...avisosDuracao(lido.roteiro, cfg)]) io.err(`[aviso] ${a}`);
  let html: string;
  try {
    html = renderRoteiroPagina(lido.roteiro, { cfg, ...(artifactUrl ? { artifactUrl } : {}) });
  } catch (e) {
    io.err(`[render-roteiro-video] ${(e as Error).message}`);
    return 2;
  }
  if (flags.has("stdout")) {
    io.out(html);
    return 0;
  }
  writeFileSync(outPath, html, "utf8");
  if (!artifactUrl) io.err("[render-roteiro-video] página sem link de artefato na 1ª linha: depois de publicar, gere de novo com --artifact-url (Passo 5)");
  io.out(outPath);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
