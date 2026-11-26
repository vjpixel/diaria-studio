/**
 * lib/lint-checks/cli/section-links-resolve.ts
 *
 * CLI handler pro check `--check section-links-resolve` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { checkSectionLinksResolve } from "../section-links-resolve.ts";

// Modo --check section-links-resolve (#3821) — roda o parser REAL
// (parseSections) e falha se algum item de seção secundária saiu com
// url vazia (formato não reconhecido por nenhum branch de parseListItems,
// ex: 2 links markdown na mesma linha em VÍDEOS).
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "section-links-resolve");
  const result = checkSectionLinksResolve(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ section-links-resolve: ${result.errors.length} item(ns) sem URL (formato não reconhecido pelo parser real):`,
    );
    for (const e of result.errors) {
      console.error(`  [${e.section}] ${e.titleExcerpt}`);
    }
    console.error(
      `\nFix: o item degradou pro fallback legado de parseListItems (linha inteira virou title cru, url/description vazios) — geralmente 2 links markdown na mesma linha (ex: **[Título]** — [Canal](URL)) ou blank line entre título e descrição do mesmo item. Reescreva o item em 02-reviewed.md como [Título](URL) numa linha + descrição na linha IMEDIATAMENTE seguinte (sem blank line entre elas). Ver context/templates/newsletter.md.`,
    );
    process.exit(1);
  }
  return;
}
