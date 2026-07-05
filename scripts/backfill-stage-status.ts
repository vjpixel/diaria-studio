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
import { readSentinel, resolveSentinelEndMs } from "./lib/pipeline-state.ts";
import { autoUpdateStageStatusOnSentinel } from "./pipeline-sentinel.ts";
import { isValidEditionDir } from "./lib/edition-utils.ts"; // #1680: desacopla do módulo dedup inteiro
import { parseArgsSimple } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CliArgs {
  dryRun: boolean;
  editionFilter?: string;
}

function parseArgs(argv: string[]): CliArgs {
  // #2834 fix-round: --dry-run é boolean INCONDICIONAL no original (checado
  // antes de qualquer outra coisa) — argv.includes preserva isso mesmo com
  // [--dry-run, 260527] (guard destrutivo depende disso, não trocar por hasFlag).
  const out: CliArgs = { dryRun: argv.includes("--dry-run") };
  const parsed = parseArgsSimple(argv);
  if (parsed["edition"]) out.editionFilter = parsed["edition"];
  return out;
}

export interface Fix {
  edition: string;
  stage: number;
  reason: string;
  endMs: number;
}

export function scanEdition(editionDir: string, editionId: string): Fix[] {
  const fixes: Fix[] = [];
  const jsonPath = resolve(editionDir, "_internal", "stage-status.json");
  if (!existsSync(jsonPath)) return fixes;
  const doc = loadDoc(editionDir, editionId);
  for (const stage of STAGES) {
    const row = doc.rows.find((r) => r.stage === stage);
    // #2374: also detect "pending" stages — a stage interrupted before the
    // orchestrator called update-stage-status --status running leaves the row as
    // "pending" even though the sentinel exists (reproduced in 260619: stages 3+4
    // appeared as "pending" while 2+5 were "running").
    if (!row || (row.status !== "running" && row.status !== "pending")) continue;
    const sentinel = readSentinel(editionDir, stage);
    if (!sentinel) continue;
    // #2416 sibling: guard NaN via helper compartilhado (resolveSentinelEndMs) —
    // `completed_at` malformado → endMs=NaN → autoUpdateStageStatusOnSentinel
    // recebe nowMs=NaN → new Date(NaN).toISOString() lança RangeError engolido
    // → no-op silencioso. O helper detecta o NaN e cai para Date.now() com warn.
    const endMs = resolveSentinelEndMs(sentinel, `backfill stage ${stage} (${editionId})`);
    fixes.push({
      edition: editionId,
      stage,
      reason: `sentinel .step-${stage}-done.json presente mas row '${row.status}'`,
      endMs,
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

/**
 * Lista os dirs de edição válidos em `editionsDir` (opcionalmente filtrados por
 * `editionFilter`).
 *
 * #1661: exige nome AAMMDD válido via isValidEditionDir — exclui dirs de backup
 * (ex.: `260527-backup-20260526203126`, `260422-local-backup`) que, sem o guard,
 * teriam seu `_internal/stage-status.json` SOBRESCRITO por applyFixes quando
 * rodado sem --dry-run (escrita destrutiva em edições arquivadas). Mesmo guard
 * que dedup.ts adotou no #1567/#1627.
 */
export function listEditionDirs(editionsDir: string, editionFilter?: string): string[] {
  return readdirSync(editionsDir).filter((name) => {
    if (editionFilter && name !== editionFilter) return false;
    if (!isValidEditionDir(name)) return false;
    const p = resolve(editionsDir, name);
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionsDir = resolve(ROOT, "data", "editions");
  if (!existsSync(editionsDir)) {
    console.error(`Edições dir não encontrado: ${editionsDir}`);
    process.exit(1);
  }
  const entries = listEditionDirs(editionsDir, args.editionFilter);
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
