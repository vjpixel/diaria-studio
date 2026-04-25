/**
 * safe-delete-edition.ts
 *
 * Two-step deletion of `data/editions/{AAMMDD}/` to prevent the orchestrator
 * (or a typo) from destroying editorial work with a single accidental "sim".
 *
 * Step 1 (no `--confirm`): print a summary of what would be deleted and the
 * exact command to actually perform the deletion.
 * Step 2 (`--confirm <edition>`): if the token argument matches the edition
 * name exactly, delete recursively. Anything else aborts.
 *
 * The token-must-equal-edition-name design (à la `git branch -D <name>`) is
 * deliberate: the orchestrator can't auto-fill it from a generic "yes" reply,
 * forcing a literal re-type by the editor.
 *
 * Refs #101.
 *
 * Usage:
 *   npx tsx scripts/safe-delete-edition.ts 260424
 *   npx tsx scripts/safe-delete-edition.ts 260424 --confirm 260424
 *   npx tsx scripts/safe-delete-edition.ts 260424 --confirm 260424 --root /custom/path
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

export function isValidEditionName(name: string): boolean {
  return /^\d{6}$/.test(name);
}

export function validateConfirmToken(edition: string, token: string): boolean {
  return token.trim() === edition;
}

export interface EditionSummary {
  exists: boolean;
  file_count: number;
  total_bytes: number;
  status: string;
}

/**
 * Walks an edition directory and counts files + total bytes; reads
 * 05-published.json status if available. Pure I/O wrapped via injected
 * helpers so tests can run without touching the filesystem.
 */
export function summarizeEdition(
  editionPath: string,
  fs: {
    exists: (p: string) => boolean;
    listEntries: (p: string) => string[];
    statSize: (p: string) => number;
    isDirectory: (p: string) => boolean;
    readJson: (p: string) => unknown;
  },
): EditionSummary {
  if (!fs.exists(editionPath)) {
    return { exists: false, file_count: 0, total_bytes: 0, status: "missing" };
  }

  // Walk recursively
  let count = 0;
  let bytes = 0;
  const stack: string[] = [editionPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.listEntries(dir)) {
      const full = `${dir}/${entry}`;
      if (fs.isDirectory(full)) {
        stack.push(full);
      } else {
        count += 1;
        bytes += fs.statSize(full);
      }
    }
  }

  let status = "unknown";
  const publishedPath = `${editionPath}/05-published.json`;
  if (fs.exists(publishedPath)) {
    try {
      const data = fs.readJson(publishedPath) as { status?: string };
      if (typeof data.status === "string") status = data.status;
    } catch {
      status = "malformed";
    }
  } else {
    status = "missing";
  }

  return { exists: true, file_count: count, total_bytes: bytes, status };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildConfirmInstructions(
  edition: string,
  scriptName: string,
): string {
  return [
    `To delete this irreversibly, re-run with:`,
    ``,
    `  npx tsx ${scriptName} ${edition} --confirm ${edition}`,
    ``,
    `(The --confirm token must equal the edition name "${edition}" exactly.`,
    ` Any other value aborts the deletion.)`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliFlags {
  edition: string;
  confirmToken?: string;
  root?: string;
}

function parseArgs(argv: string[]): CliFlags | { error: string } {
  let edition: string | undefined;
  let confirmToken: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirm" && argv[i + 1]) {
      confirmToken = argv[i + 1];
      i++;
    } else if (a === "--root" && argv[i + 1]) {
      root = argv[i + 1];
      i++;
    } else if (!a.startsWith("--") && !edition) {
      edition = a;
    } else if (!a.startsWith("--")) {
      return { error: `Unexpected positional argument: ${a}` };
    }
  }
  if (!edition) {
    return { error: "Edition argument required (e.g. 260424)" };
  }
  if (!isValidEditionName(edition)) {
    return { error: `Invalid edition format: ${edition} (expected AAMMDD)` };
  }
  return { edition, confirmToken, root };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(
      "\nUsage: safe-delete-edition.ts <AAMMDD> [--confirm <AAMMDD>] [--root <path>]",
    );
    process.exit(1);
  }

  const root = parsed.root ?? ROOT;
  const editionPath = resolve(root, "data/editions", parsed.edition);

  const fsWrappers = {
    exists: (p: string) => existsSync(p),
    listEntries: (p: string) => readdirSync(p),
    statSize: (p: string) => statSync(p).size,
    isDirectory: (p: string) => statSync(p).isDirectory(),
    readJson: (p: string) => JSON.parse(readFileSync(p, "utf8")),
  };

  const summary = summarizeEdition(editionPath, fsWrappers);

  if (!summary.exists) {
    console.error(`No edition at ${editionPath}.`);
    process.exit(2);
  }

  const summaryLine = `${summary.file_count} files, ${formatBytes(summary.total_bytes)}, status: ${summary.status}`;

  if (!parsed.confirmToken) {
    console.error(`ATTENTION: ${editionPath} exists.`);
    console.error(`  ${summaryLine}\n`);
    console.error(buildConfirmInstructions(parsed.edition, "scripts/safe-delete-edition.ts"));
    process.exit(0);
  }

  if (!validateConfirmToken(parsed.edition, parsed.confirmToken)) {
    console.error(
      `ERROR: --confirm token "${parsed.confirmToken}" does not match edition "${parsed.edition}".`,
    );
    console.error("Aborting (no files deleted).");
    process.exit(3);
  }

  rmSync(editionPath, { recursive: true, force: true });
  console.error(`✓ Deleted ${editionPath} (${summaryLine}).`);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
