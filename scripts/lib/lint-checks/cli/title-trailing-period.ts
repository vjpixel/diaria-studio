/**
 * lib/lint-checks/cli/title-trailing-period.ts
 *
 * CLI handler pro check `--check title-trailing-period` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkTitleTrailingPeriod } from "../title-normalization.ts";

// Modo --check title-trailing-period (#2672) — título terminando com ponto final.
// Manchetes não terminam em ponto. Residual de og:title.
// WARN-ONLY (#2715 item 3) — mesma justificativa de title-publisher-suffix acima.
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check title-trailing-period --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkTitleTrailingPeriod(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n⚠️  title-trailing-period: ${result.errors.length} título(s) terminando com ponto final:`,
    );
    for (const e of result.errors) {
      console.error(`  linha ${e.line}: "${e.title}"`);
    }
    console.error(
      `\nFix: o ponto final deveria ter sido removido pelo enrich-inbox-articles.ts (Stage 1). Edite o título manualmente ou re-rode Stage 1.`,
    );
    // WARN-ONLY (#2715): exit 0 mesmo com matches — não bloqueia o gate.
  }
  return;
}
