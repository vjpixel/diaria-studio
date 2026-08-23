/**
 * lib/lint-checks/cli/destaque-min-chars.ts
 *
 * CLI handler pro check `--check destaque-min-chars` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkDestaqueMinChars } from "../destaque-chars.ts";

// Modo --check destaque-min-chars (#914) — valida mínimo de chars por destaque
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error(
      "Uso: lint-newsletter-md.ts --check destaque-min-chars --md <md-path>",
    );
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkDestaqueMinChars(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ destaque-min-chars: ${result.errors.length} destaque(s) abaixo do mínimo:`,
    );
    for (const e of result.errors) {
      const deficit = e.min - e.chars;
      console.error(
        `  D${e.destaque} (${e.category}): ${e.chars} chars — abaixo do mínimo de ${e.min} (deficit: ${deficit} chars)`,
      );
    }
    console.error(
      `\nFix: re-disparar writer pra expandir o body do destaque (mais 1 parágrafo OU "Por que isso importa" estendido).`,
    );
    process.exit(1);
  }
  return;
}
