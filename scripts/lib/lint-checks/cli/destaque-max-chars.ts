/**
 * lib/lint-checks/cli/destaque-max-chars.ts
 *
 * CLI handler pro check `--check destaque-max-chars` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { checkDestaqueMaxChars } from "../destaque-chars.ts";

// Modo --check destaque-max-chars (#964) — valida máximo de chars por destaque
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "destaque-max-chars");
  const result = checkDestaqueMaxChars(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ destaque-max-chars: ${result.errors.length} destaque(s) acima do máximo:`,
    );
    for (const e of result.errors) {
      const excess = e.chars - e.max;
      console.error(
        `  D${e.destaque} (${e.category}): ${e.chars} chars — acima do máximo de ${e.max} (excesso: ${excess} chars)`,
      );
    }
    console.error(
      `\nFix: re-disparar writer pra trimar o body do destaque (corte parágrafo redundante OU encurte "Por que isso importa").`,
    );
    process.exit(1);
  }
  return;
}
