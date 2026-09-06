#!/usr/bin/env tsx
/**
 * extract-memory-index.ts (#7533)
 *
 * CLI fino: lê um `MEMORY.md` existente e escreve o manifesto de curadoria
 * extraído (`_index.json`) — o "extrator one-shot" mencionado na issue,
 * agora versionado. Fecha o round-trip com `regenerate-memory-index.ts`.
 *
 * O diretório de memória (`~/.claude/projects/{slug}/memory/`) fica FORA
 * deste repo git e o caminho varia por máquina/usuário (o slug deriva do
 * caminho do projeto, o nome de usuário do Windows muda entre máquinas —
 * ver issue #7533, achado da unificação manual 260906). Por isso o path é
 * sempre um argumento explícito ou variável de ambiente, nunca hardcoded.
 *
 * Uso:
 *   npx tsx scripts/extract-memory-index.ts --memory-dir <dir> [--out <path>]
 *   # ou
 *   MEMORY_DIR=<dir> npx tsx scripts/extract-memory-index.ts
 *
 * Default de --out: <memory-dir>/_index.json
 *
 * Exit codes:
 *   0 — ok
 *   2 — argumento/ambiente inválido (memory-dir ausente ou sem MEMORY.md)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { extractManifest } from "./lib/memory-index.ts";

export function resolveMemoryDir(values: Record<string, string>): string | undefined {
  return values["memory-dir"] ?? process.env.MEMORY_DIR;
}

export function runExtract(argv: string[]): number {
  const { values } = parseArgs(argv);
  const memoryDir = resolveMemoryDir(values);
  if (!memoryDir) {
    console.error("Uso: extract-memory-index.ts --memory-dir <dir> [--out <path>] (ou env MEMORY_DIR)");
    return 2;
  }
  const memoryMdPath = join(memoryDir, "MEMORY.md");
  if (!existsSync(memoryMdPath)) {
    console.error(`MEMORY.md não encontrado em ${memoryMdPath}`);
    return 2;
  }
  const raw = readFileSync(memoryMdPath, "utf-8");
  const manifest = extractManifest(raw);
  const outPath = resolve(values.out ?? join(memoryDir, "_index.json"));
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  console.log(`Manifesto extraído: ${manifest.blocks.length} blocos → ${outPath}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(runExtract(process.argv.slice(2)));
}
