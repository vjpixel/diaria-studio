/**
 * clarice-filter.ts (#11798)
 *
 * Remove o ruído do servidor MCP da Clarice (só whitespace / injeção de
 * quebra de linha ou código) de uma lista de sugestões, pros fluxos em que o
 * LLM aplica as sugestões à mão e não usa `clarice-apply.ts`.
 *
 * Uso:
 *   npx tsx scripts/clarice-filter.ts --suggestions <in.json> --out <filtradas.json>
 *
 * --edition-dir <edição> protege trechos do autofix e verbos condicionais no Stage 4.
 * Log ausente é permitido; log inválido aborta sem gravar o filtrado.
 * Grava só as sugestões legítimas em --out (mesmo formato) e imprime no stdout
 * o resumo `{kept, dropped, dropped_details}`. Exit 1 args inválidos, 2 I/O.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";
import { filterClariceSuggestions } from "./lib/clarice-suggestion-guard.ts";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const input = arg(argv, "suggestions");
  const out = arg(argv, "out");
  if (!input || !out) {
    console.error("Uso: clarice-filter.ts --suggestions <in.json> --out <out.json>");
    process.exit(1);
  }
  let list: unknown[];
  try {
    list = JSON.parse(readFileSync(input, "utf8"));
    if (!Array.isArray(list)) throw new Error("suggestions JSON deve ser array");
  } catch (e) {
    console.error(`[clarice-filter] erro lendo --suggestions: ${(e as Error).message}`);
    process.exit(2);
  }
  const editionDir = arg(argv, "edition-dir");
  const correctedTexts: string[] = [];
  if (editionDir) {
    const path = join(editionDir, "_internal", "fact-check-autofix.json");
    try {
      if (existsSync(path)) {
        const log = JSON.parse(readFileSync(path, "utf8"));
        if (!Array.isArray(log.entries)) throw new Error("entries deve ser array");
        if (!log.dry_run) for (const entry of log.entries) {
          if (entry.status === "applied" && typeof entry.suggested_fix === "string" && entry.suggested_fix.trim()) {
            correctedTexts.push(entry.suggested_fix);
          }
        }
      }
    } catch (e) {
      console.error(`[clarice-filter] erro lendo proteção factual: ${(e as Error).message}`);
      process.exit(2);
    }
  }
  const { kept, dropped } = filterClariceSuggestions(list, editionDir
    ? { correctedTexts, protectConditional: true } : undefined);
  try {
    writeFileSync(out, JSON.stringify(kept, null, 2), "utf8");
  } catch (e) {
    console.error(`[clarice-filter] erro gravando --out: ${(e as Error).message}`);
    process.exit(2);
  }
  console.log(JSON.stringify({ kept: kept.length, dropped: dropped.length, dropped_details: dropped }, null, 2));
}

if (isMainModule(import.meta.url)) main();
