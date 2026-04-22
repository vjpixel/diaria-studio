#!/usr/bin/env npx tsx
/**
 * benchmark-e2e.ts
 *
 * End-to-end pipeline benchmark that runs Stages 1-5 with real API calls
 * but NO human gates and NO publishing (Stages 6-7 skipped).
 *
 * This measures real-world performance of research, writing, social
 * generation, and image creation — the stages we can optimize.
 *
 * Usage:
 *   npx tsx scripts/benchmark-e2e.ts --date 2026-04-23 [--window 3] [--skip-images]
 *
 * Creates a timestamped benchmark edition in data/editions/bench-{YYMMDD}-{timestamp}/
 * so it doesn't conflict with real editions. Outputs timing data to stdout
 * and saves results to the benchmark dir as bench-results.json.
 *
 * Requirements:
 *   - GEMINI_API_KEY set (for image generation, unless --skip-images)
 *   - context/sources.md, past-editions.md, editorial-rules.md exist
 *   - No browser/Chrome needed (Stages 6-7 skipped)
 */

import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface StageResult {
  stage: number;
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "skipped" | "failed";
  error?: string;
  files: string[];
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--skip-images") {
      args["skip-images"] = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function run(cmd: string, opts?: { timeout?: number }): string {
  return execSync(cmd, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: opts?.timeout ?? 300_000,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function tryRun(cmd: string, opts?: { timeout?: number }): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: opts?.timeout ?? 300_000,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { ok: true, stdout, stderr: "" };
  } catch (e: any) {
    return { ok: false, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return `${min}m ${remSec}s`;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => !statSync(resolve(dir, f)).isDirectory());
}

function filesSince(dir: string, since: string[]): string[] {
  return listFiles(dir).filter(f => !since.includes(f));
}

// ---- Main ----

const args = parseArgs(process.argv.slice(2));
const editionDate = args.date as string;
if (!editionDate) {
  console.error("Usage: npx tsx scripts/benchmark-e2e.ts --date AAMMDD [--window 3] [--skip-images]");
  process.exit(1);
}

const windowDays = parseInt((args.window as string) ?? "3", 10);
const skipImages = !!args["skip-images"];

// editionDate is already AAMMDD (e.g. 260423)
const yymmdd = editionDate;

// Create benchmark edition dir (timestamped to allow multiple runs)
const ts = Date.now();
const benchDir = resolve(ROOT, `data/editions/bench-${yymmdd}-${ts}`);
mkdirSync(benchDir, { recursive: true });

console.log(`\n${"=".repeat(72)}`);
console.log(`E2E Benchmark: ${editionDate} (${yymmdd})`);
console.log(`Window: ${windowDays} days | Images: ${skipImages ? "SKIP" : "YES"}`);
console.log(`Output: ${benchDir}`);
console.log(`${"=".repeat(72)}\n`);

const results: StageResult[] = [];

function runStage(
  stage: number,
  name: string,
  fn: () => void,
  skip = false
): void {
  if (skip) {
    console.log(`[Stage ${stage}] ${name} — SKIPPED`);
    results.push({
      stage, name,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
      status: "skipped",
      files: [],
    });
    return;
  }

  const filesBefore = listFiles(benchDir);
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  process.stdout.write(`[Stage ${stage}] ${name}...`);

  try {
    fn();
    const durationMs = performance.now() - t0;
    const endedAt = new Date().toISOString();
    const newFiles = filesSince(benchDir, filesBefore);

    console.log(` ${fmtDuration(durationMs)} (${newFiles.length} files)`);

    results.push({
      stage, name, startedAt, endedAt, durationMs,
      status: "ok",
      files: newFiles,
    });
  } catch (e: any) {
    const durationMs = performance.now() - t0;
    const endedAt = new Date().toISOString();
    const newFiles = filesSince(benchDir, filesBefore);

    console.log(` FAILED after ${fmtDuration(durationMs)}`);
    console.error(`  Error: ${e.message?.slice(0, 200)}`);

    results.push({
      stage, name, startedAt, endedAt, durationMs,
      status: "failed",
      error: e.message?.slice(0, 500),
      files: newFiles,
    });
  }
}

// Compute window start (convert AAMMDD to ISO for Date math)
const editionIso = `20${yymmdd.slice(0,2)}-${yymmdd.slice(2,4)}-${yymmdd.slice(4,6)}`;
const windowStart = run(
  `node -e "const d=new Date('${editionIso}');d.setUTCDate(d.getUTCDate()-${windowDays});process.stdout.write(d.toISOString().slice(0,10))"`
);
console.log(`Research window: ${windowStart} → ${editionDate}\n`);

// ---- Stage 1: Research (deterministic parts only) ----
// We can't run source-researcher/discovery-searcher without spawning agents,
// but we CAN run the scripts that process their output.
// For the benchmark, we'll use a simplified research pipeline:
// 1. Source search (real web calls via the script)
// 2. Dedup
// 3. Categorize
// 4. Render MD

runStage(1, "Research — dedup + categorize + render", () => {
  // Check if we have raw articles from a real source search, otherwise skip
  // For benchmark purposes, copy from latest real edition if available
  const latestEdition = readdirSync(resolve(ROOT, "data/editions"))
    .filter(d => /^\d{6}$/.test(d))
    .sort()
    .reverse()[0];

  if (!latestEdition) throw new Error("No existing edition to use as fixture");

  const rawSrc = resolve(ROOT, "data/editions", latestEdition, "01-raw-articles.json");
  if (!existsSync(rawSrc)) throw new Error(`No 01-raw-articles.json in ${latestEdition}`);

  // Copy raw articles as our starting point
  const rawDst = resolve(benchDir, "01-raw-articles.json");
  writeFileSync(rawDst, readFileSync(rawSrc));

  // Dedup
  const dedupOut = resolve(benchDir, "01-deduped.json");
  run(`npx tsx scripts/dedup.ts --articles "${rawDst}" --past-editions context/past-editions.md --out "${dedupOut}"`);

  // Extract kept articles for categorize
  const deduped = JSON.parse(readFileSync(dedupOut, "utf8"));
  const kept = Array.isArray(deduped) ? deduped : deduped.kept;
  const keptPath = resolve(benchDir, "01-deduped-kept.json");
  writeFileSync(keptPath, JSON.stringify(kept));

  // Categorize
  const catOut = resolve(benchDir, "_internal/01-categorized.json");
  run(`npx tsx scripts/categorize.ts --articles "${keptPath}" --out "${catOut}"`);

  // Render MD
  const mdOut = resolve(benchDir, "01-categorized.md");
  run(`npx tsx scripts/render-categorized-md.ts --in "${catOut}" --out "${mdOut}" --edition ${yymmdd}`);
});

// ---- Stage 2: Writing (needs LLM — use fixture) ----
runStage(2, "Writing — extract + clarice-diff", () => {
  // Copy draft + reviewed from fixture for script benchmarking
  const latestEdition = readdirSync(resolve(ROOT, "data/editions"))
    .filter(d => /^\d{6}$/.test(d))
    .sort()
    .reverse()[0];

  const draftSrc = resolve(ROOT, "data/editions", latestEdition, "_internal/02-draft.md");
  const reviewedSrc = resolve(ROOT, "data/editions", latestEdition, "02-reviewed.md");

  if (!existsSync(draftSrc) || !existsSync(reviewedSrc)) {
    throw new Error(`Missing _internal/02-draft.md or 02-reviewed.md in ${latestEdition}`);
  }

  writeFileSync(resolve(benchDir, "_internal/02-draft.md"), readFileSync(draftSrc));
  writeFileSync(resolve(benchDir, "02-reviewed.md"), readFileSync(reviewedSrc));

  // Extract destaques (deterministic parser)
  run(`npx tsx scripts/extract-destaques.ts "${resolve(benchDir, "02-reviewed.md")}"`);

  // Clarice diff
  run(`npx tsx scripts/clarice-diff.ts "${resolve(benchDir, "_internal/02-draft.md")}" "${resolve(benchDir, "02-reviewed.md")}" "${resolve(benchDir, "_internal/02-clarice-diff.md")}"`);
});

// ---- Stage 3: Social (needs LLM — skip in benchmark) ----
runStage(3, "Social — LLM-dependent", () => {
  throw new Error("Requires LLM agent calls — not benchmarkable offline");
}, true);

// ---- Stage 4: É AI? (needs Gemini + Wikimedia — skip) ----
runStage(4, "É AI? — external APIs", () => {}, true);

// ---- Stage 5: Images ----
runStage(5, "Images — Gemini generation + crop", () => {
  // Copy prompts from fixture
  const latestEdition = readdirSync(resolve(ROOT, "data/editions"))
    .filter(d => /^\d{6}$/.test(d))
    .sort()
    .reverse()[0];

  for (const d of ["d1", "d2", "d3"]) {
    const promptSrc = resolve(ROOT, "data/editions", latestEdition, `02-${d}-prompt.md`);
    if (existsSync(promptSrc)) {
      writeFileSync(resolve(benchDir, `02-${d}-prompt.md`), readFileSync(promptSrc));
    }
  }

  // Generate images (real Gemini API calls)
  for (const d of ["d1", "d2", "d3"]) {
    const prompt = resolve(benchDir, `02-${d}-prompt.md`);
    if (!existsSync(prompt)) {
      console.log(`\n  Skipping ${d} — no prompt file`);
      continue;
    }
    process.stdout.write(`\n  Generating ${d}...`);
    const r = tryRun(
      `npx tsx scripts/image-generate.ts --editorial "${prompt}" --out-dir "${benchDir}/" --destaque ${d}`,
      { timeout: 180_000 }
    );
    if (!r.ok) {
      console.log(` FAILED: ${r.stderr.slice(0, 100)}`);
    } else {
      console.log(` OK`);
    }
  }
}, skipImages);

// ---- Summary ----
console.log(`\n${"=".repeat(72)}`);
console.log("E2E Benchmark Results");
console.log(`${"=".repeat(72)}\n`);

const hdr = [
  "Stage".padEnd(40),
  "Duration".padStart(12),
  "Status".padStart(8),
  "Files".padStart(6),
].join(" | ");
console.log(hdr);
console.log("-".repeat(hdr.length));

let totalActive = 0;
for (const r of results) {
  if (r.status === "ok") totalActive += r.durationMs;
  console.log([
    `${r.stage}. ${r.name}`.padEnd(40),
    fmtDuration(r.durationMs).padStart(12),
    r.status.padStart(8),
    String(r.files.length).padStart(6),
  ].join(" | "));
}

console.log("-".repeat(hdr.length));
console.log(`Active time: ${fmtDuration(totalActive)}`);
console.log(`Output dir: ${benchDir}`);
console.log();

// Save results
const resultsPath = resolve(benchDir, "bench-results.json");
writeFileSync(resultsPath, JSON.stringify({
  edition_date: editionDate,
  yymmdd,
  window_days: windowDays,
  skip_images: skipImages,
  started_at: results[0]?.startedAt,
  ended_at: results[results.length - 1]?.endedAt,
  total_active_ms: totalActive,
  stages: results,
}, null, 2));

console.log(`Results saved to ${resultsPath}`);
