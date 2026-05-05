#!/usr/bin/env npx tsx
/**
 * record-source-runs.ts (PLURAL)
 *
 * Registra N execuções de source-researcher/discovery-searcher em batch.
 * Substitui N invocações seriais de `record-source-run.ts` quando o
 * orchestrator já tem os resultados agregados.
 *
 * Uso:
 *   npx tsx scripts/record-source-runs.ts \
 *     --runs data/editions/260423/_internal/researcher-results.json \
 *     [--edition 260423]
 *
 * Schema do --runs:
 *   [
 *     {
 *       "source": "MIT Technology Review",
 *       "outcome": "ok" | "fail" | "timeout",
 *       "duration_ms": 45123,
 *       "query_used": "site:...",
 *       "articles": [{"title":"...","url":"..."}],
 *       "reason": "consecutive_fetch_errors"   (opcional)
 *     },
 *     ...
 *   ]
 *
 * Cada run atualiza `data/source-health.json` + anexa em `data/sources/{slug}.jsonl`.
 *
 * Output: JSON com array de resultados + totais.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { recordRunsBatch, type RunRecord, type RunResult } from "./lib/source-runs.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runsPath = args.runs;
  const edition = args.edition;

  if (!runsPath) {
    console.error("Uso: record-source-runs.ts --runs <file.json> [--edition AAMMDD]");
    process.exit(1);
  }

  let runs: RunRecord[];
  try {
    runs = JSON.parse(readFileSync(runsPath, "utf8"));
  } catch (e) {
    console.error(`Erro lendo ${runsPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  if (!Array.isArray(runs)) {
    console.error("Input deve ser um array JSON de runs.");
    process.exit(1);
  }

  // #677: edition ausente → "unknown" (evita null no health JSON que quebra queries por edição)
  if (!edition) {
    console.error(
      `WARN [record-source-runs]: --edition não passado — runs gravadas com edition="unknown". ` +
      `O orchestrator Stage 1g deve sempre passar --edition {AAMMDD}.`,
    );
  }
  const editionValue = edition ?? "unknown";

  // Propaga edition pra cada run se o campo não estiver setado individualmente.
  const normalized = runs.map((r) => ({
    ...r,
    edition: r.edition ?? editionValue,
  }));

  const results: RunResult[] = recordRunsBatch(ROOT, normalized);

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.outcome === "ok").length,
    fail: results.filter((r) => r.outcome === "fail").length,
    timeout: results.filter((r) => r.outcome === "timeout").length,
    sources_with_consecutive_failures_ge3: results
      .filter((r) => r.consecutive_failures >= 3)
      .map((r) => ({ source: r.source, consecutive_failures: r.consecutive_failures })),
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
