/**
 * lib/lint-checks/cli/multiline-links.ts
 *
 * CLI handler pro check `--check multiline-links` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { lintMultilineLinks } from "../multiline-links.ts";

// Modo --check multiline-links (#1213) — detecta links markdown quebrados
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check multiline-links --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = lintMultilineLinks(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ ${result.matches.length} link(s) markdown quebrado(s) em múltiplas linhas:`,
    );
    for (const m of result.matches) {
      console.error(`  linha ${m.line}: "${m.context}"`);
    }
    console.error(
      `\n   Fix: junte cada link em uma única linha — [Label](url) sem newline entre os elementos.`,
    );
    process.exit(1);
  }
  return;
}
