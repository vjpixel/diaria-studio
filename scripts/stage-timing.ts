#!/usr/bin/env npx tsx
/**
 * stage-timing.ts
 *
 * Analyzes an edition directory and computes per-stage durations from file mtimes.
 * Works retroactively on any completed (or partial) edition.
 *
 * Usage:
 *   npx tsx scripts/stage-timing.ts [--edition-dir data/editions/260422/]
 *   npx tsx scripts/stage-timing.ts [--edition 260422]
 *   npx tsx scripts/stage-timing.ts                    # auto-detect latest edition
 *   npx tsx scripts/stage-timing.ts --all              # all editions, comparison table
 *
 * Output: table with per-stage start, end, duration, and total pipeline time.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface FileInfo {
  name: string;
  mtime: Date;
}

interface StageTiming {
  stage: number;
  label: string;
  start: Date | null;
  end: Date | null;
  durationMs: number;
  files: string[];
}

// Map files to stages based on prefix
function fileToStage(name: string): { stage: number; label: string } | null {
  if (name === "_internal/cost.json" || name === "_internal/cost.md") return { stage: 0, label: "Setup" };
  if (name.startsWith("01-eia")) return { stage: 1, label: "É IA?" };
  if (name.startsWith("01-") || name.startsWith("_internal/01-")) return { stage: 1, label: "Research" };
  if (name.startsWith("02-") || name.startsWith("_internal/02-")) return { stage: 2, label: "Writing" };
  if (name.startsWith("03-") || name.startsWith("_internal/03-")) return { stage: 3, label: "Social" };
  if (name.startsWith("04-") || name.startsWith("_internal/04-")) return { stage: 4, label: "Images" };
  if (name.startsWith("05-")) return { stage: 5, label: "Newsletter" };
  if (name.startsWith("06-")) return { stage: 6, label: "Social pub" };
  return null;
}

function getEditionFiles(editionDir: string): FileInfo[] {
  if (!existsSync(editionDir)) {
    console.error(`Directory not found: ${editionDir}`);
    process.exit(1);
  }
  return readdirSync(editionDir)
    .filter((f) => !statSync(resolve(editionDir, f)).isDirectory())
    .map((f) => ({
      name: f,
      mtime: statSync(resolve(editionDir, f)).mtime,
    }));
}

function computeTimings(files: FileInfo[]): StageTiming[] {
  const stageMap = new Map<number, { label: string; files: FileInfo[] }>();

  for (const f of files) {
    const info = fileToStage(f.name);
    if (!info) continue;
    if (!stageMap.has(info.stage)) {
      stageMap.set(info.stage, { label: info.label, files: [] });
    }
    stageMap.get(info.stage)!.files.push(f);
  }

  const timings: StageTiming[] = [];
  const sortedStages = [...stageMap.entries()].sort((a, b) => a[0] - b[0]);

  for (let i = 0; i < sortedStages.length; i++) {
    const [stage, data] = sortedStages[i];
    const sorted = data.files.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
    const firstFile = sorted[0]?.mtime ?? null;
    const end = sorted[sorted.length - 1]?.mtime ?? null;

    // For single-file stages, infer start from previous stage's last file
    let start = firstFile;
    if (sorted.length === 1 && i > 0) {
      const prevTiming = timings[i - 1];
      if (prevTiming?.end) {
        start = prevTiming.end;
      }
    }

    const durationMs = start && end ? end.getTime() - start.getTime() : 0;

    timings.push({
      stage,
      label: data.label,
      start,
      end,
      durationMs,
      files: sorted.map((f) => f.name),
    });
  }

  return timings;
}

// Compute wall-clock gaps between stages (human gates, idle time)
function computeGaps(timings: StageTiming[]): { afterStage: number; gapMs: number }[] {
  const gaps: { afterStage: number; gapMs: number }[] = [];
  for (let i = 0; i < timings.length - 1; i++) {
    const end = timings[i].end;
    const nextStart = timings[i + 1].start;
    if (end && nextStart) {
      const gapMs = nextStart.getTime() - end.getTime();
      if (gapMs > 0) {
        gaps.push({ afterStage: timings[i].stage, gapMs });
      }
    }
  }
  return gaps;
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

function fmtTime(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function detectLatestEdition(): string {
  const editionsDir = resolve(ROOT, "data/editions");
  if (!existsSync(editionsDir)) {
    console.error("data/editions/ not found");
    process.exit(1);
  }
  const dirs = readdirSync(editionsDir)
    .filter((d) => /^\d{6}$/.test(d))
    .sort()
    .reverse();
  if (dirs.length === 0) {
    console.error("No editions found in data/editions/");
    process.exit(1);
  }
  return dirs[0];
}

function printEditionReport(editionDir: string, editionLabel: string): StageTiming[] {
  const files = getEditionFiles(editionDir);
  const timings = computeTimings(files);
  const gaps = computeGaps(timings);

  if (timings.length === 0) {
    console.log(`\n${editionLabel}: no stage files found\n`);
    return [];
  }

  const pipelineStart = timings[0].start;
  const pipelineEnd = timings[timings.length - 1].end;
  const totalMs = pipelineStart && pipelineEnd ? pipelineEnd.getTime() - pipelineStart.getTime() : 0;

  // Active time (sum of stage durations)
  const activeMs = timings.reduce((sum, t) => sum + t.durationMs, 0);
  // Idle time (human gates + waits)
  const idleMs = totalMs - activeMs;

  console.log(`\n${"=".repeat(72)}`);
  console.log(`Edition: ${editionLabel}`);
  console.log(`${"=".repeat(72)}`);
  console.log();

  // Table header
  const hdr = [
    "Stage".padEnd(15),
    "Start".padEnd(10),
    "End".padEnd(10),
    "Duration".padEnd(10),
    "Files".padEnd(5),
  ].join(" | ");
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  for (const t of timings) {
    const row = [
      `${t.stage}. ${t.label}`.padEnd(15),
      fmtTime(t.start).padEnd(10),
      fmtTime(t.end).padEnd(10),
      fmtDuration(t.durationMs).padEnd(10),
      String(t.files.length).padEnd(5),
    ].join(" | ");
    console.log(row);

    // Show gap after this stage
    const gap = gaps.find((g) => g.afterStage === t.stage);
    if (gap && gap.gapMs > 30_000) {
      console.log(`${"".padEnd(15)}   ${"".padEnd(10)}   ${"".padEnd(10)}   ↕ ${fmtDuration(gap.gapMs)} gap`);
    }
  }

  console.log("-".repeat(hdr.length));
  console.log(`Wall clock: ${fmtDuration(totalMs)}  |  Active: ${fmtDuration(activeMs)}  |  Idle/gates: ${fmtDuration(idleMs)}`);
  console.log();

  return timings;
}

function printComparisonTable(editions: { label: string; timings: StageTiming[] }[]) {
  console.log(`\n${"=".repeat(80)}`);
  console.log("Stage Duration Comparison (all editions)");
  console.log(`${"=".repeat(80)}\n`);

  const allStages = [0, 1, 2, 3, 4, 5, 6, 7];
  const labels = ["Setup", "Research", "Writing", "Social", "É IA?", "Images", "Newsletter", "Social pub"];

  // Header
  const hdr = ["Stage".padEnd(15), ...editions.map((e) => e.label.padEnd(12))].join(" | ");
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  for (let i = 0; i < allStages.length; i++) {
    const stage = allStages[i];
    const cells = editions.map((e) => {
      const t = e.timings.find((t) => t.stage === stage);
      return fmtDuration(t?.durationMs ?? 0).padEnd(12);
    });
    console.log([`${stage}. ${labels[i]}`.padEnd(15), ...cells].join(" | "));
  }

  console.log("-".repeat(hdr.length));

  // Totals
  const totals = editions.map((e) => {
    const first = e.timings[0]?.start;
    const last = e.timings[e.timings.length - 1]?.end;
    const ms = first && last ? last.getTime() - first.getTime() : 0;
    return fmtDuration(ms).padEnd(12);
  });
  console.log(["Total".padEnd(15), ...totals].join(" | "));
  console.log();
}

// --- Main ---

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--all") {
      args.all = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.all) {
  // Compare all editions
  const editionsDir = resolve(ROOT, "data/editions");
  const dirs = readdirSync(editionsDir)
    .filter((d) => /^\d{6}$/.test(d))
    .sort();

  const results: { label: string; timings: StageTiming[] }[] = [];
  for (const d of dirs) {
    const editionDir = resolve(editionsDir, d);
    const timings = printEditionReport(editionDir, d);
    if (timings.length > 0) results.push({ label: d, timings });
  }

  if (results.length > 1) {
    printComparisonTable(results);
  }
} else {
  // Single edition
  let editionDir: string;
  let label: string;

  if (args["edition-dir"]) {
    editionDir = resolve(ROOT, args["edition-dir"] as string);
    label = basename(editionDir);
  } else if (args.edition) {
    editionDir = resolve(ROOT, "data/editions", args.edition as string);
    label = args.edition as string;
  } else {
    const latest = detectLatestEdition();
    editionDir = resolve(ROOT, "data/editions", latest);
    label = latest;
  }

  printEditionReport(editionDir, label);
}
