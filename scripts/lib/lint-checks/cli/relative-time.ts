/**
 * lib/lint-checks/cli/relative-time.ts
 *
 * CLI handler pro check `--check relative-time` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { lintRelativeTime } from "../relative-time.ts";

// Modo --check relative-time (#747) — detecta referências temporais relativas
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "relative-time");
  const result = lintRelativeTime(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ ${result.matches.length} referência(s) temporal(is) relativa(s) detectada(s):`,
    );
    for (const m of result.matches) {
      console.error(
        `  linha ${m.line}: relative_time: '${m.word}' encontrado — edição publica D+1, use data absoluta\n    contexto: "...${m.context}..."`,
      );
    }
    process.exit(1);
  }
  return;
}
