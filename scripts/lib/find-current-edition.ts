/**
 * find-current-edition.ts (#583)
 *
 * Detecta edições em curso para um stage da pipeline Diar.ia. Usado pelas
 * skills `/diaria-{2,3,4,5}-*` quando o editor omite o argumento AAMMDD: se há
 * exatamente uma edição com o stage anterior aprovado e o output do stage
 * atual faltando, a skill assume essa edição em vez de perguntar.
 *
 * Critérios por stage (relativos a `data/editions/{AAMMDD}/`):
 *   - Stage 2: prereq `_internal/01-approved.json`; output esperado `02-reviewed.md`.
 *   - Stage 3: prereq `_internal/01-approved.json`; output esperado `04-d1-1x1.jpg`.
 *   - Stage 4 (Revisão, #1694): prereqs `02-reviewed.md` e `03-social.md`;
 *       output esperado `_internal/.step-4-done.json`.
 *   - Stage 5 (Publicação, #1694): prereq `_internal/.step-4-done.json`;
 *       output esperado `_internal/06-social-published.json` (escrito após social
 *       dispatch; 05-published.json é escrito mid-stage e causaria falso-done se
 *       social falhasse — #1694 finding 3).
 *
 * "Em curso" = todos os prereqs presentes E ao menos um output ausente.
 *
 * CLI:
 *   npx tsx scripts/lib/find-current-edition.ts --stage 2
 *   → {"stage":2,"candidates":["260505","260506"]}
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type Stage = 2 | 3 | 4 | 5;

interface StageRequirements {
  /** Files that must exist for this stage to be ready to run. */
  prereq: string[];
  /** Files that signal this stage's output is complete. */
  output: string[];
}

const STAGE_REQUIREMENTS: Record<Stage, StageRequirements> = {
  2: {
    prereq: ["_internal/01-approved.json"],
    output: ["02-reviewed.md"],
  },
  3: {
    prereq: ["_internal/01-approved.json"],
    output: ["04-d1-1x1.jpg"],
  },
  4: {
    // Stage 4 = Revisão editorial assistida (#1694)
    prereq: ["02-reviewed.md", "03-social.md"],
    output: ["_internal/.step-4-done.json"],
  },
  5: {
    // Stage 5 = Publicação (#1694, was Stage 4 before the split)
    // Output marker is 06-social-published.json (written after social dispatch, end of Stage 5).
    // 05-published.json is written mid-stage (newsletter only) and would cause false-done
    // detection if social dispatch fails (#1694 finding 3).
    prereq: ["_internal/.step-4-done.json"],
    output: ["_internal/06-social-published.json"],
  },
};

const EDITIONS_DIR = "data/editions";
const AAMMDD_RE = /^\d{6}$/;

export function findEditionsInProgress(
  stage: Stage,
  rootDir: string = process.cwd(),
): string[] {
  const editionsRoot = resolve(rootDir, EDITIONS_DIR);
  if (!existsSync(editionsRoot)) return [];

  const reqs = STAGE_REQUIREMENTS[stage];
  const candidates: string[] = [];

  for (const entry of readdirSync(editionsRoot)) {
    if (!AAMMDD_RE.test(entry)) continue;
    const editionDir = join(editionsRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(editionDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const prereqOk = reqs.prereq.every((f) => existsSync(join(editionDir, f)));
    if (!prereqOk) continue;

    const outputDone = reqs.output.every((f) => existsSync(join(editionDir, f)));
    if (outputDone) continue;

    // #1694 finding 2: guard against pre-#1694 editions being detected as Stage 4
    // in-progress. Pre-split editions have 05-published.json (already published) but
    // lack .step-4-done.json (the new Stage 4 sentinel). Without this guard, they would
    // be flagged as Stage 4 candidates and Stage 4 Revisão would re-run on a published edition.
    if (stage === 4 && existsSync(join(editionDir, "_internal", "05-published.json"))) {
      continue; // already fully published — treat as complete
    }

    candidates.push(entry);
  }

  return candidates.sort();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const stageRaw = args["stage"];
  const stageNum = parseInt(stageRaw ?? "", 10);
  if (stageNum !== 2 && stageNum !== 3 && stageNum !== 4 && stageNum !== 5) {
    console.error("Uso: find-current-edition.ts --stage <2|3|4|5>");
    process.exit(1);
  }
  const candidates = findEditionsInProgress(stageNum as Stage);
  process.stdout.write(JSON.stringify({ stage: stageNum, candidates }) + "\n");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
