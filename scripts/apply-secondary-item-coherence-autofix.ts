/**
 * apply-secondary-item-coherence-autofix.ts (#6441)
 *
 * CLI/Stage-2 wrapper for `applySecondaryItemEllipsisAutofix` (pure logic
 * in `scripts/lib/lint-checks/secondary-item-ellipsis-autofix.ts`). Reads
 * `{editionDir}/02-reviewed.md` + `{editionDir}/_internal/01-approved.json`,
 * restores any mechanically-recoverable `fabricated-ellipsis` description
 * (summary intact — see the module docstring for the exact scope), writes
 * `02-reviewed.md` back when changed, and logs the full decision trail to
 * `{editionDir}/_internal/secondary-item-coherence-autofix.json`.
 *
 * Wired into Stage 2 right before `check-stage2-invariants.ts` (#6441) —
 * runs "pós-humanizador, onde o dado ainda está quente" (issue #6441),
 * so the Stage 4 gate sees already-restored text for the recoverable case
 * and only the genuinely irrecoverable case (summary itself truncated —
 * RSS garbage) reaches the editor for manual rewrite.
 *
 * Uso:
 *   npx tsx scripts/apply-secondary-item-coherence-autofix.ts --edition-dir data/editions/AAMMDD/
 *
 * Exit codes:
 *   0 — sucesso (inclui o caso onde não há nada a corrigir/restaurar)
 *   1 — erro de args ou arquivo ausente
 *
 * Nunca falha por causa de itens `unresolved_*` — esses são esperados
 * (irrecuperável, ou fora do escopo do prefix-match determinístico) e ficam
 * só registrados no log para o Stage 4 (`secondaryItemCoherenceSeverity`)
 * e para o editor auditarem depois.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  applySecondaryItemEllipsisAutofix,
  type EllipsisAutofixEntry,
} from "./lib/lint-checks/secondary-item-ellipsis-autofix.ts";
import type { CoherenceApprovedJson } from "./lib/lint-checks/secondary-item-coherence.ts";

export interface SecondaryItemCoherenceAutofixLog {
  edition_dir: string;
  applied_at: string;
  changed: boolean;
  entries: EllipsisAutofixEntry[];
}

/**
 * Roda o autofix sobre um edition dir. Retorna `null` (sem tocar em nada,
 * sem escrever log) quando `02-reviewed.md` ou `01-approved.json` ainda não
 * existem — outros checks de Stage 2 já cobrem essa ausência; este passo é
 * best-effort, não um gate.
 */
export function runSecondaryItemEllipsisAutofix(
  editionDir: string,
): SecondaryItemCoherenceAutofixLog | null {
  const mdPath = join(editionDir, "02-reviewed.md");
  const approvedPath = join(editionDir, "_internal", "01-approved.json");
  if (!existsSync(mdPath) || !existsSync(approvedPath)) return null;

  const md = readFileSync(mdPath, "utf8");
  const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as CoherenceApprovedJson;
  const result = applySecondaryItemEllipsisAutofix(md, approved);

  if (result.changed) {
    writeFileSync(mdPath, result.content, "utf8");
  }

  const log: SecondaryItemCoherenceAutofixLog = {
    edition_dir: editionDir,
    applied_at: new Date().toISOString(),
    changed: result.changed,
    entries: result.entries,
  };

  const outPath = join(editionDir, "_internal", "secondary-item-coherence-autofix.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(log, null, 2));

  return log;
}

async function main(): Promise<void> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) {
    console.error(
      "Uso: apply-secondary-item-coherence-autofix.ts --edition-dir data/editions/AAMMDD/",
    );
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  if (!existsSync(editionDir)) {
    console.error(`[apply-secondary-item-coherence-autofix] dir não existe: ${editionDir}`);
    process.exit(1);
  }
  const log = runSecondaryItemEllipsisAutofix(editionDir);
  if (!log) {
    console.log(
      JSON.stringify({
        skipped: true,
        reason: "02-reviewed.md ou 01-approved.json ausente",
      }),
    );
    return;
  }
  console.log(JSON.stringify(log, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
