#!/usr/bin/env npx tsx
/**
 * benchmark.ts
 *
 * Repeatable benchmark that times each deterministic stage script using
 * fixture data from an existing edition. No external API calls, no human
 * gates, no LLM calls — purely local script performance.
 *
 * Usage:
 *   npx tsx scripts/benchmark.ts [--fixture 260422] [--runs 3]
 *
 * What it benchmarks (scripts that run offline with existing data):
 *   1. dedup.ts         — deduplicate raw articles against past editions
 *   2. categorize.ts    — classify articles into buckets
 *   3. render-md.ts     — render categorized JSON → markdown
 *   4. extract-destaques — parse reviewed newsletter → structured JSON
 *   5. clarice-diff.ts  — compute diff between draft and reviewed
 *   6. crop-resize.ts   — center-crop an image (simulates D1 square variant)
 *
 * NOT benchmarked (require external services):
 *   - Web search/fetch (Stage 1 sources)
 *   - LLM calls (scorer, writer, social writers)
 *   - Clarice MCP
 *   - Gemini image generation
 *   - Drive sync (Google API)
 *   - Beehiiv browser automation
 *   - Facebook/LinkedIn publishing
 *
 * Output: per-script timing table + averages across runs.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync as fsWriteFile } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface BenchResult {
  name: string;
  runs: number[];
  avg: number;
  min: number;
  max: number;
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function timeExec(cmd: string, args: string[], cwd: string): number {
  const t0 = performance.now();
  execFileSync(cmd, args, { cwd, stdio: "pipe", shell: true });
  return performance.now() - t0;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

const cliArgs = parseArgs(process.argv.slice(2));
const fixtureEdition = cliArgs.fixture ?? "260422";
const numRuns = parseInt(cliArgs.runs ?? "3", 10);

const fixtureDir = resolve(ROOT, "data/editions", fixtureEdition);
if (!existsSync(fixtureDir)) {
  console.error(`Fixture edition not found: ${fixtureDir}`);
  process.exit(1);
}

// Create temp working directory
const tmpDir = resolve(ROOT, "data/.benchmark-tmp");
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

// Copy fixture files to temp dir
cpSync(fixtureDir, tmpDir, { recursive: true });

console.log(`Benchmark: fixture=${fixtureEdition}, runs=${numRuns}`);
console.log(`Temp dir: ${tmpDir}\n`);

// Define benchmarks
interface BenchDef {
  name: string;
  check: () => boolean;
  run: () => number;
}

const benchmarks: BenchDef[] = [
  {
    name: "dedup.ts",
    check: () => existsSync(resolve(tmpDir, "01-raw-articles.json")),
    run: () =>
      timeExec("npx", [
        "tsx", resolve(ROOT, "scripts/dedup.ts"),
        "--articles", resolve(tmpDir, "01-raw-articles.json"),
        "--past-editions", resolve(ROOT, "context/past-editions.md"),
        "--out", resolve(tmpDir, "bench-deduped.json"),
      ], ROOT),
  },
  {
    name: "categorize.ts",
    check: () => existsSync(resolve(tmpDir, "01-deduped.json")),
    run: () => {
      // dedup output is { kept, removed } — categorize expects flat array
      const deduped = JSON.parse(readFileSync(resolve(tmpDir, "01-deduped.json"), "utf8"));
      const articles = Array.isArray(deduped) ? deduped : deduped.kept;
      const tmpArticles = resolve(tmpDir, "bench-deduped-kept.json");
      fsWriteFile(tmpArticles, JSON.stringify(articles));
      return timeExec("npx", [
        "tsx", resolve(ROOT, "scripts/categorize.ts"),
        "--articles", tmpArticles,
        "--out", resolve(tmpDir, "bench-categorized.json"),
      ], ROOT);
    },
  },
  {
    name: "render-categorized-md.ts",
    check: () => existsSync(resolve(tmpDir, "01-categorized.json")),
    run: () =>
      timeExec("npx", [
        "tsx", resolve(ROOT, "scripts/render-categorized-md.ts"),
        "--in", resolve(tmpDir, "01-categorized.json"),
        "--out", resolve(tmpDir, "bench-categorized.md"),
        "--edition", fixtureEdition,
      ], ROOT),
  },
  {
    name: "extract-destaques.ts",
    check: () => existsSync(resolve(tmpDir, "02-reviewed.md")),
    run: () =>
      timeExec("npx", [
        "tsx", resolve(ROOT, "scripts/extract-destaques.ts"),
        resolve(tmpDir, "02-reviewed.md"),
      ], ROOT),
  },
  {
    name: "clarice-diff.ts",
    check: () =>
      existsSync(resolve(tmpDir, "02-draft.md")) &&
      existsSync(resolve(tmpDir, "02-reviewed.md")),
    run: () =>
      timeExec("npx", [
        "tsx", resolve(ROOT, "scripts/clarice-diff.ts"),
        resolve(tmpDir, "02-draft.md"),
        resolve(tmpDir, "02-reviewed.md"),
        resolve(tmpDir, "bench-diff.md"),
      ], ROOT),
  },
  {
    name: "crop-resize.ts (800x800)",
    check: () => existsSync(resolve(tmpDir, "05-d1.jpg")),
    run: () =>
      timeExec("npx", [
        "tsx", resolve(ROOT, "scripts/crop-resize.ts"),
        resolve(tmpDir, "05-d1.jpg"),
        resolve(tmpDir, "bench-crop.jpg"),
        "--width", "800",
        "--height", "800",
      ], ROOT),
  },
];

// Run benchmarks
const results: BenchResult[] = [];

for (const bench of benchmarks) {
  if (!bench.check()) {
    console.log(`SKIP ${bench.name} — fixture file missing`);
    continue;
  }

  const runs: number[] = [];
  process.stdout.write(`${bench.name.padEnd(30)}`);

  for (let i = 0; i < numRuns; i++) {
    try {
      const ms = bench.run();
      runs.push(ms);
      process.stdout.write(` ${fmtMs(ms)}`);
    } catch (e: any) {
      process.stdout.write(` FAIL`);
      break;
    }
  }
  process.stdout.write("\n");

  if (runs.length > 0) {
    results.push({
      name: bench.name,
      runs,
      avg: runs.reduce((a, b) => a + b, 0) / runs.length,
      min: Math.min(...runs),
      max: Math.max(...runs),
    });
  }
}

// Summary table
console.log(`\n${"=".repeat(72)}`);
console.log("Benchmark Summary");
console.log(`${"=".repeat(72)}\n`);

const hdr = [
  "Script".padEnd(30),
  "Avg".padStart(10),
  "Min".padStart(10),
  "Max".padStart(10),
  "Runs".padStart(6),
].join(" | ");
console.log(hdr);
console.log("-".repeat(hdr.length));

let totalAvg = 0;
for (const r of results) {
  totalAvg += r.avg;
  console.log([
    r.name.padEnd(30),
    fmtMs(r.avg).padStart(10),
    fmtMs(r.min).padStart(10),
    fmtMs(r.max).padStart(10),
    String(r.runs.length).padStart(6),
  ].join(" | "));
}

console.log("-".repeat(hdr.length));
console.log(`${"Total (deterministic scripts)".padEnd(30)} | ${fmtMs(totalAvg).padStart(10)} |`);
console.log();

// Cleanup
rmSync(tmpDir, { recursive: true });
console.log("Temp dir cleaned up.");
