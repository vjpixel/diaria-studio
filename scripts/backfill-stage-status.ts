#!/usr/bin/env tsx
/**
 * backfill-stage-status.ts (#1563)
 *
 * Varre `data/editions/{AAMMDD}/_internal/stage-status.json` e detecta
 * stages com `status: "running"` que têm sentinel `.step-N-done.json`
 * correspondente. Marca como `done`, usando `completed_at` do sentinel
 * como `end` e computando `duration_ms` se `start` existir.
 *
 * Uso:
 *   # Dry-run (não escreve):
 *   npx tsx scripts/backfill-stage-status.ts --dry-run
 *
 *   # Aplicar fix:
 *   npx tsx scripts/backfill-stage-status.ts
 *
 *   # Limitar a uma edição específica:
 *   npx tsx scripts/backfill-stage-status.ts --edition 260528
 *
 * Caso real: edição 260528 publicada com sucesso, mas stage 4 ficou
 * "running" no stage-status.json porque orchestrator esqueceu
 * `update-stage-status --status done`. Sentinel `.step-4-done.json`
 * estava presente.
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadDoc, STAGES } from "./update-stage-status.ts";
import { readSentinel } from "./lib/pipeline-state.ts";
import { autoUpdateStageStatusOnSentinel } from "./pipeline-sentinel.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CliArgs {
  dryRun: boolean;
  editionFilter?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--edition" && argv[i + 1]) {
      out.editionFilter = argv[i + 1];
      i++;
    }
  }
  return out;
}

interface Fix {
  edition: string;
  stage: number;
  reason: string;
  endMs: number;
}

function scanEdition(editionDir: string, editionId: string): Fix[] {
  const fixes: Fix[] = [];
  const jsonPath = resolve(editionDir, "_internal", "stage-status.json");
  if (!existsSync(jsonPath)) return fixes;
  const doc = loadDoc(editionDir, editionId);
  for (const stage of STAGES) {
    const row = doc.rows.find((r) => r.stage === stage);
    if (!row || row.status !== "running") continue;
    const sentinel = readSentinel(editionDir, stage);
    if (!sentinel) continue;
    fixes.push({
      edition: editionId,
      stage,
      reason: `sentinel .step-${stage}-done.json presente mas row 'running'`,
      endMs: new Date(sentinel.completed_at).getTime(),
    });
  }
  return fixes;
}

function applyFixes(editionDir: string, editionId: string, fixes: Fix[]): number {
  let applied = 0;
  for (const f of fixes) {
    if (autoUpdateStageStatusOnSentinel(editionDir, editionId, f.stage, f.endMs)) {
      applied++;
    }
  }
  return applied;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionsDir = resolve(ROOT, "data", "editions");
  if (!existsSync(editionsDir)) {
    console.error(`Edições dir não encontrado: ${editionsDir}`);
    process.exit(1);
  }
  const entries = readdirSync(editionsDir).filter((name) => {
    if (args.editionFilter && name !== args.editionFilter) return false;
    const p = resolve(editionsDir, name);
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  const allFixes: Fix[] = [];
  for (const editionId of entries) {
    const editionDir = resolve(editionsDir, editionId);
    const fixes = scanEdition(editionDir, editionId);
    if (fixes.length === 0) continue;
    allFixes.push(...fixes);
    console.log(`\n[${editionId}] ${fixes.length} stage(s) running com sentinel:`);
    for (const f of fixes) {
      console.log(
        `  - Stage ${f.stage}: ${f.reason}\n    end=${new Date(f.endMs).toISOString()}`,
      );
    }
    if (!args.dryRun) {
      const applied = applyFixes(editionDir, editionId, fixes);
      if (applied === fixes.length) {
        console.log(`  ✓ ${applied} fix(es) aplicados em ${editionDir}/_internal/stage-status.json`);
      } else {
        console.log(`  ⚠ ${applied}/${fixes.length} aplicados (bloqueados por gate ou outro motivo)`);
      }
    }
  }
  console.log("");
  console.log(`Total: ${allFixes.length} fix(es) em ${entries.length} edições escaneadas`);
  if (args.dryRun) console.log("(dry-run — nenhuma escrita)");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  try {
    main();
  } catch (e) {
    console.error("Fatal:", e);
    process.exit(1);
  }
}
