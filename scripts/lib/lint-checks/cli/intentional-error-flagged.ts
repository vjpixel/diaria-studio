/**
 * lib/lint-checks/cli/intentional-error-flagged.ts
 *
 * CLI handler pro check `--check intentional-error-flagged` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { resolve } from "node:path";
import { checkIntentionalError, checkIntentionalErrorSafety } from "../intentional-error.ts";

// Modo --check intentional-error-flagged (#754) — verifica que a edição tem
// intentional_error declarado em `_internal/intentional-error.json` (#3222 —
// migrado de frontmatter YAML; concurso mensal de erro proposital). Roda no
// Stage 4 (publish-newsletter) antes de criar draft.
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error(
      "Uso: lint-newsletter-md.ts --check intentional-error-flagged --md <md-path>",
    );
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  const result = checkIntentionalError(mdPath);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ ${result.label}`);
    console.error(
      `\nCrie/edite _internal/intentional-error.json (sibling de ${args.md}) com os campos:`,
    );
    console.error(`{
"description": "o que o assinante deve identificar",
"location": "DESTAQUE 2, parágrafo 2, primeira frase",
"category": "factual",
"correct_value": "valor correto",
"reveal": "Na última edição, escrevi X onde o correto é Y."
}
// category: factual | ortografico | numeric | attribution | data | version_inconsistency | factual_synthetic`);
    process.exit(1);
  }
  // F1/#2149: wire safety check — warn (não bloqueia) para categorias de risco de desinformação
  if (!result.no_error) {
    const safetyResult = checkIntentionalErrorSafety(result.parsed?.category);
    if (!safetyResult.safe && safetyResult.warn) {
      console.error(`
⚠️  ${safetyResult.warn}`);
    }
  }
  return;
}
