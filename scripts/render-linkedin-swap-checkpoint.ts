#!/usr/bin/env npx tsx
/**
 * scripts/render-linkedin-swap-checkpoint.ts (#5974)
 *
 * Wrapper de CLI pro checkpoint síncrono de troca #5538 — chamado no Passo
 * 4 de `.claude/skills/diaria-linkedin-semanal/SKILL.md`, logo depois de
 * `verify-linkedin-weekly-sources.ts`, ANTES do Passo 5 (Clarice/
 * humanizador) e do Passo 7 (render/publicação). Lê
 * `ln-selection.json` do ciclo, checa `selection.headlineSwaps5538`
 * (`hasHeadlineSwaps5538`), e se houve 1+ troca imprime o banner
 * (`renderSwapCheckpointBanner`) no stdout — a skill deve mostrar esse
 * texto na conversa como checkpoint visível antes de prosseguir.
 *
 * Sem trocas: imprime uma linha curta e sai — nunca é obrigatório rodar
 * este script antes de ver se há algo a mostrar, mas rodá-lo sempre no
 * Passo 4 é mais simples que checar o JSON à mão.
 *
 * Não é um gate bloqueante — sempre `exit 0`, nunca aguarda resposta. A
 * troca em si já aconteceu (decisão do #5538); isto só a torna visível.
 *
 * Uso:
 *   npx tsx scripts/render-linkedin-swap-checkpoint.ts --cycle 26w34
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { isValidWeeklyCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { hasHeadlineSwaps5538, renderSwapCheckpointBanner } from "./lib/weekly-linkedin-swap-checkpoint.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param rootDirOverride Opcional. Default = raiz do repo. Testes passam
 *   tempdir com `ln-selection.json` já escrito (mesmo padrão dos outros
 *   scripts `weekly-linkedin`).
 */
export function main(rootDirOverride?: string): void {
  const rootDir = rootDirOverride ?? ROOT;
  const argv = process.argv.slice(2);
  const cycle = getArg(argv, "cycle");
  if (!isValidWeeklyCycle(cycle)) {
    console.error("Uso: render-linkedin-swap-checkpoint.ts --cycle {YY}w{WW}");
    process.exit(2);
  }

  const selectionPath = join(rootDir, weeklyLinkedinRelDir(cycle), "_internal", "ln-selection.json");
  if (!existsSync(selectionPath)) {
    console.error(`${selectionPath} não existe — rode verify-linkedin-weekly-sources.ts primeiro.`);
    process.exit(1);
  }
  const selection = JSON.parse(readFileSync(selectionPath, "utf8"));

  if (!hasHeadlineSwaps5538(selection)) {
    console.log("Nenhuma troca de manchete (#5538) nesta seleção — sem checkpoint a mostrar.");
    return;
  }

  console.log(renderSwapCheckpointBanner(selection.headlineSwaps5538));
}

if (isMainModule(import.meta.url)) {
  main();
}
