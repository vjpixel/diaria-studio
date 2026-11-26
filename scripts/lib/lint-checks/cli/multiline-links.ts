/**
 * lib/lint-checks/cli/multiline-links.ts
 *
 * CLI handler pro check `--check multiline-links` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { lintMultilineLinks } from "../multiline-links.ts";

// Modo --check multiline-links (#1213) — detecta links markdown quebrados
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "multiline-links");
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
