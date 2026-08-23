/**
 * lib/lint-checks/cli/why-matters-length.ts
 *
 * CLI handler pro check `--check why-matters-length` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkWhyMattersLength, WHY_MATTERS_MIN_CHARS, WHY_MATTERS_MAX_CHARS } from "../why-matters-length.ts";

// Modo --check why-matters-length (#3993) — valida janela 180-300 chars
// do parágrafo "Por que isso importa" de cada destaque.
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error(
      "Uso: lint-newsletter-md.ts --check why-matters-length --md <md-path>",
    );
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkWhyMattersLength(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ why-matters-length: ${result.errors.length} destaque(s) fora da janela ${WHY_MATTERS_MIN_CHARS}-${WHY_MATTERS_MAX_CHARS} chars:`,
    );
    for (const e of result.errors) {
      const dir = e.chars < e.min ? "abaixo do mínimo" : "acima do máximo";
      console.error(
        `  D${e.destaque} (${e.category}): ${e.chars} chars — ${dir} (janela ${e.min}-${e.max}): "${e.excerpt}"`,
      );
    }
    console.error(
      `\nFix: re-disparar writer-destaque do(s) destaque(s) afetado(s) pra reescrever "Por que isso importa" dentro de 180-300 chars (2 frases curtas cabem nessa janela — frase 1: impacto direto; frase 2: implicação concreta).`,
    );
    process.exit(1);
  }
  return;
}
