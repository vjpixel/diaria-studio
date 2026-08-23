/**
 * lib/lint-checks/cli/mid-sentence-ellipsis.ts
 *
 * CLI handler pro check `--check mid-sentence-ellipsis` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkMidSentenceEllipsis } from "../mid-sentence-ellipsis.ts";

// Modo --check mid-sentence-ellipsis (#3196) — item de seção secundária cuja
// descrição contém `…`/`...` no MEIO da frase (backstop pra truncamento de
// meta-description de veículo que não termina no fim da string, ex: G1).
// WARN-ONLY — mesma justificativa de no-trailing-ellipsis acima (#2715):
// heurística ampla, sem allowlist, também pega reticência estilística
// legítima no meio da frase; o editor decide.
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check mid-sentence-ellipsis --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkMidSentenceEllipsis(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n⚠️  mid-sentence-ellipsis: ${result.errors.length} item(ns) de seção secundária com reticência NO MEIO da descrição:`,
    );
    for (const e of result.errors) {
      console.error(
        `  ${e.section} linha ${e.line}: "${e.titleExcerpt}" → descrição: "${e.descriptionExcerpt}"`,
      );
    }
    console.error(
      `\nFix: a reticência é herdada do snippet/meta-description da fonte truncada no meio (não é nosso truncamento), OU é um uso estilístico legítimo — decida caso a caso e edite a descrição manualmente se necessário.`,
    );
    // WARN-ONLY (#2715): exit 0 mesmo com matches — não bloqueia o gate.
  }
  return;
}
