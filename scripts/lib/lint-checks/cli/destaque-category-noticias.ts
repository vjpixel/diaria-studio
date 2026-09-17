/**
 * lib/lint-checks/cli/destaque-category-noticias.ts (#8200)
 *
 * CLI handler pro check `--check destaque-category-noticias` de
 * `lint-newsletter-md.ts`. Mesmo shape dos demais handlers extraídos (#5895),
 * espelha `cli/banned-lexicon.ts` (#7260).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkDestaqueCategoryNoticias } from "../destaque-category-noticias.ts";

export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check destaque-category-noticias --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkDestaqueCategoryNoticias(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ ${result.errors.length} destaque(s) com categoria 'NOTÍCIAS' (#6083) em ${args.md}:`);
    for (const e of result.errors) {
      console.error(
        `  linha ${e.line}: DESTAQUE ${e.destaqueNumber} — "${e.category}" (#6083, categoria nunca deve ser 'notícias') — "${e.excerpt}"`,
      );
    }
    process.exit(1);
  }
  return;
}
