/**
 * lib/lint-checks/cli/eia-answer.ts
 *
 * CLI handler pro check `--check eia-answer` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { resolve } from "node:path";
import { checkEiaAnswer } from "../eia-answer-check.ts";

// Modo --check eia-answer (#744) — verifica que 02-reviewed.md tem eia_answer
// quando 01-eia.md existe na edition_dir
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error(
      "Uso: lint-newsletter-md.ts --check eia-answer --md <md-path> [--edition-dir <dir>]",
    );
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  const editionDir = args["edition-dir"]
    ? resolve(root, args["edition-dir"])
    : undefined;
  const result = checkEiaAnswer(mdPath, editionDir);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ ${result.label}`);
    process.exit(1);
  }
  return;
}
