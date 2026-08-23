/**
 * lib/lint-checks/cli/use-melhor-tempo.ts
 *
 * CLI handler pro check `--check use-melhor-tempo` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkUseMelhorTempo } from "../use-melhor-tempo.ts";

// Modo --check use-melhor-tempo (#2372) — cada item USE MELHOR precisa de
// estimativa de tempo "— N min" na linha de descrição.
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check use-melhor-tempo --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkUseMelhorTempo(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ use-melhor-tempo: ${result.errors.length} item(ns) USE MELHOR sem estimativa de tempo:`,
    );
    for (const e of result.errors) {
      console.error(
        `  item ${e.item} (linha ${e.titleLine}): descrição "${e.excerpt}" não contém "(N min)" ou "— N min"`,
      );
    }
    console.error(
      `\nFix: adicione "(X min)" ou "— X min" à descrição de cada item (ex: "(5 min)" ou "— 5 min de leitura").`,
    );
    process.exit(1);
  }
  return;
}
