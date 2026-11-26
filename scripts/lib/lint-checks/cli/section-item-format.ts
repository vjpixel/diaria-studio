/**
 * lib/lint-checks/cli/section-item-format.ts
 *
 * CLI handler pro check `--check section-item-format` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { checkSectionItemFormat } from "../section-item-format.ts";

// Modo --check section-item-format (#909) — valida formato de itens em seções secundárias
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "section-item-format");
  const result = checkSectionItemFormat(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ section-item-format: ${result.errors.length} item(ns) fora do formato esperado:`,
    );
    for (const e of result.errors) {
      console.error(`  ${e.section} linha ${e.line}: ${e.type}`);
      console.error(`    "${e.excerpt}"`);
    }
    console.error(
      `\nFormato esperado: "**[Título](URL)**" + linha em branco + descrição plain.`,
    );
    process.exit(1);
  }
  return;
}
