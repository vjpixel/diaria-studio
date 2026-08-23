/**
 * lib/lint-checks/cli/section-counts.ts
 *
 * CLI handler pro check `--check section-counts` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkSectionCounts, type ApprovedJson } from "../url-bucket.ts";

// Modo --check section-counts (#907) — verifica que seções secundárias
// respeitam caps de #358 (lançamentos≤5, pesquisas≤3, outras=max(2, 12-d-l-p))
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md || !args.approved) {
    console.error(
      "Uso: lint-newsletter-md.ts --check section-counts --md <md-path> --approved <01-approved.json-path>",
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
  const md = readFileSync(mdPath, "utf8");
  const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
  const result = checkSectionCounts(md, approved);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ section-counts: ${result.violations.length} seção(ões) excede(m) cap de #358:`,
    );
    for (const v of result.violations) console.error(`  ${v}`);
    console.error(
      `\nDestaques na edição: ${result.destaques}. Caps esperados: ` +
        `lançamentos≤${result.caps.lancamento}, radar≤${result.caps.radar}, ` +
        `vídeos≤${result.caps.video} ` +
        `(#1629: radar = max(5, 12-${result.destaques}-l); #1693: vídeos≤2)`,
    );
    console.error(
      `\nFix: re-rodar /diaria-2-escrita ${args.md.match(/\d{6}/)?.[0] ?? "AAMMDD"} newsletter — ` +
        `o orchestrator agora aplica caps via apply-stage2-caps.ts antes do writer.`,
    );
    process.exit(1);
  }
  return;
}
