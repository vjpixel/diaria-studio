/**
 * lib/lint-checks/cli/titles-per-highlight.ts
 *
 * CLI handler pro check `--check titles-per-highlight` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { countTitlesPerHighlight } from "../titles-per-highlight.ts";

// Modo --check titles-per-highlight (#178)
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error(
      "Uso: lint-newsletter-md.ts --check titles-per-highlight --md <md-path>",
    );
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = countTitlesPerHighlight(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ ${result.errors.length} erro(s):`);
    for (const e of result.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  return;
}
