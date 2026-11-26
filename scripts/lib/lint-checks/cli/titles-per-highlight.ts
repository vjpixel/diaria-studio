/**
 * lib/lint-checks/cli/titles-per-highlight.ts
 *
 * CLI handler pro check `--check titles-per-highlight` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { countTitlesPerHighlight } from "../titles-per-highlight.ts";

// Modo --check titles-per-highlight (#178)
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "titles-per-highlight");
  const result = countTitlesPerHighlight(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ ${result.errors.length} erro(s):`);
    for (const e of result.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  return;
}
