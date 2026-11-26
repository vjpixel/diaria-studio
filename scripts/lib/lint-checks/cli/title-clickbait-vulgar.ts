/**
 * lib/lint-checks/cli/title-clickbait-vulgar.ts
 *
 * CLI handler pro check `--check title-clickbait-vulgar` de lint-newsletter-md.ts.
 * Mesmo molde de `title-mentions-ia.ts` (#4825): warn-only, exit 0 mesmo com
 * matches — decisão final é do editor no gate da Etapa 4 (#6008).
 */

import { readMdArg } from "./_shared.ts";
import { checkTitleClickbaitVulgar } from "../title-clickbait-vulgar.ts";

export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "title-clickbait-vulgar");
  const result = checkTitleClickbaitVulgar(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n⚠️  title-clickbait-vulgar: ${result.errors.length} título(s) de destaque na faixa VULGAR de clickbait:`,
    );
    for (const e of result.errors) {
      console.error(`  D${e.destaque} (${e.category}) linha ${e.line} [${e.matched}]: "${e.title}"`);
    }
    console.error(
      `\nO padrão editorial é "clickbait elegante" (#6008): tensão factual, pergunta provocativa ou ` +
        `referência direta ao leitor — sem mentira, sem inflar fato, sem vulgaridade. Curiosity gap ` +
        `(reter informação pra forçar clique) é explicitamente proibido. WARN-ONLY: o editor decide no gate.`,
    );
    // WARN-ONLY (#6008): exit 0 mesmo com matches — não bloqueia o gate.
  }
  return;
}
