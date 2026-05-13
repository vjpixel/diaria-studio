/**
 * chunk-html-base64.ts (#1054 / parte da refatoração playbook chunked)
 *
 * Lê `_internal/newsletter-final.html`, encoda base64 e divide em N chunks
 * de tamanho fixo. Cada chunk vai pra `_internal/_b64_{i}.txt`. Pré-requisito
 * pro top-level Claude Code colar HTML grande no Beehiiv via
 * `mcp__claude-in-chrome__javascript_tool` (limit de input ~7KB por chamada,
 * validado em #1054 smoke test 2026-05-10).
 *
 * Uso:
 *   npx tsx scripts/chunk-html-base64.ts --edition-dir data/editions/260510/
 *   npx tsx scripts/chunk-html-base64.ts --edition-dir ... --chunk-size 2500
 *
 * Output stdout (JSON):
 *   {
 *     "chunkCount": 16,
 *     "totalBase64Bytes": 37788,
 *     "htmlBytes": 28341,
 *     "files": ["_b64_0.txt", ...],
 *     "chunkSize": 2500,
 *     "hashes": ["006731d021bf4c02", ...]    // #1177 — SHA-256 truncado 16 hex
 *   }
 *
 * Background: paste de 16KB completo em htmlSnippet TipTap funciona via
 * `editor.commands.insertContent({type:'text', text: html})` após decode dos
 * chunks (validação E2E #4 do #1054 — execCommand atualiza só DOM, não state).
 * Cada javascript_tool call só aceita ~7KB de string literal — daí o
 * chunked accumulator pattern.
 *
 * #1177 defense in depth:
 * - Default chunk-size reduzido de 6500 → 2500 (vimos corrupção 1 char/6500
 *   em edição 260513, com 2500 sem corrupção). Chunks menores = menos
 *   superfície de erro durante transmissão LLM → javascript_tool string arg.
 * - Output inclui `hashes[]` (SHA-256 truncado pra 16 hex chars por chunk).
 *   Consumer compara hash in-browser do chunk recebido com hash local —
 *   detecta corruption silent char-a-char ANTES de fazer decode + paste.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ChunkResult {
  chunkCount: number;
  totalBase64Bytes: number;
  htmlBytes: number;
  files: string[];
  chunkSize: number;
  /** #1177: SHA-256 truncado (16 hex chars) por chunk — pro consumer detectar
   *  corrupção char-a-char durante transmissão LLM → javascript_tool. */
  hashes: string[];
}

/**
 * Hash SHA-256 truncado a 16 hex chars (8 bytes). Suficiente pra detectar
 * corrupção de transmissão (collision rate ~1 em 2^32 = aceitável p/ uso).
 */
export function hashChunk(chunk: string): string {
  return createHash("sha256").update(chunk, "utf8").digest("hex").slice(0, 16);
}

export function chunkBase64(b64: string, chunkSize: number): string[] {
  if (chunkSize < 1) throw new Error(`chunkSize must be >= 1 (got ${chunkSize})`);
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += chunkSize) {
    chunks.push(b64.slice(i, i + chunkSize));
  }
  return chunks;
}

export function encodeHtmlBase64(html: string): string {
  return Buffer.from(html, "utf8").toString("base64");
}

export function writeChunks(
  internalDir: string,
  chunks: string[],
): string[] {
  // Cleanup any pre-existing _b64_*.txt to avoid stale chunks
  if (existsSync(internalDir)) {
    for (const f of readdirSync(internalDir)) {
      if (/^_b64_\d+\.txt$/.test(f)) {
        unlinkSync(resolve(internalDir, f));
      }
    }
  }
  const filenames: string[] = [];
  chunks.forEach((chunk, i) => {
    const filename = `_b64_${i}.txt`;
    writeFileSync(resolve(internalDir, filename), chunk, "utf8");
    filenames.push(filename);
  });
  return filenames;
}

export function chunkHtmlFile(
  htmlPath: string,
  internalDir: string,
  chunkSize: number,
): ChunkResult {
  if (!existsSync(htmlPath)) {
    throw new Error(`HTML file não encontrado: ${htmlPath}`);
  }
  const html = readFileSync(htmlPath, "utf8");
  const b64 = encodeHtmlBase64(html);
  const chunks = chunkBase64(b64, chunkSize);
  const files = writeChunks(internalDir, chunks);
  return {
    chunkCount: chunks.length,
    totalBase64Bytes: b64.length,
    htmlBytes: Buffer.byteLength(html, "utf8"),
    files,
    chunkSize,
    hashes: chunks.map(hashChunk),
  };
}

function parseArgs(argv: string[]): {
  editionDir: string | null;
  chunkSize: number;
  htmlPath: string | null;
} {
  let editionDir: string | null = null;
  // #1177: default 2500 (era 6500). Chunks menores reduzem risco de corrupção
  // char-a-char durante transmissão LLM → javascript_tool string arg. Edição
  // 260513 expôs corrupção 1 char/6500 (B2B → B2C); 2500 não corrompeu.
  let chunkSize = 2500;
  let htmlPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--edition-dir" && i + 1 < argv.length) {
      editionDir = argv[++i];
    } else if (arg === "--chunk-size" && i + 1 < argv.length) {
      chunkSize = Number.parseInt(argv[++i], 10);
      if (Number.isNaN(chunkSize) || chunkSize < 1) {
        throw new Error(`--chunk-size inválido (got '${argv[i]}')`);
      }
    } else if (arg === "--html" && i + 1 < argv.length) {
      htmlPath = argv[++i];
    }
  }
  return { editionDir, chunkSize, htmlPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.editionDir && !args.htmlPath) {
    console.error(
      "Uso: chunk-html-base64.ts --edition-dir <path> [--chunk-size 6500]",
    );
    console.error(
      "     chunk-html-base64.ts --html <path-to-html> [--chunk-size 6500]",
    );
    process.exit(2);
  }

  let htmlPath: string;
  let internalDir: string;
  if (args.htmlPath) {
    htmlPath = resolve(ROOT, args.htmlPath);
    internalDir = dirname(htmlPath);
  } else {
    const editionDir = resolve(ROOT, args.editionDir!);
    htmlPath = resolve(editionDir, "_internal", "newsletter-final.html");
    internalDir = resolve(editionDir, "_internal");
  }

  if (!existsSync(internalDir)) {
    console.error(`[chunk-html-base64] _internal dir não existe: ${internalDir}`);
    process.exit(2);
  }

  const result = chunkHtmlFile(htmlPath, internalDir, args.chunkSize);
  console.log(JSON.stringify(result, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
