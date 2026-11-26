/**
 * lib/lint-checks/cli/why-matters-format.ts
 *
 * CLI handler pro check `--check why-matters-format` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { checkWhyMattersFormat } from "../why-matters-format.ts";

// Modo --check why-matters-format (#701) — bloqueia "Para [audiência]," opener
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "why-matters-format");
  const result = checkWhyMattersFormat(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ ${result.errors.length} parágrafo(s) "Por que isso importa" começam com ` +
        `"Para [audiência]," (editorial-rules:35):`,
    );
    for (const e of result.errors) {
      console.error(`  linha ${e.line}: "${e.text}"`);
    }
    process.exit(1);
  }
  return;
}
