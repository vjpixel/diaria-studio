/**
 * append-ci-failure.ts (#740)
 *
 * Adiciona uma entrada de falha de CI em `data/ci-failures.jsonl`
 * (append-only, dedup por `run_url`).
 *
 * Chamado pelo orchestrator (Stage 0n) após extrair info do email GitHub
 * via Gmail MCP. Responsabilidade do script: só dedup + persist.
 * A extração de dados fica na instrução do orchestrator.
 *
 * Uso:
 *   npx tsx scripts/append-ci-failure.ts \
 *     --workflow "CI" \
 *     --branch "feat/x" \
 *     --run-url "https://github.com/.../runs/123" \
 *     --summary "CI / test — Failed in 1 minute" \
 *     --failed-at "2026-05-06T01:06:00Z"
 *
 * Exit codes:
 *   0  entrada adicionada (ou skipped por dedup)
 *   1  erro de I/O
 *   2  args inválidos
 *
 * Output stdout JSON:
 *   { "added": true, "path": "..." }   ← nova entrada
 *   { "added": false, "reason": "duplicate" }  ← já existia
 */

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CI_FAILURES_PATH = resolve(ROOT, "data", "ci-failures.jsonl");

interface CiFailure {
  workflow: string;
  branch: string;
  run_url: string;
  failed_at: string;
  summary: string;
}

function loadRunUrls(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    return new Set(
      readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return (JSON.parse(line) as CiFailure).run_url;
          } catch {
            return null;
          }
        })
        .filter((u): u is string => !!u),
    );
  } catch {
    return new Set();
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2)).values;
  const { workflow, branch, "run-url": runUrl, summary, "failed-at": failedAt, out } = args;

  if (!workflow || !branch || !runUrl || !summary || !failedAt) {
    console.error(
      "Uso: append-ci-failure.ts --workflow <name> --branch <branch> " +
        "--run-url <url> --summary <text> --failed-at <iso> [--out <path>]",
    );
    process.exit(2);
  }

  // --out permite override do path para testes herméticos
  const outPath = out ? resolve(out) : DEFAULT_CI_FAILURES_PATH;

  const existing = loadRunUrls(outPath);
  if (existing.has(runUrl)) {
    process.stdout.write(JSON.stringify({ added: false, reason: "duplicate" }) + "\n");
    return;
  }

  const entry: CiFailure = {
    workflow,
    branch,
    run_url: runUrl,
    failed_at: failedAt,
    summary,
  };

  try {
    appendFileSync(outPath, JSON.stringify(entry) + "\n", "utf8");
    process.stdout.write(JSON.stringify({ added: true, path: outPath }) + "\n");
  } catch (e) {
    console.error(`Erro ao gravar ${outPath}: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
