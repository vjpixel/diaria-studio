#!/usr/bin/env npx tsx
/**
 * prewarm-verify-cache.ts (#1554 P1)
 *
 * Lê researcher-results.json (output do RSS batch + agents) e roda
 * verify-accessibility nas URLs antes do step 1i principal. Quando rodado
 * em background logo após RSS batch (1e), popula o cache cross-edição em
 * paralelo com o dispatch de agents WebSearch (1f), eliminando ~3-5min de
 * verify wall clock no 1i.
 *
 * Estratégia:
 * - Lê researcher-results.json (formato: array de RunRecord ou objeto com articles[])
 * - Extrai URLs únicas
 * - Dispara verify-accessibility com --cache na pasta padrão
 * - Output: stderr stats + arquivo intermediário descartado
 *
 * Uso:
 *   npx tsx scripts/prewarm-verify-cache.ts --edition-dir data/editions/260530/
 *
 * Idempotente: re-rodar é OK — cache hits skipam HEAD+GET.
 * Não-bloqueante: falhas são warnings, não interrompem o pipeline.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface ArticleLike {
  url?: string;
}

interface RunRecord {
  articles?: ArticleLike[];
}

function parseArgs(argv: string[]): { editionDir: string; researcherResults?: string } {
  const raw = parseArgsSimple(argv);
  const editionDir = raw["edition-dir"];
  if (!editionDir) {
    console.error("Uso: prewarm-verify-cache.ts --edition-dir <path> [--researcher-results <path>]");
    process.exit(2);
  }
  return { editionDir, researcherResults: raw["researcher-results"] };
}

function extractUrls(data: unknown): string[] {
  const urls = new Set<string>();
  // Shape 1: array de RunRecord (researcher-results.json)
  if (Array.isArray(data)) {
    for (const record of data) {
      if (record && typeof record === "object" && Array.isArray((record as RunRecord).articles)) {
        for (const article of (record as RunRecord).articles!) {
          if (article && typeof article.url === "string" && article.url.startsWith("http")) {
            urls.add(article.url);
          }
        }
      }
    }
  }
  // Shape 2: objeto com articles top-level
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as { articles?: ArticleLike[] };
    if (Array.isArray(obj.articles)) {
      for (const article of obj.articles) {
        if (article && typeof article.url === "string" && article.url.startsWith("http")) {
          urls.add(article.url);
        }
      }
    }
  }
  return Array.from(urls);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionDir = resolve(ROOT, args.editionDir);
  const internalDir = join(editionDir, "_internal");
  const resultsPath = args.researcherResults
    ? resolve(ROOT, args.researcherResults)
    : join(internalDir, "researcher-results.json");

  if (!existsSync(resultsPath)) {
    console.error(`[prewarm-verify] researcher-results.json não encontrado em ${resultsPath} — skip`);
    process.exit(0); // não-bloqueante
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(resultsPath, "utf8"));
  } catch (e) {
    console.error(`[prewarm-verify] erro ao parsear ${resultsPath}: ${(e as Error).message}`);
    process.exit(0);
  }

  const urls = extractUrls(data);
  if (urls.length === 0) {
    console.error(`[prewarm-verify] 0 URLs encontradas — skip`);
    process.exit(0);
  }

  console.error(`[prewarm-verify] ${urls.length} URLs extraídas pra pre-warm`);

  // Garantir paths
  mkdirSync(internalDir, { recursive: true });
  const urlsPath = join(internalDir, "prewarm-urls.json");
  const outPath = join(internalDir, "prewarm-verify.json");
  const bodiesDir = join(internalDir, "_forensic", "link-verify-bodies");
  const cachePath = resolve(ROOT, "data", "link-verify-cache.json");

  writeFileSync(urlsPath, JSON.stringify(urls), "utf8");

  // Chamar verify-accessibility como subprocess. Cache populado em data/link-verify-cache.json.
  const verifyScript = resolve(ROOT, "scripts", "verify-accessibility.ts");
  const startMs = Date.now();
  const result = spawnSync(
    "npx",
    [
      "tsx",
      verifyScript,
      urlsPath,
      outPath,
      "--bodies-dir",
      bodiesDir,
      "--cache",
      cachePath,
      "--browser-concurrency",
      "8",
    ],
    { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" },
  );
  const elapsedMs = Date.now() - startMs;

  if (result.status !== 0) {
    console.error(`[prewarm-verify] verify-accessibility exited ${result.status} (${elapsedMs}ms) — non-fatal, 1i vai cobrir o que faltar`);
    process.exit(0);
  }

  console.error(`[prewarm-verify] cache warmed in ${(elapsedMs / 1000).toFixed(1)}s for ${urls.length} URLs`);
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main();
}

export { extractUrls };
