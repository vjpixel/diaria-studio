/**
 * lib/lint-checks/cli/orphan-box-in-gap.ts
 *
 * CLI handler pro check `--check orphan-box-in-gap` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { lintCalloutPlacement, formatTitleOptionErrors } from "../callout-placement.ts";
import { findOrphanBoxWarnings } from "../../newsletter-parse.ts";

// Modo --check orphan-box-in-gap (#3204, estendido pro slot 3 em #3476) —
// backstop pós marcador-agnóstico: (a) callout com forma de box (bold-line
// inteiro OU emoji-led) colado DENTRO de uma seção de destaque, sem `---`
// isolando-o (reusa lintCalloutPlacement, agora marcador-agnóstico); (b)
// lacuna (D1/D2, D2/D3) OU região pós-último-destaque (slot 3, entre o
// último destaque e USE MELHOR/É IA?) com MAIS de 1 bloco extra
// `---`-isolado — ambíguo, `locateBoxInGap`/`locateBoxAfterLastDestaque`
// descartariam os excedentes silenciosamente (findOrphanBoxWarnings).
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "orphan-box-in-gap");
  const placement = lintCalloutPlacement(md);
  const orphanGaps = findOrphanBoxWarnings(md);
  const ok = placement.ok && orphanGaps.length === 0;
  console.log(JSON.stringify({ ok, calloutPlacement: placement, orphanGaps }, null, 2));
  if (!ok) {
    if (placement.matches.length > 0 || orphanGaps.length > 0) {
      console.error(
        `\n❌ possível box de divulgação órfão (marcador não reconhecido NÃO é mais o problema — a extração é por posição; o problema é ESTRUTURA ambígua):`,
      );
      for (const m of placement.matches) {
        console.error(
          `  linha ${m.line}: "${m.context}" — parece um box colado DENTRO de uma seção de destaque, sem \`---\` isolando-o.`,
        );
      }
      for (const w of orphanGaps) {
        console.error(`  ${w.reason}`);
      }
      console.error(
        `\n   Fix: isole o box em sua PRÓPRIA seção, entre o \`---\` que fecha o destaque anterior e o \`---\` que abre o próximo — exatamente 1 bloco extra por lacuna.`,
      );
    }
    // #13887: opções extras de título do writer — o fix é podar, não mover caixa.
    for (const line of formatTitleOptionErrors(placement.titleOptions)) console.error(line);
    process.exit(1);
  }
  return;
}
