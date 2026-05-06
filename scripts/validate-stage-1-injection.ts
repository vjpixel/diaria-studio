/**
 * validate-stage-1-injection.ts (#625)
 *
 * Validador externo anti-skip do step 1h (inject-inbox-urls.ts).
 * Roda após step 1h e verifica que todos os URLs do editor estão no pool.
 *
 * Diferente de --validate-pool (interno ao próprio script de injeção, tautológico),
 * este script é externo — detecta o cenário onde o orchestrator skipa a chamada
 * inteira de inject-inbox-urls.ts.
 *
 * Uso:
 *   npx tsx scripts/validate-stage-1-injection.ts \
 *     --edition-dir data/editions/260505 \
 *     --inbox-md data/inbox.md \
 *     [--editor diariaeditor@gmail.com]
 *
 * Exit 0: todos os URLs do editor estão no pool.
 * Exit 1: URLs faltantes detectados → step 1h foi skipado ou falhou.
 * Exit 2: erro de leitura de arquivo (pool não encontrado, inbox inválido).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli-args.ts";
import { canonicalize } from "./lib/url-utils.ts";
import { parseJsonSafe } from "./lib/json-safe.ts";
import {
  parseInboxMd,
  filterEditorBlocks,
  extractEditorUrls,
} from "./inject-inbox-urls.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";

const DEFAULT_EDITOR = process.env.EDITOR_EMAIL ?? resolveEditorEmail(resolve("platform.config.json"));

export interface ValidationResult {
  status: "ok" | "missing";
  inbox_urls: number;
  pool_size: number;
  missing: string[];
  all_present: boolean;
}

/**
 * Compara editorUrls contra poolUrls usando canonicalize() para dedup robusto.
 * Retorna lista de URLs do editor ausentes no pool.
 */
export function computeMissingUrls(editorUrls: string[], poolUrls: string[]): string[] {
  const poolCanon = new Set(poolUrls.map(canonicalize));
  return editorUrls.filter((u) => !poolCanon.has(canonicalize(u)));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionDir = args.values["edition-dir"];
  const inboxMd = args.values["inbox-md"] ?? "data/inbox.md";
  const editor = args.values["editor"] ?? DEFAULT_EDITOR;

  if (!editionDir) {
    console.error("Erro: --edition-dir obrigatório");
    process.exit(2);
  }

  const poolPath = resolve(editionDir, "_internal/tmp-articles-raw.json");
  const inboxPath = resolve(inboxMd);

  if (!existsSync(poolPath)) {
    console.error(`Erro: pool não encontrado em ${poolPath}`);
    process.exit(2);
  }

  if (!existsSync(inboxPath)) {
    // Inbox vazio é ok — sem submissões do editor, nada a validar
    console.log(JSON.stringify({ status: "ok", inbox_urls: 0, pool_size: 0, missing: [], all_present: true }));
    process.exit(0);
  }

  const inboxText = readFileSync(inboxPath, "utf8");
  const poolRaw = parseJsonSafe<Array<{ url: string }>>(readFileSync(poolPath, "utf8"), poolPath);
  const poolUrls = poolRaw.map((a) => a.url);

  const blocks = parseInboxMd(inboxText);
  const editorBlocks = filterEditorBlocks(blocks, editor);
  const editorArticles = extractEditorUrls(editorBlocks);
  const editorUrls = editorArticles.map((a) => a.url);

  if (editorUrls.length === 0) {
    console.log(JSON.stringify({ status: "ok", inbox_urls: 0, pool_size: poolUrls.length, missing: [], all_present: true }));
    process.exit(0);
  }

  const missing = computeMissingUrls(editorUrls, poolUrls);

  const result: ValidationResult = {
    status: missing.length === 0 ? "ok" : "missing",
    inbox_urls: editorUrls.length,
    pool_size: poolUrls.length,
    missing,
    all_present: missing.length === 0,
  };

  if (missing.length > 0) {
    console.error(
      `❌ Step 1h skipado ou falhou: ${missing.length}/${editorUrls.length} URLs do editor ausentes no pool.`,
    );
    console.error("URLs faltantes:");
    for (const u of missing) console.error(`  - ${u}`);
    console.error(`Refazer: npx tsx scripts/inject-inbox-urls.ts --inbox-md ${inboxMd} --pool ${poolPath} --out ${poolPath} --editor ${editor}`);
    process.exit(1);
  }

  console.log(JSON.stringify(result));
  process.exit(0);
}

// Guard: só roda CLI quando invocado diretamente (não ao importar como módulo em testes)
const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url).replace(/\\/g, "/") === process.argv[1].replace(/\\/g, "/");

if (isMain) main();
