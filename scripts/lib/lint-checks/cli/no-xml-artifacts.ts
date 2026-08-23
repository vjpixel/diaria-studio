/**
 * lib/lint-checks/cli/no-xml-artifacts.ts
 *
 * CLI handler pro check `--check no-xml-artifacts` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkNoXmlArtifacts } from "../no-xml-artifacts.ts";

// Modo --check no-xml-artifacts (#4077) — tag de tool-call crua
// (`</content>`, `</invoke>`, `</function_calls>`) grudada no FIM do
// documento, sintoma de payload de tool-call vazando num fluxo assistido
// (ex: chat drawer do Studio). GATE-BLOCKING: esse texto iria direto pro
// e-mail publicado, e nenhum outro lint olha pro fim cru do arquivo.
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check no-xml-artifacts --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkNoXmlArtifacts(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ no-xml-artifacts: tag de tool-call grudada no fim do arquivo:`);
    for (const e of result.errors) {
      console.error(`  ${JSON.stringify(e.artifact)}`);
    }
    console.error(
      `\nFix: remova o trecho de tag XML solta do fim de ${args.md} — nunca é markdown editorial legítimo (ver #4077).`,
    );
    process.exit(1);
  }
  return;
}
