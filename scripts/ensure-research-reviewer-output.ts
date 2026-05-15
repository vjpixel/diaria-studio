#!/usr/bin/env tsx
/**
 * ensure-research-reviewer-output.ts (#1273)
 *
 * Wrapper de validação pós-dispatch do `research-reviewer` agent.
 *
 * Problema (#1271, #1273): o agent Haiku eventualmente "otimiza" o nome
 * do output (ex: `tmp-reviewed.json` em vez de `tmp-reviewer-output.json`),
 * quebrando o resume + scorer downstream que esperam path canônico. Doc-only
 * enforcement (#1271) é frágil — depende do LLM ler e respeitar `out_path`.
 *
 * Este script roda APÓS o Agent dispatch e:
 *   1. Verifica se o arquivo canônico existe (ok → exit 0).
 *   2. Se não existe, busca em paths alternativos conhecidos.
 *   3. Se achar, renomeia pro canônico + log info.
 *   4. Se não achar nenhum, exit 1 com erro útil.
 *
 * Uso:
 *   npx tsx scripts/ensure-research-reviewer-output.ts \
 *     --canonical data/editions/260515/_internal/tmp-reviewer-output.json
 *
 * Stdout JSON: { canonical, action: "ok" | "renamed_from" | "missing", source?: string }
 */

import { existsSync, renameSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Paths alternativos conhecidos que o LLM agent costuma usar quando "otimiza"
 * o nome canônico. Lista evolutiva — se um nome novo aparecer em prod,
 * adicionar aqui.
 */
export const KNOWN_ALTERNATIVE_NAMES = [
  "tmp-reviewed.json",
  "tmp-reviewer.json",
  "tmp-research-review.json",
  "research-reviewer-output.json",
  "tmp-reviewer-result.json",
];

/**
 * Pure: dado o canonical path, retorna lista de paths alternativos a checar.
 */
export function alternativePathsFor(canonicalPath: string): string[] {
  const dir = dirname(canonicalPath);
  return KNOWN_ALTERNATIVE_NAMES.map((name) => resolve(dir, name));
}

export type EnsureResult =
  | { canonical: string; action: "ok" }
  | { canonical: string; action: "renamed_from"; source: string }
  | { canonical: string; action: "missing"; checked: string[] };

/**
 * Garante que o output do research-reviewer está no path canônico.
 * Renomeia de path alternativo conhecido quando necessário.
 */
export function ensureResearchReviewerOutput(
  canonicalPath: string,
  opts: {
    fileExists?: (p: string) => boolean;
    rename?: (from: string, to: string) => void;
  } = {},
): EnsureResult {
  const fileExists = opts.fileExists ?? existsSync;
  const rename = opts.rename ?? renameSync;

  if (fileExists(canonicalPath)) {
    return { canonical: canonicalPath, action: "ok" };
  }

  const alts = alternativePathsFor(canonicalPath);
  for (const alt of alts) {
    if (fileExists(alt)) {
      rename(alt, canonicalPath);
      return { canonical: canonicalPath, action: "renamed_from", source: alt };
    }
  }

  return { canonical: canonicalPath, action: "missing", checked: alts };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.canonical) {
    console.error(
      "Uso: ensure-research-reviewer-output.ts --canonical <path>",
    );
    process.exit(2);
  }
  const canonical = resolve(ROOT, args.canonical);
  const result = ensureResearchReviewerOutput(canonical);

  console.log(JSON.stringify(result, null, 2));

  if (result.action === "missing") {
    console.error(
      `[ensure-research-reviewer] Output não encontrado em '${basename(canonical)}' nem em ${KNOWN_ALTERNATIVE_NAMES.length} paths alternativos. Re-disparar o agent ou verificar prompt.`,
    );
    process.exit(1);
  }
  if (result.action === "renamed_from") {
    console.error(
      `[ensure-research-reviewer] Renomeado de '${basename(result.source)}' pro canônico '${basename(canonical)}' — agent ignorou out_path (#1273).`,
    );
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
