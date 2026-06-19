#!/usr/bin/env npx tsx
/**
 * pipeline-sentinel.ts (#780, #1330) — CLI wrapper para pipeline-state.ts.
 *
 * Subcomandos (step-level — gate approvals):
 *   write  --edition AAMMDD --step N --outputs "file1,file2"
 *   assert --edition AAMMDD --step N [--outputs "file1,file2"]
 *   exists --edition AAMMDD --step N
 *
 * Subcomandos (sub-step markers — invariantes intra-stage, #1330):
 *   write-marker  --edition AAMMDD --name <kebab-case> [--details '{"k":"v"}']
 *   assert-marker --edition AAMMDD --name <kebab-case>
 *
 * Exit codes para `assert`:
 *   0 — sentinel presente + todos os outputs existem (pass)
 *   1 — sentinel ausente (hard fail); com --outputs, só retorna 1 se algum
 *       output também estiver ausente (caso sem --outputs → sempre 1)
 *   2 — sentinel presente mas outputs ausentes (hard fail)
 *   3 — sentinel ausente MAS todos os arquivos em --outputs existem (legacy/migração — warn)
 *
 * Exit codes para `assert-marker`:
 *   0 — marker presente (pass)
 *   1 — marker ausente (hard fail)
 *
 * Exit codes para `write` / `write-marker`:  0 = ok, 1 = erro
 * Exit codes para `exists`: 0 = presente, 1 = ausente
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertMarker,
  assertSentinel,
  readSentinel,
  sentinelExists,
  writeMarker,
  writeSentinel,
} from "./lib/pipeline-state.js";
import {
  applyUpdate,
  blockReasonForMarkingStageDone,
  loadDoc,
  saveDoc,
  STAGES,
} from "./update-stage-status.ts";

/**
 * #1563: when a stage sentinel is written, auto-update stage-status to mark
 * the stage as `done` if it was previously `running`. Orchestrator can forget
 * the explicit `update-stage-status --status done` call; the sentinel write
 * is the authoritative completion signal so we mirror it here.
 *
 * Best-effort: never throws. Returns `true` if stage-status was updated,
 * `false` if no-op (already done, no running row, no stage-status file, or
 * any internal error).
 */
export function autoUpdateStageStatusOnSentinel(
  editionDir: string,
  editionId: string,
  step: number,
  nowMs: number = Date.now(),
): boolean {
  if (!STAGES.includes(step as (typeof STAGES)[number])) return false;
  // Don't touch legacy editions (pre-#1216) that only have stage-status.md —
  // loadDoc fallback to parseStageStatus drops start/end/duration/cost/tokens,
  // and saveDoc would re-render the MD with empty columns.
  const jsonPath = resolve(editionDir, "_internal", "stage-status.json");
  if (!existsSync(jsonPath)) return false;
  try {
    const doc = loadDoc(editionDir, editionId);
    const row = doc.rows.find((r) => r.stage === step);
    // #2374: handle both "running" and "pending" — a stage interrupted before
    // the orchestrator called update-stage-status --status running stays "pending"
    // even though its sentinel is written. On resume, assert detects the sentinel
    // and skips the stage, but the status is never repaired. Treat pending+sentinel
    // the same as running+sentinel: transition to done using the sentinel's
    // completed_at as the end timestamp.
    if (!row || (row.status !== "running" && row.status !== "pending")) return false;
    // Same transition gates as the CLI (#1530 — Stage 4 needs report). If
    // we can't safely mark this stage done, leave it for the editor /
    // explicit update-stage-status call instead of silently flipping.
    if (blockReasonForMarkingStageDone(editionDir, step) !== null) return false;
    const nowIso = new Date(nowMs).toISOString();
    const durationMs = row.start
      ? nowMs - new Date(row.start).getTime()
      : row.duration_ms;
    const updated = applyUpdate(doc, {
      stage: step,
      status: "done",
      end: nowIso,
      duration_ms: durationMs,
    });
    saveDoc(editionDir, updated);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        out[key] = "true";
      } else {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}

function main(): void {
  const [, , subcmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (!args.edition) {
    console.error("[error] --edition é obrigatório");
    process.exit(1);
  }

  const editionDir = resolve(process.cwd(), "data", "editions", args.edition);

  // Marker subcmds só precisam de --name. Step subcmds precisam de --step.
  const isMarkerCmd = subcmd === "write-marker" || subcmd === "assert-marker";

  if (!isMarkerCmd && !args.step) {
    console.error("[error] --step é obrigatório (use --name para sub-step markers)");
    process.exit(1);
  }

  if (isMarkerCmd && !args.name) {
    console.error("[error] --name é obrigatório para write-marker/assert-marker");
    process.exit(1);
  }

  const step = isMarkerCmd ? -1 : Number(args.step);

  if (!isMarkerCmd && (Number.isNaN(step) || step < 1)) {
    console.error(`[error] --step inválido: ${args.step}`);
    process.exit(1);
  }

  switch (subcmd) {
    case "write": {
      if (!args.outputs) {
        console.error("[error] --outputs é obrigatório para write");
        process.exit(1);
      }
      const outputs = args.outputs.split(",").map((s) => s.trim()).filter(Boolean);
      try {
        writeSentinel(editionDir, step, outputs);
        console.log(`sentinel step ${step} escrito em ${editionDir}/_internal/.step-${step}-done.json`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[error] falha ao escrever sentinel: ${msg}`);
        process.exit(1);
      }
      // #1563: auto-update stage-status when sentinel is written.
      if (autoUpdateStageStatusOnSentinel(editionDir, args.edition, step)) {
        console.log(`stage-status auto-updated: stage ${step} → done`);
      }
      break;
    }

    case "assert": {
      const result = assertSentinel(editionDir, step);
      if (result.ok) {
        // #2374: resume path — sentinel exists but stage-status may still be
        // "running" or "pending" from the interrupted session. Repair it here
        // so timing is recorded even when the orchestrator skips write.
        // #2401: use sentinel.completed_at as nowMs (not Date.now()) so the
        // recorded `end` reflects when the stage actually completed, not the
        // resume time.
        const sentinel = readSentinel(editionDir, step);
        const nowMs = sentinel
          ? new Date(sentinel.completed_at).getTime()
          : Date.now();
        if (autoUpdateStageStatusOnSentinel(editionDir, args.edition, step, nowMs)) {
          console.log(`stage-status auto-updated on resume: stage ${step} → done`);
        }
        process.exit(0);
      }
      if (result.reason === "sentinel_missing") {
        if (args.outputs) {
          const files = args.outputs.split(",").map((s) => s.trim()).filter(Boolean);
          const missingFiles = files.filter((f) => !existsSync(resolve(editionDir, f)));
          if (missingFiles.length === 0) {
            console.warn(
              `[warn] sentinel step ${step} ausente mas outputs encontrados em disco (legado) — logar e continuar`,
            );
            process.exit(3);
          }
          // Some outputs missing — list them for actionable diagnosis
          console.error(
            `[error] sentinel step ${step} ausente e outputs faltando: ${missingFiles.join(", ")}`,
          );
          process.exit(1);
        }
        console.error(`[error] sentinel step ${step} ausente em ${editionDir}`);
        process.exit(1);
      }
      // outputs_missing
      const missing = result.missingOutputs.join(", ");
      console.error(`[error] sentinel step ${step} presente mas outputs ausentes: ${missing}`);
      process.exit(2);
    }

    case "exists": {
      process.exit(sentinelExists(editionDir, step) ? 0 : 1);
    }

    case "write-marker": {
      let details: Record<string, unknown> | undefined;
      if (args.details) {
        try {
          details = JSON.parse(args.details) as Record<string, unknown>;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[error] --details JSON inválido: ${msg}`);
          process.exit(1);
        }
      }
      try {
        writeMarker(editionDir, args.name, details);
        console.log(`marker '${args.name}' escrito em ${editionDir}/_internal/.marker-${args.name}.json`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[error] falha ao escrever marker: ${msg}`);
        process.exit(1);
      }
      break;
    }

    case "assert-marker": {
      const result = assertMarker(editionDir, args.name);
      if (result.ok) {
        process.exit(0);
      }
      console.error(`[error] marker '${args.name}' ausente em ${editionDir}/_internal/`);
      process.exit(1);
    }

    default: {
      console.error(`[error] subcomando desconhecido: ${subcmd}. Use write|assert|exists|write-marker|assert-marker`);
      process.exit(1);
    }
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
