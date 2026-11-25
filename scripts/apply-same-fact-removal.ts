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
 * Com --current-edition AAMMDD, compara o pool com os destaques finais (#13844),
 * também após gate manual. Itens completos ficam no log para restauração.
 * Fail-soft: theme-check ausente/ilegível → nada removido do histórico, exit 0.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isEditorPinned } from "./lib/pool-quality.ts";
import { sameStorySignal } from "./lib/story-grouping.ts";
import type { StageArticle } from "./lib/apply-stage2-caps.ts";
import { runMain } from "./lib/exit-handler.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { removeSameFactSecondary, type SameFactWarning } from "./lib/same-fact-check.ts";

/** #13844: compare only the final highlights with the current pool.
 * Full entries in the removal log let the editor restore them at gate 4.
 * IPO wording is normalized locally: no broader cross-edition removal rule.
 */
export function removeCurrentHighlightRepeats(approved: Record<string, unknown>, edition: string) {
  const article = (value: StageArticle & { article?: StageArticle }): StageArticle => value?.article ?? value ?? {};
  const title = (value: StageArticle & { article?: StageArticle }): string => String(article(value).title ?? "").replace(
    /initial public offering|stock market debut|estreia na bolsa|(?:first|second) day of trading/gi, "IPO",
  );
  const highlights = Array.isArray(approved.highlights) ? approved.highlights : [];
  const out = { ...approved };
  const removed: Record<string, unknown>[] = [];
  for (const bucket of ["radar", "lancamento", "use_melhor"]) {
    const items = approved[bucket];
    if (!Array.isArray(items)) continue;
    out[bucket] = items.filter((item) => {
      const a = article(item);
      if (!a.url || isEditorPinned(item) || isEditorPinned(a)) return true;
      const match = highlights.find((h) => sameStorySignal(title(item), title(h)));
      if (!match) return true;
      removed.push({ bucket, title: a.title, url: a.url, item,
        matched_edition: edition, matched_title: article(match).title,
        matched_url: article(match).url, matched_bucket: "highlight",
        shared_products: [], evidence: "title", scope: "current-edition" });
      return false;
    });
  }
  return { approved: out, removed };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2)).values;
  const approvedPath = args["approved"];
  const themeCheckPath = args["theme-check"];
  const outLog = args["out-log"];
  if (!approvedPath || (!themeCheckPath && !args["current-edition"]) || !outLog) {
    console.error("Uso: apply-same-fact-removal.ts --approved <path> [--theme-check <path> | --current-edition AAMMDD] --out-log <path>");
    process.exit(1);
  }

  let warnings: SameFactWarning[] = [];
  if (themeCheckPath && existsSync(themeCheckPath)) {
    try {
      const parsed = JSON.parse(readFileSync(themeCheckPath, "utf8")) as { same_fact_warnings?: unknown };
      if (Array.isArray(parsed.same_fact_warnings)) warnings = parsed.same_fact_warnings as SameFactWarning[];
    } catch (err) {
      console.error(`[apply-same-fact-removal] WARN: ${themeCheckPath} ilegível (${(err as Error).message}) — nada removido.`);
    }
  } else if (themeCheckPath) {
    console.error(`[apply-same-fact-removal] WARN: ${themeCheckPath} ausente — nada removido.`);
  }

  const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as Record<string, unknown>;
  const { approved: filtered, removed } = args["current-edition"]
    ? removeCurrentHighlightRepeats(approved, args["current-edition"])
    : removeSameFactSecondary(approved, warnings);
  if (removed.length > 0) {
    writeFileSync(approvedPath, JSON.stringify(filtered, null, 2), "utf8");
  }
  // Preserve historical removals and current-edition entries across retries.
  const previous = existsSync(outLog) ? JSON.parse(readFileSync(outLog, "utf8")).removed ?? [] : [];
  const entries = new Map([...previous, ...removed].map((r) => [`${r.bucket}:${r.url}`, r]));
  writeFileSync(outLog, JSON.stringify({ removed: [...entries.values()] }, null, 2), "utf8");
  for (const r of removed) {
    console.error(
      `[apply-same-fact-removal] 🗑️  [${r.bucket}] "${r.title}" removido — MESMO FATO de ${r.matched_edition} "${r.matched_title}" (produto: ${(r.shared_products as string[]).join(", ")})`,
    );
  }
  process.stdout.write(JSON.stringify({ removed: removed.length }) + "\n");
}

if (isMainModule(import.meta.url)) {
  runMain(main);
}
