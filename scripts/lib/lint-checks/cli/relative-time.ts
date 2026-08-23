/**
 * lib/lint-checks/cli/relative-time.ts
 *
 * CLI handler pro check `--check relative-time` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { lintRelativeTime } from "../relative-time.ts";

// Modo --check relative-time (#747) — detecta referências temporais relativas
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check relative-time --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
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
