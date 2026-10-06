/**
 * check-no-arrow-glyph.ts (#9721, #9723): falha se a seta `→` ou `←` aparecer no que chega
 * ao leitor: HTML/CSS/JS publicados (`workers/site/public/**`, cursos,
 * livros), literais de string dos geradores/templates do site e da
 * newsletter, e caixas da newsletter (`data/snippets/**`, quando existir).
 *
 * Pedido do editor (06/10/2026): tirar a seta de botões, links, CTAs e copy e
 * nunca mais incluí-la; estendido à seta `←` dos links de volta/anterior
 * (#9723, decisão do editor de 05/10/2026). Critério, superfícies e allowlist documentada:
 * `scripts/lib/no-arrow-glyph-scan.ts`.
 *
 * Roda no job "Static invariants check" de `.github/workflows/pr-checks.yml`
 * (todo PR). Local: `npx tsx scripts/check-no-arrow-glyph.ts`. No CI
 * `data/snippets/` não existe (gitignored); o check só avisa e segue.
 *
 * Exit codes: 0 = limpo; 1 = seta encontrada (ou allowlist obsoleta).
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { scanRepo, type Finding, type ScanResult } from "./lib/no-arrow-glyph-scan.ts";

const KIND_LABEL: Record<Finding["kind"], string> = {
  published: "publicado",
  generator: "gerador (literal de string)",
  snippet: "caixa data/snippets",
  "stale-allowlist": "allowlist obsoleta (trecho sumiu do arquivo)",
  "missing-generator": "gerador listado não existe (renomeado? atualize GENERATOR_SPECS)",
};

export function formatReport(result: ScanResult): { ok: boolean; text: string } {
  const lines: string[] = [];
  const summary =
    `[check-no-arrow-glyph] ${result.scannedPublished} arquivos publicados, ` +
    `${result.scannedGenerators} geradores, ` +
    (result.snippetsPresent ? `${result.scannedSnippets} caixas` : "data/snippets/ ausente (pulado, fail-soft)");
  lines.push(summary);
  if (result.findings.length === 0) {
    lines.push("[check-no-arrow-glyph] OK: nenhuma seta → ou ← no que chega ao leitor (#9721, #9723).");
    return { ok: true, text: lines.join("\n") };
  }
  lines.push(`[check-no-arrow-glyph] FALHA: ${result.findings.length} ocorrência(s) da seta → ou ← (#9721, #9723):`);
  for (const f of result.findings) {
    const where = f.line > 0 ? `${f.path}:${f.line}:${f.col}` : f.path;
    lines.push(`  - [${KIND_LABEL[f.kind]}] ${where}  …${f.context}…`);
  }
  lines.push(
    "Tire a seta (→ ou ←) do botão/link/CTA/copy (regra do editor, #9721/#9723). A única seta permitida é a de direção da nav do site (← no início de <a rel=prev>, → no fim de <a rel=next>, #9743). Exceção legítima (texto editorial antigo, não UI) vai em ALLOWLIST de scripts/lib/no-arrow-glyph-scan.ts com o trecho exato e o motivo.",
  );
  return { ok: false, text: lines.join("\n") };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { ok, text } = formatReport(scanRepo(root));
  if (ok) console.log(text);
  else console.error(text);
  process.exitCode = ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) main();
