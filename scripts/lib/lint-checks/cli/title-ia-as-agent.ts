/**
 * lib/lint-checks/cli/title-ia-as-agent.ts
 *
 * CLI handler pro check `--check title-ia-as-agent` de lint-newsletter-md.ts
 * (#12106). Mesmo molde de `title-mentions-ia.ts`: WARN-ONLY, exit 0 mesmo
 * com matches.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkTitleIaAsAgent } from "../title-ia-as-agent.ts";

export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check title-ia-as-agent --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkTitleIaAsAgent(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n⚠️  title-ia-as-agent: ${result.errors.length} título(s) põem "IA" como sujeito com ator humano no corpo:`,
    );
    for (const e of result.errors) {
      console.error(`  D${e.destaque} (${e.category}) linha ${e.line} [IA ${e.verb} / ${e.humanActor}]: "${e.title}"`);
    }
    console.error(
      `\nQuem age é o humano; a IA é o instrumento (ex.: "criminosos usam IA para copiar seu rosto"). ` +
        `Ver context/editorial-rules.md seção 3.`,
    );
    // WARN-ONLY (#12106): exit 0 mesmo com matches.
  }
}
