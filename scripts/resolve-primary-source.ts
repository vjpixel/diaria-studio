/**
 * Apply deterministic primary-source substitutions to approved Stage 1 output (#5664).
 *
 * Search results are collected by the Stage 1 orchestrator with the query emitted
 * by `buildPrimarySourceQuery`; this CLI only applies the documented decision rule.
 * Missing results never remove the approved secondary link.
 *
 * Usage:
 *   npx tsx scripts/resolve-primary-source.ts \
 *     --approved _internal/01-approved.json \
 *     --search-results _internal/tmp-primary-source-search-results.json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import {
  applyPrimarySourceLookup,
  type PrimarySourceCandidate,
  type PrimarySourceLookupInput,
} from "./lib/primary-source-lookup.ts";

function main(): void {
  const args = parseArgsSimple(process.argv.slice(2));
  const approvedPath = args.approved ?? "";
  const resultsPath = args["search-results"] ?? "";
  const outPath = args.out ?? approvedPath;
  if (!approvedPath || !resultsPath) {
    console.error("Uso: resolve-primary-source.ts --approved <01-approved.json> --search-results <results.json> [--out <out.json>]");
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(approvedPath, "utf8")) as PrimarySourceLookupInput;
  const results = existsSync(resultsPath)
    ? JSON.parse(readFileSync(resultsPath, "utf8")) as Record<string, PrimarySourceCandidate[]>
    : {};
  const result = applyPrimarySourceLookup(input, results);
  writeFileSync(outPath, JSON.stringify(result.output, null, 2), "utf8");
  process.stderr.write(`[resolve-primary-source] ${result.replaced} substituída(s), ${result.preserved} tentativa(s) preservada(s)\n`);
  process.stdout.write(JSON.stringify({ replaced: result.replaced, preserved: result.preserved }) + "\n");
}

if (isMainModule(import.meta.url)) main();
