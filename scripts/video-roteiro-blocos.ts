#!/usr/bin/env node
/**
 * scripts/video-roteiro-blocos.ts (#12751)
 *
 * Ponte do `/diaria-video-roteiro` para o `/diaria-video-montagem`: lê o JSON
 * do roteiro (`_internal/roteiro-falas.json`, gravado pela skill do roteiro
 * junto com a página) e propõe os blocos da montagem para as três peças da
 * gravação: horizontal (`youtube`), vertical 1 (a vertical da edição,
 * `outras-redes`) e vertical 2 (corte `guia`, com o título na tela e o gancho
 * do roteiro). Lógica: `scripts/lib/diaria/roteiro-videos.ts`.
 *
 * Também avisa (stderr, `[aviso]`, sem mudar o exit) gancho do vertical com
 * mais de ~8 palavras antes do primeiro ponto, título que repete o gancho e
 * capa de vertical sem sujeito (`avisosGanchoETitulo`, #13116), e vertical
 * acima do alvo de duração ou horizontal fora da faixa (`avisosDuracao`,
 * #13130; alvos em `publishing.video.roteiro` do `platform.config.json`).
 * Também avisa verbos de relatório e trechos com mais de 30 palavras sem
 * pausa (`avisosTomConversacional`, #13165), sem bloquear a proposta.
 * A saída traz a duração estimada de cada vídeo (`duracoes` no `--json`).
 * A validação (`validarRoteiroFalas`, roteiro-gravacao.ts) cobre os campos
 * novos: `tela` (#13120), `cortes` (#13129), `fontes` (#13132),
 * `porVideo.{vertical}.ordem` (#13128), `porVideo.{v}.cta`, `gravacao` e `notas`.
 *
 * Só propõe: não grava `blocks.json` nem decupagem. Os tempos no bruto saem da
 * decupagem e o editor decide no Gate 1/Gate 2 da montagem.
 *
 * Uso: npx tsx scripts/video-roteiro-blocos.ts AAMMDD [--falas PATH] [--corte SLUG] [--json]
 *   AAMMDD:   edição (lê `data/editions/{AAMM}/{AAMMDD}/_internal/roteiro-falas.json`)
 *   --falas:  outro caminho para o JSON do roteiro
 *   --corte:  slug do corte do vertical 2 (default `guia`)
 *   --json:   saída JSON (`PropostaBlocos` mais `duracoes`) em vez do Markdown
 *
 * Exit: 0 = proposta impressa; 3 = sem roteiro-falas.json (edição sem roteiro
 * pela skill: seguir a montagem como antes); 2 = uso ou arquivo inválido.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import {
  avisosDuracao,
  avisosTomConversacional,
  avisosGanchoETitulo,
  duracaoPorVideo,
  parseRoteiroFalas,
  propostaBlocosDoRoteiro,
  renderDuracoes,
  renderPropostaBlocos,
  ROTEIRO_DURACAO_DEFAULT,
  ROTEIRO_FALAS_FILE,
  roteiroDuracaoConfigFrom,
  type RoteiroDuracaoConfig,
} from "./lib/diaria/roteiro-videos.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Os alvos de duração da config (#13130); config ilegível = defaults, com aviso. */
export function lerDuracaoConfig(root: string, err: (s: string) => void): RoteiroDuracaoConfig {
  const path = join(root, "platform.config.json");
  if (!existsSync(path)) return ROTEIRO_DURACAO_DEFAULT;
  try {
    return roteiroDuracaoConfigFrom(JSON.parse(readFileSync(path, "utf8")), (m) => err(`[aviso] ${m}`));
  } catch (e) {
    err(`[aviso] ${path} ilegível (${(e as Error).message}): alvos de duração default (#13130)`);
    return ROTEIRO_DURACAO_DEFAULT;
  }
}

export const EXIT_SEM_ROTEIRO = 3;

export function main(
  argv: string[] = process.argv.slice(2),
  io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => console.log(s), err: (s) => console.error(s) },
  root: string = ROOT,
): number {
  const { values, flags, positional } = parseArgs(argv);
  const edition = positional[0];
  if (!edition || !/^\d{6}$/.test(edition)) {
    io.err("uso: video-roteiro-blocos.ts AAMMDD [--falas PATH] [--corte SLUG] [--json]");
    return 2;
  }
  const path = values["falas"] ?? join(editionDir(edition), ROTEIRO_FALAS_FILE);
  if (!existsSync(path)) {
    io.err(`[video-roteiro-blocos] sem ${path}: edição sem roteiro pela /diaria-video-roteiro; seguir a montagem pela decupagem (#12751)`);
    return EXIT_SEM_ROTEIRO;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    io.err(`[video-roteiro-blocos] não li ${path}: ${(e as Error).message}`);
    return 2;
  }
  const lido = parseRoteiroFalas(raw);
  if (!lido.ok) {
    io.err(`[video-roteiro-blocos] ${path} inválido:\n  ${lido.problemas.join("\n  ")}`);
    return 2;
  }
  const corte = values["corte"];
  if (corte !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(corte)) {
    io.err("[video-roteiro-blocos] --corte precisa ser um slug (minúsculas, dígitos e hífen)");
    return 2;
  }
  const cfg = lerDuracaoConfig(root, io.err);
  const proposta = propostaBlocosDoRoteiro(lido.roteiro, { ...(corte ? { corteSlug: corte } : {}), palavrasPorMinuto: cfg.palavrasPorMinuto });
  for (const a of [...proposta.avisos, ...avisosGanchoETitulo(lido.roteiro), ...avisosDuracao(lido.roteiro, cfg), ...avisosTomConversacional(lido.roteiro)]) io.err(`[aviso] ${a}`);
  io.out(
    flags.has("json")
      ? JSON.stringify({ ...proposta, duracoes: duracaoPorVideo(lido.roteiro, cfg) }, null, 2)
      : `${renderPropostaBlocos(proposta)}
${renderDuracoes(lido.roteiro, cfg)}`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
