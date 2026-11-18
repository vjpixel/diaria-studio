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
 * pausa (`avisosTomConversacional`, #13165), e o formato do texto de tela
 * (`avisosTela`, #13180), sem bloquear a proposta. Formato react (#13433,
 * `avisosRoteiroReact`): fala de vertical que se apoia num trecho que só o
 * horizontal leva, reação que repete a previsão em pergunta e `trechoInserido`
 * que não bate com o SRT do vídeo citado; e `02-reviewed.md` mais novo que o
 * roteiro ou que o fact-check do roteiro (#13434).
 * Capa do roteiro que o `gen-youtube-thumb.ts` recusaria (vertical fora de 2 a
 * 5 palavras, `normalizeShortCoverHook`; horizontal fora do `splitHook`, com a
 * quebra de `hookHorizontalDoRoteiro`) é `[erro]` com exit 4, depois da
 * proposta impressa (#13401, `errosCapaDoRoteiro`).
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
 * pela skill: seguir a montagem como antes); 2 = uso ou arquivo inválido;
 * 4 = proposta impressa, mas uma capa fora da regra do gerador (#13401): a
 * montagem segue com a proposta (a capa vai por `--hook` na `/diaria-publica`)
 * e o roteiro corrige a capa antes de gravar.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir, editionsRoot } from "./lib/edition-paths.ts";
import { avisosFactCheckRoteiroDefasado, avisosFormatoReact } from "./lib/diaria/roteiro-react.ts";
import type { RoteiroFalas } from "./lib/diaria/roteiro-gravacao.ts";
import {
  avisosDuracao,
  avisosTela,
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
import { errosCapaDoRoteiro } from "./lib/diaria/youtube-thumb-roteiro.ts";

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

/**
 * Avisos do formato react e do fact-check do roteiro (#13433, #13434), comuns
 * a este CLI e ao `render-roteiro-video.ts`: vertical que depende do trecho,
 * reação em pergunta, trecho contra o SRT do vídeo citado (procurado em
 * `{root}/data/editions`) e `02-reviewed.md` mais novo que o roteiro ou que o
 * fact-check do roteiro.
 */
export function avisosRoteiroReact(roteiro: RoteiroFalas, root: string, edition: string, falasPath: string): string[] {
  const dir = join(root, editionDir(edition));
  return [...avisosFormatoReact(roteiro, join(root, editionsRoot())), ...avisosFactCheckRoteiroDefasado(dir, falasPath)];
}

export const EXIT_SEM_ROTEIRO = 3;

/**
 * #13401: proposta válida e impressa, mas uma capa do roteiro (vertical ou
 * horizontal) fora da regra do `gen-youtube-thumb.ts`. Código próprio, para a
 * `/diaria-video-montagem` (roteiro já congelado) seguir com a proposta e a
 * `/diaria-video-roteiro` corrigir a capa antes da gravação. Nunca 2, que é
 * roteiro inválido.
 */
export const EXIT_CAPA_FORA_DA_REGRA = 4;

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
  for (const a of [
    ...proposta.avisos,
    ...avisosGanchoETitulo(lido.roteiro),
    ...avisosDuracao(lido.roteiro, cfg),
    ...avisosTomConversacional(lido.roteiro),
    ...avisosTela(lido.roteiro),
    ...avisosRoteiroReact(lido.roteiro, root, edition, path),
  ])
    io.err(`[aviso] ${a}`);
  io.out(
    flags.has("json")
      ? JSON.stringify({ ...proposta, duracoes: duracaoPorVideo(lido.roteiro, cfg) }, null, 2)
      : `${renderPropostaBlocos(proposta)}
${renderDuracoes(lido.roteiro, cfg)}`,
  );
  const erros = errosCapaDoRoteiro(lido.roteiro);
  for (const e of erros) io.err(`[erro] ${e}`);
  return erros.length ? EXIT_CAPA_FORA_DA_REGRA : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
