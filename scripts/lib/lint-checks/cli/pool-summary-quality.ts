/**
 * lib/lint-checks/cli/pool-summary-quality.ts (#9358)
 *
 * CLI handler pro check `--check pool-summary-quality` de lint-newsletter-md.ts.
 * Exit 1 quando algum item do pool tem resumo defeituoso — é o exit que
 * `check-invariants --stage 2` (`reviewed-pool-summary-quality`) usa pra
 * recusar o sentinel da Etapa 2 até o orchestrator reescrever. No agregador
 * `--stage 4 --json` o mesmo check entra como warn-only (ver docstring de
 * `pool-summary-quality.ts`).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkPoolSummaryQuality, POOL_SUMMARY_DEFECT_HINT } from "../pool-summary-quality.ts";

export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check pool-summary-quality --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const result = checkPoolSummaryQuality(readFileSync(mdPath, "utf8"));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ pool-summary-quality: ${result.errors.length} resumo(s) de item do pool a reescrever:`);
    for (const e of result.errors) {
      console.error(`  ${e.section} linha ${e.line}: "${e.titleExcerpt}" (${e.url})`);
      console.error(`    → "${e.descriptionExcerpt}"`);
      for (const d of e.defects) console.error(`    - ${POOL_SUMMARY_DEFECT_HINT[d]}`);
    }
    console.error(
      `\nFix: reescreva cada resumo em 1–2 frases completas, em PT-BR, com o fato central (o quê, quem, número/nome) — ` +
        `abra a fonte (WebFetch na URL) quando o resumo atual for só o teaser/gancho; edite só a linha da descrição.`,
    );
    process.exit(1);
  }
}
