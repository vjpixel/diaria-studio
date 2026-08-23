/**
 * lib/lint-checks/cli/erro-intencional-narrative-generico.ts
 *
 * CLI handler pro check `--check erro-intencional-narrative-generico` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { extractCurrentDeclarationFromMd, narrativeIsGenericPlaceholder } from "../../../render-erro-intencional.ts";

// Modo --check erro-intencional-narrative-generico (#2377) — verifica que a
// narrativa "Nessa edição, …" no bloco ERRO INTENCIONAL é uma declaração
// específica de primeira pessoa do editor (não um placeholder genérico copiado
// do bloco de convite ao sorteio). Root cause do bug #2377: "há um erro
// proposital escondido em um dos destaques. Responda este e-mail com a correção
// para concorrer ao sorteio" foi gravado como narrative e formatado verbatim no
// reveal da edição seguinte. Guard determinístico aqui pega isso no gate Stage 4
// ANTES de publicar — muito mais cedo do que a publicação incorreta.
//
// Bloqueante: o editor precisa escrever a narrativa real ("Nessa edição, escrevi
// que [X], quando o correto é [Y]") antes de aprovar o gate.
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error(
      "Uso: lint-newsletter-md.ts --check erro-intencional-narrative-generico --md <md-path>",
    );
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const extracted = extractCurrentDeclarationFromMd(md);
  let isGeneric = false;
  let label: string | undefined;
  if (extracted && extracted.narrative) {
    isGeneric = narrativeIsGenericPlaceholder(extracted.narrative);
    if (isGeneric) {
      label =
        `erro-intencional-narrative-generico: a narrativa "Nessa edição, ${extracted.narrative}." ` +
        `parece ser um placeholder genérico copiado do bloco de convite ao sorteio (contém frases ` +
        `como "há um erro proposital", "responda este e-mail", "concorrer ao sorteio"). ` +
        `O reveal da próxima edição sairá com esse texto genérico em vez do erro real. ` +
        `Substitua pela declaração específica de primeira pessoa do editor: ` +
        `"Nessa edição, escrevi que [afirmação errada], quando o correto é [valor correto]."`;
    }
  }
  const result = { ok: !isGeneric, label };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ ${result.label}`);
    process.exit(1);
  }
  return;
}
