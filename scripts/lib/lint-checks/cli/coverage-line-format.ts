/**
 * lib/lint-checks/cli/coverage-line-format.ts
 *
 * CLI handler pro check `--check coverage-line-format` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkCoverageLine } from "../coverage-line-format.ts";

// Modo --check coverage-line-format (#1207) — valida formato canônico da
// linha de cobertura via checkCoverageLine (existing helper, #592/#609)
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check coverage-line-format --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkCoverageLine(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ coverage-line-format: primeira linha não bate com regex canônico.`);
    console.error(
      `   Esperado: "Para esta edição, eu (o editor) enviei X submissões e a Diar.ia encontrou outros Y artigos. Selecionamos os Z mais relevantes para as pessoas que assinam a newsletter."`,
    );
    console.error(`   Encontrado: "${result.firstLine.slice(0, 120)}"`);
    process.exit(1);
  }
  return;
}
