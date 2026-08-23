/**
 * lib/lint-checks/cli/title-mentions-ia.ts
 *
 * CLI handler pro check `--check title-mentions-ia` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkTitleMentionsIA } from "../ia-in-title.ts";

// Modo --check title-mentions-ia (#4825) — título de DESTAQUE contendo
// "IA"/"AI"/"inteligência artificial". WARN-ONLY (decisão do editor): há
// exceções legítimas (manchete sobre a categoria em si, ambiguidade real,
// nome próprio/citação/nome de produto — ver `context/editorial-rules.md`
// seção 5), então o lint nunca bloqueia — só sinaliza pro editor decidir
// no gate da Etapa 4.
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check title-mentions-ia --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkTitleMentionsIA(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n⚠️  title-mentions-ia: ${result.errors.length} título(s) de destaque mencionam "IA"/"inteligência artificial":`,
    );
    for (const e of result.errors) {
      console.error(`  D${e.destaque} (${e.category}) linha ${e.line} [${e.matched}]: "${e.title}"`);
    }
    console.error(
      `\nA newsletter é sobre IA — o termo raramente carrega informação nova no título. Prefira nomear o agente ` +
        `concreto (empresa, modelo, produto). Exceções legítimas: manchete sobre a categoria em si, ambiguidade ` +
        `real, nome próprio/citação/nome de produto (ver context/editorial-rules.md seção 5).`,
    );
    // WARN-ONLY (#4825): exit 0 mesmo com matches — não bloqueia o gate.
  }
  return;
}
