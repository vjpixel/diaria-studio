/**
 * lib/lint-checks/cli/why-matters-length.ts
 *
 * CLI handler pro check `--check why-matters-length` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { checkWhyMattersLength, WHY_MATTERS_MIN_CHARS, WHY_MATTERS_MAX_CHARS } from "../why-matters-length.ts";

// Modo --check why-matters-length (#3993) — valida janela 180-300 chars
// do parágrafo "Por que isso importa" de cada destaque.
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "why-matters-length");
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
      `\nFix: re-disparar writer-destaque do(s) destaque(s) afetado(s) pra reescrever "Por que isso importa" dentro de 180-300 chars (2 frases curtas cabem nessa janela — frase 1: efeito sobre o leitor; frase 2: tendência ou implicação concreta).`,
    );
    process.exit(1);
  }
  return;
}
