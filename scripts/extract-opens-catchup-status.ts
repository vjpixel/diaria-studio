#!/usr/bin/env node
/**
 * scripts/extract-opens-catchup-status.ts (#4740)
 *
 * CLI: lê o log de uma run de `clarice-sync-brevo.ts --incremental` (o
 * arquivo temporário que `run-clarice-sync-daily.ps1` grava ANTES de anexar
 * ao log final — ver docstring de `scripts/lib/extract-opens-catchup-status.ts`),
 * extrai o campo `opens_catchup` do summary JSON, e persiste um status
 * enxuto pra `scripts/clarice-opens-catchup-alarm.ts` consumir depois, sem
 * precisar reparsear runs históricas.
 *
 * Uso:
 *   npx tsx scripts/extract-opens-catchup-status.ts --log <path> --out <path>
 *
 * Best-effort por design: falha (arquivo de log ausente, JSON malformado)
 * NUNCA deve reprovar a run de sync — sempre exit 0, mesmo em erro (o
 * chamador — `run-clarice-sync-daily.ps1` — trata isso como passo opcional).
 */
import { readFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { extractOpensCatchupStatus } from "./lib/extract-opens-catchup-status.ts";

function main(): void {
  const argv = process.argv.slice(2);
  const logPath = getArg(argv, "log");
  const outPath = getArg(argv, "out");

  if (!logPath || !outPath) {
    console.error("Uso: extract-opens-catchup-status.ts --log <path> --out <path>");
    process.exit(0); // best-effort — nunca reprova o chamador
    return;
  }

  if (!existsSync(logPath)) {
    console.error(`[extract-opens-catchup-status] log não encontrado: ${logPath} (skip)`);
    process.exit(0);
    return;
  }

  try {
    const text = readFileSync(logPath, "utf8");
    const status = extractOpensCatchupStatus(text);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileAtomic(outPath, JSON.stringify(status, null, 2) + "\n");
    console.error(`[extract-opens-catchup-status] status=${status.status} → ${outPath}`);
  } catch (e) {
    console.error(`[extract-opens-catchup-status] falha (best-effort, não bloqueia): ${(e as Error).message}`);
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main();
}
