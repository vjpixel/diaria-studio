/**
 * lib/lint-checks/cli/title-publisher-suffix.ts
 *
 * CLI handler pro check `--check title-publisher-suffix` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkTitlePublisherSuffix } from "../title-normalization.ts";

// Modo --check title-publisher-suffix (#2664) — título com sufixo de veículo
// (` | Veículo`, ` - Veículo`, ` — Veículo`) que não foi strippado no Stage 1.
// WARN-ONLY (#2715 item 3): orchestrator-stage-4.md §4c.2 documenta este check
// como WARN-ONLY (heurística ampla, sem allowlist — pode ter falso-positivo em
// traço editorial legítimo), mas até #2715 o CLI saía com exit 1 + ❌, o que
// contradizia a doc e podia levar o orchestrator LLM a bloquear o gate
// indevidamente. Sempre exit 0 — matches são surfaçados como ⚠️ no gate via
// `{violations_block}`, nunca bloqueiam.
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check title-publisher-suffix --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkTitlePublisherSuffix(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n⚠️  title-publisher-suffix: ${result.errors.length} título(s) com sufixo de veículo:`,
    );
    for (const e of result.errors) {
      console.error(`  linha ${e.line} [${e.separator}]: "${e.title}" → sufixo: "${e.suffix}"`);
    }
    console.error(
      `\nFix: o sufixo deveria ter sido removido pelo enrich-inbox-articles.ts (Stage 1). Edite o título manualmente ou re-rode Stage 1.`,
    );
    // WARN-ONLY (#2715): exit 0 mesmo com matches — não bloqueia o gate.
  }
  return;
}
