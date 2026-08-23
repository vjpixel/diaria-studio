/**
 * lib/lint-checks/cli/erro-intencional-placeholder.ts
 *
 * CLI handler pro check `--check erro-intencional-placeholder` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { extractRawCurrentNarrative, narrativeIsSelfConcatenated, narrativeIsGenericPlaceholder, narrativeIsCatalogShaped } from "../../../render-erro-intencional.ts";

// Modo --check erro-intencional-placeholder (#2078, estendido #3489) —
// verifica que a narrativa "Nessa edição, …" do bloco ERRO INTENCIONAL foi
// substituída pelo editor por uma declaração real ANTES da publicação.
// Nenhum outro lint pega esse caso.
//
// #3489: o check original só detectava o placeholder LITERAL
// ({PREENCHER_NARRATIVA_DO_ERRO} intacto). Prosa corrompida/genérica que
// SUBSTITUIU o placeholder (mas não é uma declaração válida) passava
// silenciosamente — foi exatamente o que aconteceu no #3485, cujo fallback
// não-idempotente produzia "Nessa edição, Na última edição, escrevi que a
// Acme foi fundada em 2020, quando na verdade foi em 2022." (texto
// agramatical e auto-contraditório, sem o literal `{PREENCHER...}`).
// Estendido pra reusar os mesmos predicados de classificação que
// `extractCurrentDeclarationFromMd` já aplica na extração (#2377/#2411),
// mais o predicado novo de auto-concatenação (#3489) — elimina a
// divergência de rigor entre extração e lint em vez de criar uma terceira
// regra paralela.
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error(
      "Uso: lint-newsletter-md.ts --check erro-intencional-placeholder --md <md-path>",
    );
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const hasPlaceholder = /\{PREENCHER_NARRATIVA_DO_ERRO\}/.test(md);
  let label: string | undefined;
  if (hasPlaceholder) {
    label =
      "erro-intencional-placeholder: placeholder {PREENCHER_NARRATIVA_DO_ERRO} ainda presente — preencha a narrativa do erro desta edição no bloco ERRO INTENCIONAL antes de publicar";
  } else {
    // (#3489) Placeholder literal ausente — mas a prosa que o substituiu
    // pode ainda assim ser inválida (corrompida/genérica/catalog-shaped).
    // Extração CRUA (sem filtro) pra classificar a razão específica.
    const rawNarrative = extractRawCurrentNarrative(md);
    if (rawNarrative) {
      if (narrativeIsSelfConcatenated(rawNarrative)) {
        label =
          `erro-intencional-placeholder: narrativa corrompida por auto-concatenação — ` +
          `"Nessa edição, ${rawNarrative.slice(0, 120)}${rawNarrative.length > 120 ? "…" : ""}." ` +
          `começa com "Na última edição," (abertura do reveal da edição ANTERIOR, não da ` +
          `declaração desta edição). Sinal da mesma classe de bug do #3485 — reescreva a ` +
          `narrativa desta edição no bloco ERRO INTENCIONAL antes de publicar.`;
      } else if (narrativeIsGenericPlaceholder(rawNarrative)) {
        label =
          `erro-intencional-placeholder: narrativa genérica — "Nessa edição, ` +
          `${rawNarrative.slice(0, 120)}${rawNarrative.length > 120 ? "…" : ""}." parece ` +
          `texto copiado do bloco de convite ao sorteio (contém frases como "há um erro ` +
          `proposital", "responda este e-mail", "concorrer ao sorteio"), não uma declaração ` +
          `real. Preencha a narrativa específica do erro desta edição antes de publicar.`;
      } else if (narrativeIsCatalogShaped(rawNarrative)) {
        label =
          `erro-intencional-placeholder: narrativa catalog-shaped — "Nessa edição, ` +
          `${rawNarrative.slice(0, 120)}${rawNarrative.length > 120 ? "…" : ""}." começa com ` +
          `um label interno (ex: "DESTAQUE N") em vez de prosa first-person legível pelo ` +
          `assinante. Preencha a narrativa desta edição antes de publicar.`;
      }
    }
  }
  const result = { ok: !label, label };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ ${result.label}`);
    process.exit(1);
  }
  return;
}
