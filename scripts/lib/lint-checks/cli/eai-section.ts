/**
 * lib/lint-checks/cli/eai-section.ts
 *
 * CLI handler pro check `--check eai-section` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { checkEaiSection } from "../eai-section.ts";

// Modo --check eai-section (#588) — verifica presença da seção É IA?
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "eai-section");
  const result = checkEaiSection(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ ${result.error}`);
    process.exit(1);
  }
  return;
}
