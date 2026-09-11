#!/usr/bin/env tsx
/**
 * scripts/backfill-scoring-features.ts (#7975, Camada 1 da #7972)
 *
 * Grava (ou re-grava, se `--force`) `_internal/scoring-features.json` para
 * cada edição que tenha `01-categorized.json` — histórica (backfill 1x, ver
 * #7972 §"Correção de premissa") ou corrente (chamada diária, um comando).
 *
 * Nunca modifica nem apaga nenhum arquivo existente da edição — só escreve
 * o arquivo novo `scoring-features.json`. Read-only sobre tudo o mais.
 *
 * Uso:
 *   npx tsx scripts/backfill-scoring-features.ts --all [--editions-dir DIR] [--force]
 *   npx tsx scripts/backfill-scoring-features.ts --edition AAMMDD [--editions-dir DIR] [--force]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { extractScoringFeatures, editionDateFromAammdd, type ScoringFeatureRow } from "./lib/scoring-features.ts";

const ROOT = resolve(import.meta.dirname, "..");

export interface BackfillResult {
  edition: string;
  status: "written" | "skipped-exists" | "skipped-no-categorized" | "error";
  rows?: number;
  error?: string;
}

/** Processa 1 edição. Puro em relação a I/O de rede — só filesystem local. */
export async function processEdition(editionDir: string, edition: string, force: boolean): Promise<BackfillResult> {
  const categorizedPath = join(editionDir, "_internal", "01-categorized.json");
  if (!existsSync(categorizedPath)) return { edition, status: "skipped-no-categorized" };

  const outPath = join(editionDir, "_internal", "scoring-features.json");
  if (existsSync(outPath) && !force) return { edition, status: "skipped-exists" };

  try {
    const json = JSON.parse(readFileSync(categorizedPath, "utf8"));
    const editionDate = editionDateFromAammdd(edition);
    const rows = await extractScoringFeatures(json, editionDate);
    const payload = {
      edition,
      generated_at: new Date().toISOString(),
      edition_date_resolved: editionDate ? editionDate.toISOString() : null,
      row_count: rows.length,
      rows,
    };
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return { edition, status: "written", rows: rows.length };
  } catch (err) {
    return { edition, status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runBackfill(editionsRoot: string, opts: { edition?: string; force: boolean }): Promise<BackfillResult[]> {
  const editionDirs = enumerateEditionDirs(editionsRoot);
  const targets: Array<[string, string]> = opts.edition
    ? editionDirs.has(opts.edition)
      ? [[opts.edition, editionDirs.get(opts.edition)!]]
      : []
    : [...editionDirs.entries()].sort(([a], [b]) => a.localeCompare(b));

  const results: BackfillResult[] = [];
  for (const [edition, dir] of targets) {
    results.push(await processEdition(dir, edition, opts.force));
  }
  return results;
}

function summarize(results: BackfillResult[]): void {
  const byStatus: Record<string, number> = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const totalRows = results.reduce((sum, r) => sum + (r.rows ?? 0), 0);
  console.log(
    `[backfill-scoring-features] ${results.length} edições processadas — ${JSON.stringify(byStatus)} — ${totalRows} linhas de feature gravadas no total.`,
  );
  for (const r of results) {
    if (r.status === "error") console.error(`  ERRO ${r.edition}: ${r.error}`);
  }
}

if (isMainModule(import.meta.url)) {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const edition = values["edition"];
  const all = flags.has("all");
  const force = flags.has("force");

  if (!edition && !all) {
    console.error("Uso: backfill-scoring-features.ts --all | --edition AAMMDD [--editions-dir DIR] [--force]");
    process.exit(2);
  }

  runBackfill(editionsRoot, { edition, force })
    .then((results) => {
      summarize(results);
      const hasError = results.some((r) => r.status === "error");
      process.exit(hasError ? 1 : 0);
    })
    .catch((err) => {
      console.error("[backfill-scoring-features] falha inesperada:", err);
      process.exit(1);
    });
}
