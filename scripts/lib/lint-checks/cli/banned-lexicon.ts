/**
 * lib/lint-checks/cli/banned-lexicon.ts (#7260)
 *
 * CLI handler pro check `--check banned-lexicon` de `lint-newsletter-md.ts`.
 * Mesmo shape dos demais handlers extraídos (#5895) — leitura de args,
 * chamada do check puro, formatação de erro/exit code.
 */

import { readMdArg } from "./_shared.ts";
import { checkBannedLexicon } from "../banned-lexicon.ts";

export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "banned-lexicon");
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
