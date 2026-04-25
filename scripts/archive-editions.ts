/**
 * archive-editions.ts
 *
 * Moves editions older than --older-than days from `data/editions/{AAMMDD}/`
 * to `data/archive/{YYMM}/{AAMMDD}/` so the working tree stays light as the
 * pipeline accumulates editions. Dry-run by default; pass `--execute` to
 * actually move files.
 *
 * Skips editions without `05-published.json` by default (treats them as
 * tests / in-progress runs that the editor probably wants to delete or
 * keep, not archive). Pass `--include-test` to override.
 *
 * Refs #98.
 *
 * Usage:
 *   npx tsx scripts/archive-editions.ts                 # dry-run, default 90d
 *   npx tsx scripts/archive-editions.ts --execute       # actually move
 *   npx tsx scripts/archive-editions.ts --older-than 180
 *   npx tsx scripts/archive-editions.ts --execute --include-test
 *
 * Output (stdout, both modes):
 *   { candidates, archived, skipped, threshold_days, dry_run }
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArchiveCandidate {
  edition: string;
  age_days: number;
  reason: "ok_published" | "skip_no_published" | "skip_unpublished" | "skip_too_recent";
  path?: string;
}

export interface ArchiveMove {
  edition: string;
  from: string;
  to: string;
}

export interface ArchiveResult {
  threshold_days: number;
  dry_run: boolean;
  candidates: ArchiveCandidate[];
  archived: ArchiveMove[];
  skipped: ArchiveCandidate[];
}

export interface ArchiveOptions {
  editionsDir: string;
  archiveDir: string;
  thresholdDays: number;
  execute: boolean;
  includeTest: boolean;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Parses an "AAMMDD" string (year is YY → 20YY) into a UTC Date at midnight.
 * Returns null if the format is invalid or yields an unreal calendar date.
 */
export function parseEditionDate(edition: string): Date | null {
  if (!/^\d{6}$/.test(edition)) return null;
  const yy = Number(edition.slice(0, 2));
  const mm = Number(edition.slice(2, 4));
  const dd = Number(edition.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const date = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  // Reject roll-overs (e.g. Feb 30 became March 2).
  if (
    date.getUTCFullYear() !== 2000 + yy ||
    date.getUTCMonth() !== mm - 1 ||
    date.getUTCDate() !== dd
  ) {
    return null;
  }
  return date;
}

/**
 * Days between `editionDate` and `now`, rounded to integer days. Negative if
 * the edition is in the future (clock skew or test data).
 */
export function ageDays(editionDate: Date, now: Date): number {
  const ms = now.getTime() - editionDate.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/**
 * Returns the publication status from `{editionPath}/05-published.json` if
 * present. Possible: "published", "scheduled", "draft", "failed", "missing".
 * "missing" means there is no published.json (likely test or in-progress).
 */
export function readPublishedStatus(
  editionPath: string,
  fileReader: (p: string) => string = (p) => readFileSync(p, "utf8"),
  fileExists: (p: string) => boolean = (p) => existsSync(p),
): string {
  const path = join(editionPath, "05-published.json");
  if (!fileExists(path)) return "missing";
  try {
    const data = JSON.parse(fileReader(path)) as { status?: string };
    return typeof data.status === "string" ? data.status : "unknown";
  } catch {
    return "malformed";
  }
}

/**
 * Decides if an edition is eligible for archiving. Pure — no I/O — so the
 * decision logic can be unit tested independently of filesystem state.
 */
export function classifyEdition(
  edition: string,
  publishedStatus: string,
  now: Date,
  thresholdDays: number,
  includeTest: boolean,
): ArchiveCandidate {
  const date = parseEditionDate(edition);
  if (!date) {
    return { edition, age_days: 0, reason: "skip_no_published" };
  }
  const age = ageDays(date, now);

  if (age <= thresholdDays) {
    return { edition, age_days: age, reason: "skip_too_recent" };
  }

  const isPublished =
    publishedStatus === "published" || publishedStatus === "scheduled";

  if (publishedStatus === "missing") {
    if (includeTest) {
      return { edition, age_days: age, reason: "ok_published" };
    }
    return { edition, age_days: age, reason: "skip_no_published" };
  }

  if (!isPublished) {
    if (includeTest) {
      return { edition, age_days: age, reason: "ok_published" };
    }
    return { edition, age_days: age, reason: "skip_unpublished" };
  }

  return { edition, age_days: age, reason: "ok_published" };
}

/**
 * Computes the archive destination: `data/archive/{YYMM}/{AAMMDD}/`.
 * Pure helper.
 */
export function archiveDestination(
  archiveDir: string,
  edition: string,
): string {
  const yymm = edition.slice(0, 4);
  return join(archiveDir, yymm, edition);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function archiveEditions(opts: ArchiveOptions): ArchiveResult {
  const now = opts.now ?? new Date();
  const result: ArchiveResult = {
    threshold_days: opts.thresholdDays,
    dry_run: !opts.execute,
    candidates: [],
    archived: [],
    skipped: [],
  };

  if (!existsSync(opts.editionsDir)) return result;

  const entries = readdirSync(opts.editionsDir).filter((d) => /^\d{6}$/.test(d));

  for (const edition of entries) {
    const editionPath = resolve(opts.editionsDir, edition);
    if (!statSync(editionPath).isDirectory()) continue;

    const publishedStatus = readPublishedStatus(editionPath);
    const candidate = classifyEdition(
      edition,
      publishedStatus,
      now,
      opts.thresholdDays,
      opts.includeTest,
    );
    candidate.path = editionPath;
    result.candidates.push(candidate);

    if (candidate.reason !== "ok_published") {
      result.skipped.push(candidate);
      continue;
    }

    const dest = archiveDestination(opts.archiveDir, edition);
    if (!opts.execute) {
      result.archived.push({ edition, from: editionPath, to: dest });
      continue;
    }

    if (existsSync(dest)) {
      // Defensive: never overwrite an existing archived edition.
      result.skipped.push({
        ...candidate,
        reason: "skip_no_published",
      });
      continue;
    }

    mkdirSync(dirname(dest), { recursive: true });
    renameSync(editionPath, dest);
    result.archived.push({ edition, from: editionPath, to: dest });
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliFlags {
  thresholdDays: number;
  execute: boolean;
  includeTest: boolean;
  editionsDir?: string;
  archiveDir?: string;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    thresholdDays: 90,
    execute: false,
    includeTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") {
      flags.execute = true;
    } else if (a === "--include-test") {
      flags.includeTest = true;
    } else if (a === "--older-than" && argv[i + 1]) {
      flags.thresholdDays = Number(argv[i + 1]);
      i++;
    } else if (a === "--editions-dir" && argv[i + 1]) {
      flags.editionsDir = argv[i + 1];
      i++;
    } else if (a === "--archive-dir" && argv[i + 1]) {
      flags.archiveDir = argv[i + 1];
      i++;
    }
  }
  return flags;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = parseArgs(process.argv.slice(2));
  const editionsDir = resolve(ROOT, cli.editionsDir ?? "data/editions");
  const archiveDir = resolve(ROOT, cli.archiveDir ?? "data/archive");

  const result = archiveEditions({
    editionsDir,
    archiveDir,
    thresholdDays: cli.thresholdDays,
    execute: cli.execute,
    includeTest: cli.includeTest,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  if (!cli.execute && result.archived.length > 0) {
    console.error(
      `\nDry-run: ${result.archived.length} edition(s) would be moved. ` +
        `Re-run with --execute to apply.`,
    );
  }
  if (cli.execute) {
    console.error(
      `\nMoved ${result.archived.length}, skipped ${result.skipped.length}.`,
    );
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
