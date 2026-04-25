/**
 * consolidate-signals.ts
 *
 * CLI thin wrapper around `scripts/lib/auto-reporter-dedup.ts` so the
 * `auto-reporter` agent (Stage final, multi-edition mode) can invoke
 * the dedup logic via Bash instead of describing it inline in the
 * prompt — preventing silent drift across model updates (#91).
 *
 * Reads multiple draft JSON files (one per edition_dir), calls
 * `consolidateSignals(drafts)`, and writes the merged signals to
 * stdout. Each draft must match the shape produced by
 * `collect-edition-signals.ts`:
 *   { edition, collected_at, signals[] }
 *
 * Usage:
 *   npx tsx scripts/consolidate-signals.ts \
 *     --drafts data/editions/260421/_internal/issues-draft.json,\
 *              data/editions/260422/_internal/issues-draft.json,\
 *              data/editions/260423/_internal/issues-draft.json
 *
 * Output (stdout, JSON):
 *   {
 *     "signals": [
 *       { "kind": "...", "_editions": ["260421","260422","260423"], ... },
 *       ...
 *     ],
 *     "drafts_consumed": 3,
 *     "signals_in": 7,
 *     "signals_out": 4
 *   }
 *
 * Refs #91.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  consolidateSignals,
  type DraftFile,
} from "./lib/auto-reporter-dedup.ts";

interface CliFlags {
  drafts: string[];
}

function parseArgs(argv: string[]): CliFlags | { error: string } {
  const flags: { drafts?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--drafts" && argv[i + 1]) {
      flags.drafts = argv[i + 1];
      i++;
    }
  }
  if (!flags.drafts) {
    return { error: "Usage: consolidate-signals.ts --drafts <comma-separated-paths>" };
  }
  const paths = flags.drafts
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paths.length === 0) {
    return { error: "No draft paths provided" };
  }
  return { drafts: paths };
}

function loadDraft(path: string): DraftFile {
  if (!existsSync(path)) {
    throw new Error(`Draft not found: ${path}`);
  }
  const data = JSON.parse(readFileSync(path, "utf8")) as Partial<DraftFile>;
  if (!data.edition || !Array.isArray(data.signals)) {
    throw new Error(
      `Malformed draft at ${path}: missing 'edition' or 'signals[]'`,
    );
  }
  return {
    edition: data.edition,
    collected_at: data.collected_at ?? "",
    signals: data.signals,
  };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(1);
  }

  const drafts: DraftFile[] = parsed.drafts.map((p) => loadDraft(resolve(ROOT, p)));
  const signalsIn = drafts.reduce((acc, d) => acc + d.signals.length, 0);
  const signals = consolidateSignals(drafts);

  process.stdout.write(
    JSON.stringify(
      {
        signals,
        drafts_consumed: drafts.length,
        signals_in: signalsIn,
        signals_out: signals.length,
      },
      null,
      2,
    ) + "\n",
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
