/**
 * find-current-edition.ts (#583)
 *
 * Detecta edições em curso para um stage da pipeline Diar.ia. Usado pelas
 * skills `/diaria-{2,3,4}-*` quando o editor omite o argumento AAMMDD: se há
 * exatamente uma edição com o stage anterior aprovado e o output do stage
 * atual faltando, a skill assume essa edição em vez de perguntar.
 *
 * Critérios por stage (relativos a `data/editions/{AAMMDD}/`):
 *   - Stage 2: prereq `_internal/01-approved.json`; output esperado `02-reviewed.md`.
 *   - Stage 3: prereq `_internal/01-approved.json`; output esperado `04-d1-1x1.jpg`.
 *   - Stage 4: prereqs `02-reviewed.md` e `03-social.md`; output esperado `_internal/05-published.json`.
 *
 * "Em curso" = todos os prereqs presentes E ao menos um output ausente.
 *
 * CLI:
 *   npx tsx scripts/lib/find-current-edition.ts --stage 2
 *   → {"stage":2,"candidates":["260505","260506"]}
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type Stage = 2 | 3 | 4;

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
    prereq: ["02-reviewed.md", "03-social.md"],
    output: ["_internal/05-published.json"],
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
  if (stageNum !== 2 && stageNum !== 3 && stageNum !== 4) {
    console.error("Uso: find-current-edition.ts --stage <2|3|4>");
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
