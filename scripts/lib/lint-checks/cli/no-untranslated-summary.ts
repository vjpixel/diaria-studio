/**
 * lib/lint-checks/cli/no-untranslated-summary.ts
 *
 * CLI handler pro check `--check no-untranslated-summary` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { checkNoUntranslatedSummary } from "../no-untranslated-summary.ts";

// Modo --check no-untranslated-summary (#3196) — item de seção secundária
// com marcador literal [TRADUZIR] OU descrição em inglês (heurística) que
// sobreviveu até o gate. GATE-BLOCKING (mirrors secondary-items-have-summary,
// #2545): um item não-traduzido não é publicável.
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "no-untranslated-summary");
  const result = checkNoUntranslatedSummary(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ no-untranslated-summary: ${result.errors.length} item(ns) de seção secundária não traduzido(s):`,
    );
    for (const e of result.errors) {
      const why = e.reason === "traduzir_prefix" ? "marcador [TRADUZIR] literal" : "heurística EN (sem marcador)";
      console.error(`  ${e.section} linha ${e.line} [${why}]: "${e.titleExcerpt}" → "${e.descriptionExcerpt}"`);
    }
    console.error(
      `\nFix: traduza a descrição pra PT-BR em 02-reviewed.md e remova o prefixo "[TRADUZIR] " se presente, antes de aprovar o gate.`,
    );
    process.exit(1);
  }
  return;
}
