/**
 * lib/lint-checks/cli/radar-summary-matches-title.ts
 *
 * CLI handler pro check `--check radar-summary-matches-title` (#8594).
 * WARN-ONLY: exit 0 mesmo com matches.
 */

import { readMdArg } from "./_shared.ts";
import { checkRadarSummaryMatchesTitle } from "../radar-summary-matches-title.ts";

export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "radar-summary-matches-title");
  const result = checkRadarSummaryMatchesTitle(md);
  console.log(JSON.stringify(result, null, 2));
  if (result.warning) console.error(`\n⚠️  ${result.warning}`);
  if (!result.ok) {
    console.error(
      `\n⚠️  radar-summary-matches-title: ${result.errors.length} item(ns) com descrição sem relação com o título/URL:`,
    );
    for (const e of result.errors) {
      console.error(`  ${e.section} linha ${e.line} (${e.reason}): "${e.titleExcerpt}" → "${e.descriptionExcerpt}"`);
    }
  }
  return;
}
