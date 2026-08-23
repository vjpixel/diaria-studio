/**
 * lib/lint-checks/cli/orphan-box-in-gap.ts
 *
 * CLI handler pro check `--check orphan-box-in-gap` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { lintCalloutPlacement } from "../callout-placement.ts";
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
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check orphan-box-in-gap --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const placement = lintCalloutPlacement(md);
  const orphanGaps = findOrphanBoxWarnings(md);
  const ok = placement.ok && orphanGaps.length === 0;
  console.log(JSON.stringify({ ok, calloutPlacement: placement, orphanGaps }, null, 2));
  if (!ok) {
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
    process.exit(1);
  }
  return;
}
