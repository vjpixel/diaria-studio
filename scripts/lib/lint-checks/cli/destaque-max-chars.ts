/**
 * lib/lint-checks/cli/destaque-max-chars.ts
 *
 * CLI handler pro check `--check destaque-max-chars` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkDestaqueMaxChars } from "../destaque-chars.ts";

// Modo --check destaque-max-chars (#964) — valida máximo de chars por destaque
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error(
      "Uso: lint-newsletter-md.ts --check destaque-max-chars --md <md-path>",
    );
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
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
