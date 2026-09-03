/**
 * lib/lint-checks/cli/banned-lexicon.ts (#7260)
 *
 * CLI handler pro check `--check banned-lexicon` de `lint-newsletter-md.ts`.
 * Mesmo shape dos demais handlers extraídos (#5895) — leitura de args,
 * chamada do check puro, formatação de erro/exit code.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkBannedLexicon } from "../banned-lexicon.ts";

export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check banned-lexicon --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkBannedLexicon(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ ${result.errors.length} termo(s) de léxico banido em ${args.md}:`);
    for (const e of result.errors) {
      console.error(
        `  linha ${e.line}: "${e.matched}" → use "${e.correct}" (${e.sourceIssue}) — "${e.excerpt}"`,
      );
    }
    process.exit(1);
  }
  return;
}
