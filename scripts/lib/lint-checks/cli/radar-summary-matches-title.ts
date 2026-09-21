/**
 * lib/lint-checks/cli/radar-summary-matches-title.ts
 *
 * CLI handler pro check `--check radar-summary-matches-title` (#8594).
 * WARN-ONLY: exit 0 mesmo com matches.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkRadarSummaryMatchesTitle } from "../radar-summary-matches-title.ts";

export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check radar-summary-matches-title --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const result = checkRadarSummaryMatchesTitle(readFileSync(mdPath, "utf8"));
  console.log(JSON.stringify(result, null, 2));
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
