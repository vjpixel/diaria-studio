/**
 * lib/lint-checks/cli/destaque-category-noticias.ts (#8200)
 *
 * CLI handler pro check `--check destaque-category-noticias` de
 * `lint-newsletter-md.ts`. Mesmo shape dos demais handlers extraídos (#5895),
 * espelha `cli/banned-lexicon.ts` (#7260).
 */

import { readMdArg } from "./_shared.ts";
import { checkDestaqueCategoryNoticias } from "../destaque-category-noticias.ts";

export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "destaque-category-noticias");
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
