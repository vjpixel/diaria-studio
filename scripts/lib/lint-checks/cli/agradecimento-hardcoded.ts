/**
 * lib/lint-checks/cli/agradecimento-hardcoded.ts
 *
 * CLI handler pro check `--check agradecimento-hardcoded` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkAgradecimentoHardcoded } from "../agradecimento-hardcoded.ts";

// Modo --check agradecimento-hardcoded (#4359) — `agradecimento-apoiadores.md`
// deveria voltar ao placeholder `{apoiadores}` a cada edição; um nome
// hardcoded persistindo por 2+ edições passou em silêncio (caso real:
// "Mônica Herculano", 260729-260731). Diferente dos outros checks, este
// lê o SNIPPET diretamente (`--snippet`, default
// `data/snippets/agradecimento-apoiadores.md` — #5227, migrado de
// `context/snippets/`), não o `02-reviewed.md`.
// WARN-ONLY — o editor decide se é reset ou se o apoiador é de fato novo
// nesta edição.
export function runCli(args: Record<string, string>, root: string): void {
  const snippetPath = resolve(root, args.snippet ?? "data/snippets/agradecimento-apoiadores.md");
  if (!existsSync(snippetPath)) {
    console.error(`Arquivo não existe: ${snippetPath}`);
    process.exit(2);
  }
  const raw = readFileSync(snippetPath, "utf8");
  const result = checkAgradecimentoHardcoded(raw);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n⚠️  agradecimento-hardcoded: '${snippetPath}' tem um nome hardcoded` +
        `${result.name ? ` ("${result.name}")` : ""}, não o placeholder '{apoiadores}'.\n` +
        `   Se esse apoiador já foi creditado numa edição anterior, resete o arquivo pro placeholder\n` +
        `   antes de rodar o Stage 2 de novo — senão o mesmo agradecimento se repete (ver #4359).`,
    );
    // WARN-ONLY (#4359, mesmo espírito do #4076): exit 0 — a decisão de
    // resetar ou manter (apoiador de fato novo nesta edição) é editorial.
  }
  return;
}
