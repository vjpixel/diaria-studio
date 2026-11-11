#!/usr/bin/env node
/**
 * scripts/video-roteiro-confere.ts (#12754)
 *
 * Passo 8 do `/diaria-video-roteiro`: confere a transcrição ditada da
 * gravação contra as falas numeradas do roteiro. Primeira passada
 * determinística (cobertura por conteúdo, número ausente, veículo citado,
 * trechos sem fala); o modelo confirma cada veredito diferente de `ok`
 * lendo o trecho. Lógica e limites: `scripts/lib/diaria/roteiro-gravacao.ts`.
 *
 * Só lê: não grava nada, não altera o roteiro.
 *
 * Uso: npx tsx scripts/video-roteiro-confere.ts --falas FALAS.json --transcricao TRANSCRICAO.txt [--json]
 *   --falas:       `{ edicao?, veiculos?: string[], falas: [{ id, texto, videos: ("horizontal"|"vertical1"|"vertical2")[], gravarAParte? }] }`
 *   --transcricao: texto ditado pelo editor (qualquer pontuação; ordem livre)
 *   --json:        saída JSON (`ResultadoConferencia`) em vez do relatório em texto
 *
 * Exit: 0 = conferência feita (com ou sem pendência); 2 = uso ou arquivo inválido.
 */

import { readFileSync } from "node:fs";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  conferirGravacao,
  renderConferencia,
  validarRoteiroFalas,
  type RoteiroFalas,
} from "./lib/diaria/roteiro-gravacao.ts";

function main(): number {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const falasPath = values["falas"];
  const transPath = values["transcricao"];
  if (!falasPath || !transPath) {
    console.error("uso: video-roteiro-confere.ts --falas FALAS.json --transcricao TRANSCRICAO.txt [--json]");
    return 2;
  }
  let roteiro: unknown;
  let transcricao: string;
  try {
    roteiro = JSON.parse(readFileSync(falasPath, "utf8"));
    transcricao = readFileSync(transPath, "utf8");
  } catch (e) {
    console.error(`[video-roteiro-confere] não li os arquivos: ${(e as Error).message}`);
    return 2;
  }
  const problemas = validarRoteiroFalas(roteiro);
  if (problemas.length > 0) {
    console.error(`[video-roteiro-confere] ${falasPath} inválido:\n  ${problemas.join("\n  ")}`);
    return 2;
  }
  if (!transcricao.trim()) {
    console.error("[video-roteiro-confere] transcrição vazia");
    return 2;
  }
  const r = conferirGravacao(roteiro as RoteiroFalas, transcricao);
  console.log(flags.has("json") ? JSON.stringify(r, null, 2) : renderConferencia(r));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
