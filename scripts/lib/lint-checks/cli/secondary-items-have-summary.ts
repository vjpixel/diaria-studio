/**
 * lib/lint-checks/cli/secondary-items-have-summary.ts
 *
 * CLI handler pro check `--check secondary-items-have-summary` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { checkSecondaryItemsHaveSummary } from "../secondary-items-have-summary.ts";

// Modo --check secondary-items-have-summary (#2545) — item de seção secundária
// (LANÇAMENTOS/RADAR/USE MELHOR) sem descrição. Acusa ANTES do gate Stage 4
// para que o editor possa corrigir antes de publicar.
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "secondary-items-have-summary");
  const result = checkSecondaryItemsHaveSummary(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ secondary-items-have-summary: ${result.errors.length} item(ns) sem descrição nas seções secundárias:`,
    );
    for (const e of result.errors) {
      console.error(`  ${e.section} linha ${e.titleLine}: "${e.titleExcerpt}"`);
    }
    console.error(
      `\nFix: adicione uma linha de descrição (plain text, 1 frase) abaixo de cada título pelado.`,
    );
    console.error(
      `Causa provável: cache-miss no enrich-inbox-articles (body não cacheado no 1i). Re-rodar Etapa 1 ou adicionar descrição manualmente.`,
    );
    process.exit(1);
  }
  return;
}
