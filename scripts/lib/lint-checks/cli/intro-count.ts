/**
 * lib/lint-checks/cli/intro-count.ts
 *
 * CLI handler pro check `--check intro-count` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { lintIntroCount } from "../../newsletter-count.ts";

// Modo --check intro-count (#743) — verifica que intro bate com contagem real
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check intro-count --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = lintIntroCount(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ intro-count: intro afirma ${result.claimed} mas contagem real é ${result.actual}`,
    );
    process.exit(1);
  }
  return;
}
