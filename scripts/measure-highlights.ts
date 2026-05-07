#!/usr/bin/env npx tsx
/**
 * measure-highlights.ts (#739)
 *
 * CLI determinística pra medir tamanho dos destaques d1/d2/d3 da
 * newsletter (`02-reviewed.md`). Invocada pelo orchestrator no gate
 * Stage 2 antes de apresentar pra aprovação.
 *
 * Uso:
 *   npx tsx scripts/measure-highlights.ts data/editions/{AAMMDD}/02-reviewed.md
 *
 * Stdout: JSON estruturado pra orchestrator parsear.
 * Stderr: human-readable formatado pro editor ler no gate.
 *
 * Exit codes:
 *   0 = sucesso (mesmo com warnings — warnings não bloqueiam)
 *   2 = erro de uso (arquivo não existe, args malformados)
 */

import { readFileSync } from "node:fs";
import {
  parseHighlights,
  formatMeasureResult,
} from "./lib/measure-highlights.ts";

function main(): number {
  const argv = process.argv.slice(2);
  const filePath = argv[0];
  if (!filePath) {
    process.stderr.write(
      "Uso: measure-highlights.ts <reviewed.md>\n",
    );
    return 2;
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    process.stderr.write(
      `Erro ao ler ${filePath}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }

  const result = parseHighlights(content);

  // Stderr: human-readable
  process.stderr.write(formatMeasureResult(result) + "\n");

  // Stdout: JSON
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  process.exit(main());
}
