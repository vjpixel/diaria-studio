/**
 * find-pending-issue-drafts.ts
 *
 * Encontra edições anteriores à atual que têm `_internal/issues-draft.json`
 * com signals não-processados (i.e., sem `issues-reported.json` correspondente
 * OU `issues-reported.json` tem signals pendentes).
 *
 * Usado no Stage 0 do orchestrator (#90) pra surfacear sinais órfãos que
 * ficaram pra trás quando editor pulou o auto-reporter no Stage final de
 * alguma edição anterior.
 *
 * Uso:
 *   npx tsx scripts/find-pending-issue-drafts.ts --current AAMMDD [--window 3]
 *
 * Output (stdout JSON): array de { edition, draft_path, signal_count, has_report }.
 * Vazio se nada pendente.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface PendingDraft {
  edition: string;
  draft_path: string;
  signal_count: number;
  has_report: boolean;
  /** Resumo legível (ex: "1 source_streak, 2 chrome_disconnects"). */
  summary: string;
}

interface Signal {
  kind?: string;
  [key: string]: unknown;
}

interface DraftFile {
  edition?: string;
  signals?: Signal[];
}

interface ReportedFile {
  reported?: Array<{ signal_kind?: string }>;
  skipped?: Array<{ signal_kind?: string }>;
}

function summarizeSignals(signals: Signal[]): string {
  const counts: Record<string, number> = {};
  for (const s of signals) {
    const k = s.kind ?? "unknown";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

/**
 * Retorna true se o draft foi totalmente processado — tanto `reported` quanto
 * `skipped` juntos cobrem todos os signals.
 */
export function isDraftProcessed(
  draftSignals: Signal[],
  reportedFile: ReportedFile | null,
): boolean {
  if (!reportedFile) return false;
  const handledCount =
    (reportedFile.reported?.length ?? 0) + (reportedFile.skipped?.length ?? 0);
  return handledCount >= draftSignals.length;
}

export function findPendingDrafts(
  editionsDir: string,
  currentEdition: string,
  window = 3,
): PendingDraft[] {
  if (!existsSync(editionsDir)) return [];

  let dirs: string[];
  try {
    dirs = readdirSync(editionsDir)
      .filter((d) => /^\d{6}$/.test(d) && d < currentEdition)
      .sort()
      .reverse()
      .slice(0, window);
  } catch {
    return [];
  }

  const pending: PendingDraft[] = [];

  for (const edition of dirs) {
    const draftPath = resolve(editionsDir, edition, "_internal/issues-draft.json");
    if (!existsSync(draftPath)) continue;

    let draft: DraftFile;
    try {
      draft = JSON.parse(readFileSync(draftPath, "utf8"));
    } catch {
      continue; // draft malformado, ignorar
    }
    const signals = draft.signals ?? [];
    if (signals.length === 0) continue; // draft vazio, nada pra reportar

    const reportedPath = resolve(editionsDir, edition, "_internal/issues-reported.json");
    let reported: ReportedFile | null = null;
    if (existsSync(reportedPath)) {
      try {
        reported = JSON.parse(readFileSync(reportedPath, "utf8")) as ReportedFile;
      } catch {
        reported = null;
      }
    }

    if (isDraftProcessed(signals, reported)) continue;

    pending.push({
      edition,
      draft_path: draftPath,
      signal_count: signals.length,
      has_report: reported !== null,
      summary: summarizeSignals(signals),
    });
  }

  return pending;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const current = args.current;
  if (!current || !/^\d{6}$/.test(current)) {
    console.error("Uso: find-pending-issue-drafts.ts --current AAMMDD [--window 3]");
    process.exit(1);
  }
  const window = args.window ? parseInt(args.window, 10) : 3;
  const editionsDir = resolve(ROOT, "data/editions");
  const result = findPendingDrafts(editionsDir, current, window);
  process.stdout.write(JSON.stringify(result, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
