#!/usr/bin/env tsx
/**
 * extract-eia-description.ts (#4258 item 3)
 *
 * Extrai a frase de descrição (`wikimedia.description`) de
 * `_internal/01-eia-meta.json` pra um arquivo de texto plano — alvo do passo
 * de humanizador+Clarice no Stage 3 do orchestrator. Antes desta issue,
 * NENHUM texto do "É IA?" passava por esse fluxo (Stage 2 humaniza/corrige só
 * newsletter e social; o composer roda como script determinístico, fora do
 * caminho onde humanizador/Clarice existem).
 *
 * Par com `scripts/apply-eia-description.ts` (recebe o texto já
 * humanizado+corrigido e regrava 01-eia.md + 01-eia-meta.json de forma
 * sincronizada).
 *
 * Uso:
 *   npx tsx scripts/extract-eia-description.ts --edition-dir <dir> --out <path>
 *
 * Exit codes:
 *   0 — description extraída, arquivo escrito
 *   1 — args inválidos
 *   2 — 01-eia-meta.json ausente/malformado, OU sem campo description —
 *       nada pra humanizar. Orchestrator trata como SKIP (edição sem
 *       description, ex: backfill antigo), nunca como erro fatal.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";

/** Pure: extrai `wikimedia.description` de um `01-eia-meta.json` já
 * parseado. `null` quando o campo está ausente/vazio ou o shape não bate —
 * caller trata como "nada pra humanizar" (skip), nunca erro fatal. */
export function extractDescriptionFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const wikimedia = (meta as { wikimedia?: unknown }).wikimedia;
  if (!wikimedia || typeof wikimedia !== "object") return null;
  const description = (wikimedia as { description?: unknown }).description;
  return typeof description === "string" && description.trim() ? description : null;
}

function parseArgs(argv: string[]): { editionDir: string; out: string } | null {
  const args = parseArgsSimple(argv);
  const editionDir = args["edition-dir"] ?? "";
  const out = args.out ?? "";
  if (!editionDir || !out) return null;
  return { editionDir, out };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Uso: extract-eia-description.ts --edition-dir <dir> --out <path>");
    process.exit(1);
  }

  const metaPath = resolve(args.editionDir, "_internal/01-eia-meta.json");
  if (!existsSync(metaPath)) {
    console.error(`[extract-eia-description] ${metaPath} não existe — nada pra extrair.`);
    process.exit(2);
  }

  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (e) {
    console.error(`[extract-eia-description] ${metaPath} não parseia: ${(e as Error).message}`);
    process.exit(2);
  }

  const description = extractDescriptionFromMeta(meta);
  if (!description) {
    console.log("[extract-eia-description] sem campo description — nada pra humanizar (skip).");
    process.exit(2);
  }

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, description, "utf8");
  console.log(`[extract-eia-description] wrote ${outPath}`);
}

if (isMainModule(import.meta.url)) main();
