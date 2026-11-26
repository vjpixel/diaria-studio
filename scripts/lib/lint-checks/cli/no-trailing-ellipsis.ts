/**
 * lib/lint-checks/cli/no-trailing-ellipsis.ts
 *
 * CLI handler pro check `--check no-trailing-ellipsis` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readMdArg } from "./_shared.ts";
import { checkNoTrailingEllipsis } from "../no-trailing-ellipsis.ts";

// Modo --check no-trailing-ellipsis (#2881) — item de seção secundária cuja
// descrição termina em `…`/`...` (reticências herdadas do snippet da fonte).
// Backstop para casos que escaparam de `sanitizeTrailingEllipsis` no Stage 1
// (ex: texto curado manualmente pelo editor). WARN-ONLY — mesma justificativa
// de title-publisher-suffix/title-trailing-period acima (#2715): heurística
// ampla, sem allowlist, não bloqueia o gate.
export function runCli(args: Record<string, string>, root: string): void {
  const { md } = readMdArg(args, root, "no-trailing-ellipsis");
  const result = checkNoTrailingEllipsis(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n⚠️  no-trailing-ellipsis: ${result.errors.length} item(ns) de seção secundária com descrição terminando em reticências:`,
    );
    for (const e of result.errors) {
      console.error(
        `  ${e.section} linha ${e.line}: "${e.titleExcerpt}" → descrição: "...${e.descriptionExcerpt}"`,
      );
    }
    console.error(
      `\nFix: a reticência é herdada do snippet/meta-description da fonte (não é nosso truncamento). Edite a descrição manualmente ou re-rode Stage 1 (enrich-inbox-articles.ts já sanitiza casos novos).`,
    );
    // WARN-ONLY (#2715): exit 0 mesmo com matches — não bloqueia o gate.
  }
  return;
}
