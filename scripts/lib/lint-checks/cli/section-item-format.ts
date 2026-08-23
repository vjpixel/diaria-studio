/**
 * lib/lint-checks/cli/section-item-format.ts
 *
 * CLI handler pro check `--check section-item-format` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkSectionItemFormat } from "../section-item-format.ts";

// Modo --check section-item-format (#909) — valida formato de itens em seções secundárias
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error(
      "Uso: lint-newsletter-md.ts --check section-item-format --md <md-path>",
    );
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
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
