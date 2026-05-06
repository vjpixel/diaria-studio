#!/usr/bin/env npx tsx
/**
 * check-source-blocklist.ts (#717 hypothesis #5)
 *
 * Pre-flight check pra orchestrator step 1f: filtra fontes cujo URL bate
 * na blocklist de agregadores (que `source-researcher` Haiku já trataria
 * como agregador e voltaria com articles: []).
 *
 * Pra cada fonte filtrada, evitamos: 1 Bash subprocess, 1 Agent dispatch,
 * 1 WebSearch, ~5 WebFetch. Em edição com 11 fontes em fallback (caso #717),
 * isso é ~30s-1min de wall clock + ~50k Haiku tokens economizados.
 *
 * Uso:
 *   echo '[{"name":"AI Breakfast","url":"https://aibreakfast.beehiiv.com/"}]' | \
 *     npx tsx scripts/check-source-blocklist.ts
 *
 *   npx tsx scripts/check-source-blocklist.ts --in sources.json --out filtered.json
 *
 * Output JSON em stdout (ou --out): { kept: Source[], skipped: SkippedSource[] }.
 * Exit codes: 0 sempre (script é informativo, não bloqueador).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { filterSources, type Source } from "./lib/aggregator-blocklist.ts";
import { parseArgs } from "./lib/cli-args.ts";

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const inPath = values["in"];
  const outPath = values["out"];

  let raw: string;
  if (inPath) {
    raw = readFileSync(inPath, "utf8");
  } else {
    // Lê de stdin
    raw = readFileSync(0, "utf8");
  }

  let sources: Source[];
  try {
    sources = JSON.parse(raw);
    if (!Array.isArray(sources)) throw new Error("input must be JSON array");
  } catch (e) {
    console.error(`Erro: input JSON inválido: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const result = filterSources(sources);

  // Stderr: sumário human-readable
  console.error(
    `check-source-blocklist: ${sources.length} fontes — ${result.kept.length} kept, ${result.skipped.length} skipped`,
  );
  if (result.skipped.length > 0) {
    for (const s of result.skipped) {
      console.error(`  skip: ${s.name} (${s.url}) — ${s.category} (matched: ${s.pattern})`);
    }
  }

  const out = JSON.stringify(result, null, 2);
  if (outPath) {
    writeFileSync(outPath, out, "utf8");
  } else {
    process.stdout.write(out);
  }
  process.exit(0);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
