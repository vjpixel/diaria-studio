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
 * --source-text <texto> (#12794) grava também `{out}.source.json` com o sha256
 *   do texto enviado à Clarice e do filtrado, para o consumidor conferir que
 *   o filtrado é DESTE texto (`scripts/lib/clarice-source-binding.ts`).
 * Log ausente é permitido; log inválido aborta sem gravar o filtrado.
 * Grava só as sugestões legítimas em --out (mesmo formato) e imprime no stdout
 * o resumo `{kept, dropped, dropped_details}`. Exit 1 args inválidos, 2 I/O.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isMainModule } from "./lib/cli-args.ts";
import { readFactCheckProtection } from "./lib/fact-check-protection.ts";
import { filterClariceSuggestions } from "./lib/clarice-suggestion-guard.ts";
import { buildClariceSourceSidecar, clariceSourceSidecarPath } from "./lib/clarice-source-binding.ts";

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
  let correctedTexts: string[] = [];
  if (editionDir) {
    try {
      correctedTexts = readFactCheckProtection(editionDir).correctedTexts;
    } catch (e) {
      console.error(`[clarice-filter] erro lendo proteção factual: ${(e as Error).message}`);
      process.exit(2);
    }
  }
  const { kept, dropped } = filterClariceSuggestions(list, editionDir
    ? { correctedTexts, protectConditional: true } : undefined);
  const sourceTextPath = arg(argv, "source-text");
  let sourceText: string | null = null;
  if (sourceTextPath) {
    try {
      sourceText = readFileSync(sourceTextPath, "utf8");
    } catch (e) {
      console.error(`[clarice-filter] erro lendo --source-text: ${(e as Error).message}`);
      process.exit(2);
    }
  }
  try {
    const content = JSON.stringify(kept, null, 2);
    writeFileSync(out, content, "utf8");
    // #12794: amarra o filtrado ao texto enviado à Clarice.
    if (sourceText !== null) {
      const sidecar = buildClariceSourceSidecar(sourceText, content, kept.length);
      writeFileSync(clariceSourceSidecarPath(out), JSON.stringify(sidecar, null, 2) + "\n", "utf8");
    }
  } catch (e) {
    console.error(`[clarice-filter] erro gravando --out: ${(e as Error).message}`);
    process.exit(2);
  }
  console.log(JSON.stringify({ kept: kept.length, dropped: dropped.length, dropped_details: dropped }, null, 2));
}

if (isMainModule(import.meta.url)) main();
