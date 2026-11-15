#!/usr/bin/env node
/**
 * scripts/render-roteiro-video.ts (#13120)
 *
 * Gera a página do roteiro do `/diaria-video-roteiro`
 * (`_internal/roteiro-d1.html`) a partir do `_internal/roteiro-falas.json`, em
 * vez de escrever o HTML à mão: os boxes "Na tela" ao lado de cada fala, os
 * cortes parciais por vertical, a ordem própria de cada vertical e as cópias
 * da fala nos três vídeos saem do mesmo JSON e não divergem. A duração de cada
 * vídeo é calculada (#13130), não digitada. Lógica:
 * `scripts/lib/diaria/roteiro-pagina.ts`.
 *
 * Mantém a 1ª linha `<!-- artifact: URL -->` da página que já existe, para a
 * skill republicar no mesmo endereço.
 *
 * Uso: npx tsx scripts/render-roteiro-video.ts AAMMDD [--falas PATH] [--out PATH] [--versao ROTULO]
 *   AAMMDD:    edição (lê `data/editions/{AAMM}/{AAMMDD}/_internal/roteiro-falas.json`)
 *   --falas:   outro caminho para o JSON do roteiro
 *   --out:     outro caminho para a página (default `_internal/roteiro-d1.html` da edição)
 *   --versao:  rótulo da versão na linha de meta ("v5")
 *
 * Exit: 0 = página gravada (o caminho no stdout); 3 = sem roteiro-falas.json;
 * 2 = uso ou JSON inválido.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { renderRoteiroPagina } from "./lib/diaria/roteiro-pagina.ts";
import { loadAlvosRoteiro, parseRoteiroFalas, ROTEIRO_FALAS_FILE } from "./lib/diaria/roteiro-videos.ts";

export const ROTEIRO_PAGINA_FILE = "_internal/roteiro-d1.html";
export const EXIT_SEM_ROTEIRO = 3;

/** A linha `<!-- artifact: URL -->` do topo da página anterior, se houver. */
export function artifactLineOf(html: string): string | undefined {
  const first = html.split(/\r?\n/, 1)[0]?.trim();
  return first && /^<!--\s*artifact:\s*\S+\s*-->$/.test(first) ? first : undefined;
}

export function main(argv: string[] = process.argv.slice(2), io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => console.log(s), err: (s) => console.error(s) }): number {
  const { values, positional } = parseArgs(argv);
  const edition = positional[0];
  if (!edition || !/^\d{6}$/.test(edition)) {
    io.err("uso: render-roteiro-video.ts AAMMDD [--falas PATH] [--out PATH] [--versao ROTULO]");
    return 2;
  }
  const falasPath = values["falas"] ?? join(editionDir(edition), ROTEIRO_FALAS_FILE);
  if (!existsSync(falasPath)) {
    io.err(`[render-roteiro-video] sem ${falasPath}: gravar o roteiro-falas.json (Passo 5 da /diaria-video-roteiro) antes da página`);
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
  const outPath = values["out"] ?? join(editionDir(edition), ROTEIRO_PAGINA_FILE);
  const artifactLine = existsSync(outPath) ? artifactLineOf(readFileSync(outPath, "utf8")) : undefined;
  const { alvos, avisos } = loadAlvosRoteiro();
  for (const a of avisos) io.err(`[aviso] ${a}`);
  const html = renderRoteiroPagina(lido.roteiro, { alvos, ...(values["versao"] ? { versao: values["versao"] } : {}), ...(artifactLine ? { artifactLine } : {}) });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf8");
  if (!artifactLine) io.err(`[render-roteiro-video] página nova (sem linha <!-- artifact: URL -->): depois de publicar, gravar o link na 1ª linha`);
  io.out(outPath);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
