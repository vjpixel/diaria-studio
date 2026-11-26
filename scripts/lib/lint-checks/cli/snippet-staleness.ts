/**
 * lib/lint-checks/cli/snippet-staleness.ts
 *
 * CLI handler pro check `--check snippet-staleness` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { resolveMdArg } from "./_shared.ts";
import { runSnippetStalenessCheck } from "../snippet-staleness.ts";

// Modo --check snippet-staleness (#4076) — snippet de data/snippets/
// (ou platform.config.json > boxes_divulgacao) usado nesta edição foi
// editado DEPOIS do stitch (Stage 2) — a mudança ficou presa no
// snippet-fonte, nunca chegou a 02-reviewed.md. WARN-ONLY (nunca bloqueia
// o gate): reaplicar automaticamente arriscaria clobberar uma edição que
// o editor tenha feito direto no MD.
export function runCli(args: Record<string, string>, root: string): void {
  const mdPath = resolveMdArg(args, root, "snippet-staleness");
  const result = runSnippetStalenessCheck(mdPath, root);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n⚠️  snippet-staleness: ${result.warnings.length} arquivo(s) editado(s) APÓS o stitch (Stage 2):`,
    );
    for (const w of result.warnings) {
      console.error(
        `  '${w.file}' foi editado APÓS o stitch — a mudança NÃO está em ${args.md} (${w.lag_minutes} min de atraso).\n` +
          `   Reaplique manualmente ou re-rode o Stage 2.`,
      );
    }
    // WARN-ONLY (#4076): exit 0 mesmo com warnings — não bloqueia o gate.
  }
  return;
}
