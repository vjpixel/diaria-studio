/**
 * apply-same-fact-removal.ts (#9386)
 *
 * Em `--no-gates` (Stage 1 post-gate `--auto`) o aviso de MESMO FATO do
 * `check-highlight-themes.ts` não tem gate 1 onde o editor possa agir — o item
 * seguia para a escrita e só reaparecia no gate 4. Este passo remove do
 * `01-approved.json` os itens de RADAR/LANÇAMENTOS com `same_fact_warnings`
 * e grava a lista em `_internal/01-same-fact-removed.json`, que o Stage 4
 * apresenta no gate. Destaques nunca são removidos (só aviso).
 *
 * Uso:
 *   npx tsx scripts/apply-same-fact-removal.ts --approved <01-approved.json> \
 *     --theme-check <01-highlight-theme-check.json> --out-log <01-same-fact-removed.json>
 *
 * Fail-soft: theme-check ausente/ilegível → nada removido, exit 0.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { runMain } from "./lib/exit-handler.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { removeSameFactSecondary, type SameFactWarning } from "./lib/same-fact-check.ts";

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2)).values;
  const approvedPath = args["approved"];
  const themeCheckPath = args["theme-check"];
  const outLog = args["out-log"];
  if (!approvedPath || !themeCheckPath || !outLog) {
    console.error("Uso: apply-same-fact-removal.ts --approved <path> --theme-check <path> --out-log <path>");
    process.exit(1);
  }

  let warnings: SameFactWarning[] = [];
  if (existsSync(themeCheckPath)) {
    try {
      const parsed = JSON.parse(readFileSync(themeCheckPath, "utf8")) as { same_fact_warnings?: unknown };
      if (Array.isArray(parsed.same_fact_warnings)) warnings = parsed.same_fact_warnings as SameFactWarning[];
    } catch (err) {
      console.error(`[apply-same-fact-removal] WARN: ${themeCheckPath} ilegível (${(err as Error).message}) — nada removido.`);
    }
  } else {
    console.error(`[apply-same-fact-removal] WARN: ${themeCheckPath} ausente — nada removido.`);
  }

  const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as Record<string, unknown>;
  const { approved: filtered, removed } = removeSameFactSecondary(approved, warnings);
  if (removed.length > 0) {
    writeFileSync(approvedPath, JSON.stringify(filtered, null, 2), "utf8");
  }
  writeFileSync(outLog, JSON.stringify({ removed }, null, 2), "utf8");
  for (const r of removed) {
    console.error(
      `[apply-same-fact-removal] 🗑️  [${r.bucket}] "${r.title}" removido — MESMO FATO de ${r.matched_edition} "${r.matched_title}" (produto: ${r.shared_products.join(", ")})`,
    );
  }
  process.stdout.write(JSON.stringify({ removed: removed.length }) + "\n");
}

if (isMainModule(import.meta.url)) {
  runMain(main);
}
