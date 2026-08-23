/**
 * lib/lint-checks/cli/secondary-item-coherence.ts
 *
 * CLI handler pro check `--check secondary-item-coherence` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkSecondaryItemCoherence } from "../secondary-item-coherence.ts";
import { type ApprovedJson } from "../url-bucket.ts";

// Modo --check secondary-item-coherence (#5663) — backstop estrutural
// cruzando descrições secundárias com o summary bruto do approved.
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md || !args.approved) {
    console.error(
      "Uso: lint-newsletter-md.ts --check secondary-item-coherence --md <md-path> --approved <01-approved.json>",
    );
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  const approvedPath = resolve(root, args.approved);
  if (!existsSync(mdPath) || !existsSync(approvedPath)) {
    console.error(
      `Arquivo não encontrado: ${!existsSync(mdPath) ? mdPath : approvedPath}`,
    );
    process.exit(2);
  }
  const result = checkSecondaryItemCoherence(
    readFileSync(mdPath, "utf8"),
    JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson,
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ secondary-item-coherence: ${result.errors.length} item(ns) secundário(s) com saída incoerente:`,
    );
    for (const e of result.errors) {
      console.error(`  ${e.kind} — ${e.section} linha ${e.line}: "${e.titleExcerpt}"`);
    }
    process.exit(1);
  }
  return;
}
