/**
 * lib/lint-checks/cli/callout-placement.ts
 *
 * CLI handler pro check `--check callout-placement` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { lintCalloutPlacement } from "../callout-placement.ts";

// Modo --check callout-placement (#1972) — callout (📣/📚/🎉) colado DENTRO de
// uma seção de DESTAQUE (antes do `---`) em vez de isolado entre dois `---`.
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check callout-placement --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = lintCalloutPlacement(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ ${result.matches.length} callout(s) colado(s) dentro de uma seção de DESTAQUE:`,
    );
    for (const m of result.matches) {
      console.error(`  linha ${m.line}: "${m.context}"`);
    }
    console.error(
      `\n   Fix: mova o callout pra sua PRÓPRIA seção, isolada entre o \`---\` que fecha o D1 e o \`---\` que abre o D2. (O render já de-duplica — #1972 Opção A — mas o MD deve ficar correto.)`,
    );
    process.exit(1);
  }
  return;
}
