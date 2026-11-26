/**
 * lib/lint-checks/cli/title-shorts-front-load.ts
 *
 * CLI handler pro check `--check title-shorts-front-load` de
 * lint-newsletter-md.ts (#12464). Mesmo molde de `title-ia-as-agent.ts`:
 * WARN-ONLY, exit 0 mesmo com avisos.
 */

import { readMdArg } from "./_shared.ts";
import { checkD1ShortsFrontLoad, formatShortsFrontLoadWarning } from "../title-shorts-front-load.ts";

export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "title-shorts-front-load");
  const result = checkD1ShortsFrontLoad(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n⚠️  title-shorts-front-load: o título do D1 não se lê sozinho no corte do feed de Shorts:`);
    for (const w of result.errors) console.error(`  ${formatShortsFrontLoadWarning(w)}`);
    console.error(`\nVer context/editorial-rules.md seção 3 (#12464).`);
    // WARN-ONLY (#12464): exit 0 mesmo com avisos.
  }
}
