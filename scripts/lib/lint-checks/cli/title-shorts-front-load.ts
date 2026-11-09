/**
 * lib/lint-checks/cli/title-shorts-front-load.ts
 *
 * CLI handler pro check `--check title-shorts-front-load` de
 * lint-newsletter-md.ts (#12464). Mesmo molde de `title-ia-as-agent.ts`:
 * WARN-ONLY, exit 0 mesmo com avisos.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkD1ShortsFrontLoad, formatShortsFrontLoadWarning } from "../title-shorts-front-load.ts";

export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check title-shorts-front-load --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const result = checkD1ShortsFrontLoad(readFileSync(mdPath, "utf8"));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n⚠️  title-shorts-front-load: o título do D1 não se lê sozinho no corte do feed de Shorts:`);
    for (const w of result.errors) console.error(`  ${formatShortsFrontLoadWarning(w)}`);
    console.error(`\nVer context/editorial-rules.md seção 3 (#12464).`);
    // WARN-ONLY (#12464): exit 0 mesmo com avisos.
  }
}
