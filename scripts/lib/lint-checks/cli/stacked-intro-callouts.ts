/**
 * lib/lint-checks/cli/stacked-intro-callouts.ts
 *
 * CLI handler pro check `--check stacked-intro-callouts` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { lintStackedIntroCallouts } from "../callout-placement.ts";

// Modo --check stacked-intro-callouts (#2729) — ≥2 blocos `**(🎉|📣)…**`
// empilhados na região de intro (antes do 1º `**DESTAQUE`) fundem no
// `extractIntroCallout` greedy (#2727): `**` internos vazam como texto
// literal + separador "Divulgação" do bloco 📣 se perde.
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "stacked-intro-callouts");
  const result = lintStackedIntroCallouts(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ ${result.count} blocos de callout (🎉/📣) empilhados na região de intro (linhas ${result.lines.join(", ")}):`,
    );
    console.error(
      `\n   Fix: manter só 1 bloco \`**🎉/📣 …**\` na região de intro (antes do 1º **DESTAQUE). Blocos empilhados fundem no render (extractIntroCallout é greedy, #2727) — \`**\` internos vazam como texto literal e o separador "Divulgação" do bloco patrocinado se perde. Se 2 CTAs são necessários, mesclar num único bloco ou mover o 2º para uma lacuna entre destaques (box de divulgação).`,
    );
    process.exit(1);
  }
  return;
}
