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
 * `video-roteiro-blocos.ts`); inválido = exit 2, nada gravado. Os mesmos
 * `[aviso]` do `video-roteiro-blocos.ts` (proposta de blocos, gancho, título,
 * capa, duração, formato react e fact-check do roteiro defasado, #13433/#13434)
 * saem no stderr, sem mudar o exit; capa que o
 * `gen-youtube-thumb.ts` recusaria sai como `[erro]` (#13401) e barra a página
 * (#13569): exit 4, nada gravado, o mesmo exit do `video-roteiro-blocos.ts`.
 * Antes ela só avisava, e o roteiro da 261118 foi publicado com uma capa de 6
 * palavras no vertical 1, recusada só no dia da publicação. A página é gravada num
 * arquivo temporário e renomeada, para o Drive nunca sincronizar uma pela metade.
 *
 * O link do artefato (`<!-- artifact: URL -->`, 1ª linha) é preservado da
 * página que já existe no destino, para a skill republicar no mesmo endereço;
 * `--artifact-url` sobrepõe.
 *
 * Uso: npx tsx scripts/render-roteiro-video.ts AAMMDD [--topicos | --sem-topicos] [--falas PATH] [--out PATH] [--artifact-url URL] [--stdout]
 *   --topicos:       gera a página só de tópicos (#13447, `_internal/topicos-gravacao.html`): ordem do
 *                    horizontal, fonte grande, faixa dos `trechoInserido`, gravadas à parte no fim
 *   --sem-topicos:   o roteiro completo sem a coluna de tópicos (a página de tópicos vai à parte)
 *   AAMMDD:          edição (lê e grava em `data/editions/{AAMM}/{AAMMDD}/_internal/`)
 *   --falas:         outro caminho para o JSON do roteiro
 *   --out:           outro caminho para a página (default `_internal/roteiro-d1.html`, ou `_internal/topicos-gravacao.html` com --topicos)
 *   --artifact-url:  link do artefato a gravar na 1ª linha
 *   --stdout:        imprime a página em vez de gravar
 *
 * Exit: 0 = página gerada (o caminho no stdout); 3 = sem roteiro-falas.json; 2 = uso, JSON inválido ou seta no texto;
 *       4 = capa fora da regra do gerador (vertical fora de 2 a 7 palavras, horizontal fora de 2 linhas de até 4), nada gravado (#13569).
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { artifactUrlDe, artifactUrlSegura, renderRoteiroPagina, renderTopicosPagina } from "./lib/diaria/roteiro-pagina.ts";
import { avisosTomConversacional, avisosDuracao, avisosTela, avisosGanchoETitulo, parseRoteiroFalas, propostaBlocosDoRoteiro, ROTEIRO_FALAS_FILE } from "./lib/diaria/roteiro-videos.ts";
import { avisosRoteiroReact, EXIT_CAPA_FORA_DA_REGRA, lerDuracaoConfig } from "./video-roteiro-blocos.ts";
import { errosCapaDoRoteiro } from "./lib/diaria/youtube-thumb-roteiro.ts";

export const ROTEIRO_PAGINA_FILE = "_internal/roteiro-d1.html";
export const TOPICOS_PAGINA_FILE = "_internal/topicos-gravacao.html";
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
    io.err("uso: render-roteiro-video.ts AAMMDD [--topicos | --sem-topicos] [--falas PATH] [--out PATH] [--artifact-url URL] [--stdout]");
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
  if (flags.has("topicos") && flags.has("sem-topicos")) {
    io.err("[render-roteiro-video] --topicos e --sem-topicos não combinam: um gera a página de tópicos, o outro tira a coluna do roteiro");
    return 2;
  }
  const soTopicos = flags.has("topicos");
  const artifactFlag = values["artifact-url"];
  if (artifactFlag !== undefined && !artifactUrlSegura(artifactFlag)) {
    io.err("[render-roteiro-video] --artifact-url precisa ser uma URL https (sem espaço, <, > ou --)");
    return 2;
  }
  const outPath = values["out"] ?? join(dir, soTopicos ? TOPICOS_PAGINA_FILE : ROTEIRO_PAGINA_FILE);
  const paginaExistia = existsSync(outPath);
  const artifactUrl = artifactFlag ?? (paginaExistia ? artifactUrlDe(readFileSync(outPath, "utf8")) ?? undefined : undefined);
  const cfg = lerDuracaoConfig(root, io.err);
  const proposta = propostaBlocosDoRoteiro(lido.roteiro, { palavrasPorMinuto: cfg.palavrasPorMinuto });
  for (const a of [
    ...proposta.avisos,
    ...avisosGanchoETitulo(lido.roteiro),
    ...avisosDuracao(lido.roteiro, cfg),
    ...avisosTomConversacional(lido.roteiro),
    ...avisosTela(lido.roteiro),
    ...avisosRoteiroReact(lido.roteiro, root, edition, falasPath),
  ])
    io.err(`[aviso] ${a}`);
  // #13401: capa que o gen-youtube-thumb.ts recusaria. #13569: barra a página (exit 4, nada gravado), como
  // o blocos: só o [erro] no stderr deixou a 261118 publicar o roteiro com capa de 6 palavras no vertical 1.
  const errosCapa = errosCapaDoRoteiro(lido.roteiro);
  for (const e of errosCapa) io.err(`[erro] ${e}`);
  if (errosCapa.length) {
    io.err(`[render-roteiro-video] página não gerada: corrija a capa no ${falasPath} e gere de novo (#13569)`);
    return EXIT_CAPA_FORA_DA_REGRA;
  }
  let html: string;
  try {
    html = soTopicos
      ? renderTopicosPagina(lido.roteiro, artifactUrl ? { artifactUrl } : {})
      : renderRoteiroPagina(lido.roteiro, { cfg, semTopicos: flags.has("sem-topicos"), ...(artifactUrl ? { artifactUrl } : {}) });
  } catch (e) {
    io.err(`[render-roteiro-video] ${(e as Error).message}`);
    return 2;
  }
  if (flags.has("stdout")) {
    io.out(html);
    return 0;
  }
  const tmp = `${outPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, html, "utf8");
    renameSync(tmp, outPath);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* o temporário que sobrar não muda o resultado: a página não foi gravada */
    }
    io.err(`[render-roteiro-video] não gravei ${outPath}: ${(e as Error).message}`);
    return 2;
  }
  if (!artifactUrl) {
    io.err(
      paginaExistia
        ? "[render-roteiro-video] a página anterior não tinha link de artefato: confira se ela já foi publicada (republicar no mesmo link) antes de publicar uma nova; depois, gere de novo com --artifact-url (Passo 5)"
        : "[render-roteiro-video] página sem link de artefato: depois de publicar, gere de novo com --artifact-url (Passo 5)",
    );
  }
  io.out(outPath);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
