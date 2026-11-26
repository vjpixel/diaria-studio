/**
 * lib/lint-checks/cli/callout-placement.ts
 *
 * CLI handler pro check `--check callout-placement` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { lintCalloutPlacement, formatTitleOptionErrors } from "../callout-placement.ts";

// Modo --check callout-placement (#1972) — callout (📣/📚/🎉) colado DENTRO de
// uma seção de DESTAQUE (antes do `---`) em vez de isolado entre dois `---`.
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "callout-placement");
  const result = lintCalloutPlacement(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    if (result.matches.length > 0) {
      console.error(
        `\n❌ ${result.matches.length} callout(s) colado(s) dentro de uma seção de DESTAQUE:`,
      );
      for (const m of result.matches) {
        console.error(`  linha ${m.line}: "${m.context}"`);
      }
      console.error(
        `\n   Fix: mova o callout pra sua PRÓPRIA seção, isolada entre o \`---\` que fecha o D1 e o \`---\` que abre o D2. (O render já de-duplica — #1972 Opção A — mas o MD deve ficar correto.)`,
      );
    }
    for (const line of formatTitleOptionErrors(result.titleOptions)) console.error(line); // #13887
    process.exit(1);
  }
  return;
}
