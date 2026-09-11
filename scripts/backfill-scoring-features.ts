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

import { statSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { extractScoringFeatures, editionDateFromAammdd, type ScoringFeatureRow } from "./lib/scoring-features.ts";

const ROOT = resolve(import.meta.dirname, "..");

export interface BackfillResult {
  edition: string;
  status: "written" | "skipped-exists" | "skipped-no-categorized" | "error" | "error-write" | "error-stat";
  rows?: number;
  error?: string;
}

/**
 * `existsSync` engole QUALQUER erro do `stat` interno (ENOENT, EACCES,
 * erro de I/O de junction/OneDrive) e devolve `false` pra todos
 * indiscriminadamente — não dá pra saber se o arquivo genuinamente não
 * existe ou se algo deu errado checando. `statSync` num try/catch
 * distingue: ENOENT vira "não existe" (caso normal), qualquer outro erro
 * propaga pro caller como falha real (achado de review do #7975).
 */
function existsOrThrow(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
}

/** Processa 1 edição. Puro em relação a I/O de rede — só filesystem local. */
export async function processEdition(editionDir: string, edition: string, force: boolean): Promise<BackfillResult> {
  const categorizedPath = join(editionDir, "_internal", "01-categorized.json");
  const outPath = join(editionDir, "_internal", "scoring-features.json");

  let categorizedExists: boolean;
  let outExists: boolean;
  try {
    categorizedExists = existsOrThrow(categorizedPath);
    outExists = existsOrThrow(outPath);
  } catch (err) {
    return { edition, status: "error-stat", error: err instanceof Error ? err.message : String(err) };
  }
  if (!categorizedExists) return { edition, status: "skipped-no-categorized" };
  if (outExists && !force) return { edition, status: "skipped-exists" };

  // Fase 1 — ler e extrair. Erro aqui é tipicamente dado malformado DESTA
  // edição (JSON corrompido, shape inesperado) — recuperável, não impede
  // as próximas edições do loop.
  let payload: { edition: string; generated_at: string; edition_date_resolved: string | null; row_count: number; rows: ScoringFeatureRow[] };
  try {
    const json = JSON.parse(readFileSync(categorizedPath, "utf8"));
    const editionDate = editionDateFromAammdd(edition);
    const rows = await extractScoringFeatures(json, editionDate);
    payload = {
      edition,
      generated_at: new Date().toISOString(),
      edition_date_resolved: editionDate ? editionDate.toISOString() : null,
      row_count: rows.length,
      rows,
    };
  } catch (err) {
    return { edition, status: "error", error: err instanceof Error ? err.message : String(err) };
  }

  // Fase 2 — escrever. Erro aqui é tipicamente infraestrutura (disco cheio,
  // permissão, OneDrive travado) — status DISTINTO de propósito: um
  // ENOSPC no meio de --all vai repetir em toda edição seguinte, e
  // misturar essa classe com "dado malformado" faria o operador investigar
  // edição por edição em vez de checar disco 1x (achado de review do #7975).
  try {
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return { edition, status: "written", rows: payload.rows.length };
  } catch (err) {
    return { edition, status: "error-write", error: err instanceof Error ? err.message : String(err) };
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

const ERROR_STATUSES: ReadonlySet<BackfillResult["status"]> = new Set(["error", "error-write", "error-stat"]);

function summarize(results: BackfillResult[]): void {
  const byStatus: Record<string, number> = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const totalRows = results.reduce((sum, r) => sum + (r.rows ?? 0), 0);
  console.log(
    `[backfill-scoring-features] ${results.length} edições processadas — ${JSON.stringify(byStatus)} — ${totalRows} linhas de feature gravadas no total.`,
  );
  const writeErrors = results.filter((r) => r.status === "error-write");
  if (writeErrors.length > 0) {
    console.error(
      `  ${writeErrors.length} falha(s) de ESCRITA (provável causa única de infraestrutura — disco/permissão/OneDrive — checar 1x, não edição por edição):`,
    );
  }
  for (const r of results) {
    if (ERROR_STATUSES.has(r.status)) console.error(`  ERRO [${r.status}] ${r.edition}: ${r.error}`);
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
      const hasError = results.some((r) => ERROR_STATUSES.has(r.status));
      process.exit(hasError ? 1 : 0);
    })
    .catch((err) => {
      console.error("[backfill-scoring-features] falha inesperada:", err);
      process.exit(1);
    });
}
