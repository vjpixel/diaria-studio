/**
 * update-stage-status.ts (#960)
 *
 * CLI de `scripts/lib/stage-status.ts` (#14001): a lógica (render/parse do
 * `stage-status.md`, `applyUpdate`, reconciliação de stages órfãos, gates de
 * `done`, load/save do sidecar JSON) mora na lib, com a documentação do
 * módulo. Este arquivo só lê os argumentos e chama a lib, e reexporta tudo
 * dela para os importadores de sempre.
 *
 * Uso:
 *   # Inicializar (todos stages = pending) — chamado pelo orchestrator no Stage 0:
 *   npx tsx scripts/update-stage-status.ts --edition-dir data/editions/260508 --init
 *
 *   # Atualizar uma linha — chamado pelo orchestrator ao terminar cada stage:
 *   npx tsx scripts/update-stage-status.ts --edition-dir data/editions/260508 \
 *     --stage 1 --status done \
 *     [--start "2026-05-08T08:30:00Z"] [--end "2026-05-08T08:48:00Z"] \
 *     [--duration-ms 1080000] [--cost-usd 0.45] \
 *     [--tokens-in 1200000] [--tokens-out 85000] \
 *     [--models "haiku-4-5,opus-4-7"]
 *
 * Output: JSON `{ path, stage_updated, totals }` em stdout.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";
import {
  applyUpdate,
  blockReasonForMarkingStageDone,
  loadDoc,
  makeInitialDoc,
  readStepCheckpointEnds,
  reconcileRunningStages,
  saveDoc,
  type StageStatus,
  type StageStatusDoc,
} from "./lib/stage-status.ts";

export * from "./lib/stage-status.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  // #2834: `--key value` (valor condicional, não pode começar com "--") e
  // flags booleanas sem valor já são o comportamento canônico de parseArgs —
  // idêntico ao parser manual anterior pra todo flag exceto `--init`.
  // `--init` era tratado como boolean incondicional (sempre true, mesmo se
  // seguido por um token que pareceria um valor) — preservado explicitamente
  // abaixo, mesmo padrão defensivo usado em resolve-edition-url.ts pro
  // `--validate-social` (#2834).
  const { values, flags } = parseArgsLib(argv);
  const out: Record<string, string | boolean> = { ...values };
  for (const f of flags) out[f] = true;
  if (argv.includes("--init")) out.init = true;
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const editionDirRaw = args["edition-dir"] as string | undefined;
  if (!editionDirRaw) {
    console.error(
      "Uso:\n" +
        "  --edition-dir <path> --init                                # inicializa (todos pending)\n" +
        "  --edition-dir <path> --reconcile-running                   # marca stages 'running' órfãos como 'failed', ou 'done' se houver .step-N-done.json (#2525, achado 260716)\n" +
        "  --edition-dir <path> --stage N --status pending|running|done|failed [field=val]...",
    );
    process.exit(2);
  }
  const editionDir = resolve(ROOT, editionDirRaw);
  const editionId = editionDir.replace(/\/$/, "").split(/[\\/]/).pop() ?? "";
  const statusPath = resolve(editionDir, "stage-status.md");

  let doc: StageStatusDoc;
  if (args.init) {
    doc = makeInitialDoc(editionId);
  } else if (args["reconcile-running"]) {
    // #2525: reconcile orphaned running stages on resume.
    // Marks `running` stages as `failed` — EXCETO quando `.step-N-done.json`
    // prova que o stage terminou de verdade (achado 260716, edição 260706:
    // reconciliação manual do editor tinha atualizado os dados da edição mas
    // não este doc, deixando Stage 5 "running" por 11 dias apesar de
    // concluído) — nesse caso usa "done" com o `completed_at` real.
    doc = loadDoc(editionDir, editionId);
    const checkpointEnds = readStepCheckpointEnds(editionDir, doc);
    const { doc: reconciledDoc, reconciledStages } = reconcileRunningStages(
      doc,
      new Date().toISOString(),
      checkpointEnds,
    );
    doc = reconciledDoc;

    try {
      saveDoc(editionDir, doc);
    } catch (err) {
      console.error(`falha ao gravar ${statusPath}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    console.log(
      JSON.stringify({
        path: statusPath,
        reconciled_stages: reconciledStages,
        message: reconciledStages.length > 0
          ? `stages ${reconciledStages.join(",")} reconciled running→failed`
          : "no running stages found — nothing to reconcile",
      }),
    );
    return;
  } else {
    // #1216: load from JSON sidecar (canonical) — MD parse fallback for legacy.
    doc = loadDoc(editionDir, editionId);
    const stage = parseInt(args.stage as string, 10);
    if (isNaN(stage)) {
      console.error("--stage é obrigatório (número)");
      process.exit(2);
    }
    const status = (args.status as string) ?? "pending";
    if (!["pending", "running", "done", "failed"].includes(status)) {
      console.error(`--status inválido: ${status}`);
      process.exit(2);
    }
    // #1530 + #1563: stage transition gates (centralized)
    if (status === "done") {
      const blockReason = blockReasonForMarkingStageDone(editionDir, stage);
      if (blockReason) {
        console.error(
          `[update-stage-status] BLOCKED: ${blockReason}\n` +
          `  Run: npx tsx scripts/send-edition-report.ts --edition {AAMMDD} --edition-dir ${editionDirRaw}/`,
        );
        process.exit(1);
      }
    }

    doc = applyUpdate(
      doc,
      {
        stage,
        status: status as StageStatus,
        start: args.start as string | undefined,
        end: args.end as string | undefined,
        gate_at: args["gate-at"] as string | undefined,
        duration_ms: args["duration-ms"] ? parseInt(args["duration-ms"] as string, 10) : undefined,
        pipeline_ms: args["pipeline-ms"] ? parseInt(args["pipeline-ms"] as string, 10) : undefined,
        cost_usd: args["cost-usd"] ? parseFloat(args["cost-usd"] as string) : undefined,
        tokens_in: args["tokens-in"] ? parseInt(args["tokens-in"] as string, 10) : undefined,
        tokens_out: args["tokens-out"] ? parseInt(args["tokens-out"] as string, 10) : undefined,
        models: args.models
          ? (args.models as string).split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        // #8899: só a CLI (chamada explícita `--status done`/`failed`) opta pelo
        // auto-bump de `end` numa 2ª chamada — nunca `capture-stage-usage.ts`
        // (backfill de métricas, roda logo em seguida, preservando `status`).
        allowEndAdvance: status === "done" || status === "failed",
      },
      // #1783: now real pro auto-carimbo de start/end quando o playbook não passa.
      new Date().toISOString(),
    );
  }

  try {
    // #1216: persist canonical JSON + rendered MD together.
    saveDoc(editionDir, doc);
  } catch (err) {
    console.error(`falha ao gravar ${statusPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const totals = {
    duration_ms: doc.rows.reduce((a, r) => a + (r.duration_ms ?? 0), 0),
    cost_usd: doc.rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
    tokens_in: doc.rows.reduce((a, r) => a + (r.tokens_in ?? 0), 0),
    tokens_out: doc.rows.reduce((a, r) => a + (r.tokens_out ?? 0), 0),
  };

  console.log(
    JSON.stringify({
      path: statusPath,
      stage_updated: args.init ? "all (init)" : args.stage,
      totals,
    }),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
