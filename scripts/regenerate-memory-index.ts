#!/usr/bin/env tsx
/**
 * regenerate-memory-index.ts (#7533)
 *
 * CLI fino: lê o manifesto de curadoria (`_index.json`) + todos os arquivos
 * `*.md` do diretório de memória (exceto `MEMORY.md` e o próprio manifesto)
 * e regenera `MEMORY.md`. Memória presente no diretório mas ausente de todo
 * `MemoryRef` do manifesto cai automaticamente num bloco final
 * `## Recentes (não classificadas)`, sem tocar os blocos curados — ver
 * `scripts/lib/memory-index.ts` (`buildMemoryMd`) para a lógica pura.
 *
 * `MEMORY.md` deixa de ser editado à mão a partir daqui — é o output
 * gerado deste script (#7533 item 4). Editar diretamente o arquivo gerado
 * não sobrevive à próxima regeneração; curadoria (agrupamento, labels,
 * ordem de blocos) mora no manifesto (`_index.json`), memória nova mora
 * nos arquivos `*.md` individuais.
 *
 * Uso:
 *   npx tsx scripts/regenerate-memory-index.ts --memory-dir <dir> \
 *     [--manifest <path>] [--out <path>] [--discarded <arquivo1,arquivo2>]
 *
 * Defaults: --manifest = <memory-dir>/_index.json, --out = <memory-dir>/MEMORY.md.
 * --discarded lista arquivos a NUNCA colocar em "Recentes" mesmo quando não
 * classificados no manifesto (memória descartada de propósito — ver issue
 * #7533, achado da unificação manual 260906: sem essa lista, remoção não é
 * um fato sincronizável e o arquivo reaparece a cada regeneração).
 *
 * Exit codes:
 *   0 — ok
 *   2 — argumento/ambiente inválido
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  buildMemoryMd,
  parseMemoryFrontmatter,
  type MemoryFileEntry,
  type MemoryManifest,
} from "./lib/memory-index.ts";

function loadMemoryFiles(memoryDir: string, manifestFilename: string): MemoryFileEntry[] {
  const entries: MemoryFileEntry[] = [];
  for (const filename of readdirSync(memoryDir)) {
    if (!filename.endsWith(".md")) continue;
    if (filename === "MEMORY.md") continue;
    const content = readFileSync(join(memoryDir, filename), "utf-8");
    entries.push({ filename, frontmatter: parseMemoryFrontmatter(content) });
  }
  return entries.filter((e) => e.filename !== manifestFilename);
}

export function runRegenerate(argv: string[]): number {
  const { values } = parseArgs(argv);
  const memoryDir = values["memory-dir"] ?? process.env.MEMORY_DIR;
  if (!memoryDir) {
    console.error("Uso: regenerate-memory-index.ts --memory-dir <dir> [--manifest <path>] [--out <path>] [--discarded a,b]");
    return 2;
  }
  const manifestPath = resolve(values.manifest ?? join(memoryDir, "_index.json"));
  if (!existsSync(manifestPath)) {
    console.error(`Manifesto não encontrado em ${manifestPath} — rode extract-memory-index.ts primeiro`);
    return 2;
  }
  const manifest: MemoryManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const files = loadMemoryFiles(memoryDir, "_index.json");
  const discardedFilenames = values.discarded
    ? values.discarded.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const generatedHeader =
    "<!-- GERADO AUTOMATICAMENTE por scripts/regenerate-memory-index.ts (#7533) — não editar à mão.\n" +
    "     Curadoria mora em _index.json; memória nova mora nos arquivos *.md individuais. -->\n";
  const body = buildMemoryMd(manifest, files, { discardedFilenames });
  const outPath = resolve(values.out ?? join(memoryDir, "MEMORY.md"));
  writeFileSync(outPath, `${generatedHeader}${body}\n`, "utf-8");
  console.log(`MEMORY.md regenerado: ${manifest.blocks.length} blocos curados, ${files.length} arquivos no diretório → ${outPath}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(runRegenerate(process.argv.slice(2)));
}
