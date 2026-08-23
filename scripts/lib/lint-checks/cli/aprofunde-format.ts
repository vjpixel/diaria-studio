/**
 * lib/lint-checks/cli/aprofunde-format.ts
 *
 * CLI handler pro check `--check aprofunde-format` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkAprofundeFormat } from "../aprofunde-format.ts";

// Modo --check aprofunde-format (#3920) — valida o bloco "Aprofunde:" dos
// destaques (fontes do cluster same-story). GATE-BLOCKING: bloco malformado
// (item sem link, lixo entre itens, header antes do "Por que importa", bloco
// vazio) não é publicável. Bloco AUSENTE nunca dispara (é opcional).
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check aprofunde-format --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkAprofundeFormat(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ aprofunde-format: ${result.errors.length} problema(s) no bloco "Aprofunde:":`);
    for (const e of result.errors) {
      const where = e.destaque ? `D${e.destaque} ` : "";
      console.error(`  ${where}linha ${e.line} [${e.type}]: "${e.excerpt}"`);
    }
    console.error(
      `\nFormato esperado (só quando há cluster): "Aprofunde:" (após "Por que isso importa"), ` +
        `depois 1+ itens "* [Título](URL) - Fonte".`,
    );
    process.exit(1);
  }
  return;
}
