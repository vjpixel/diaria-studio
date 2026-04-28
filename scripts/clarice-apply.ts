/**
 * clarice-apply.ts (#212)
 *
 * Aplica sugestões do Clarice MCP (`mcp__clarice__correct_text`) a um texto
 * de forma segura. Clarice retorna sugestões `{ from, to, rule, explanation }`
 * sem offset/posição — aplicar mecanicamente via `text.replace(from, to)` é
 * arriscado quando `from` é uma palavra comum que aparece múltiplas vezes
 * (ex: "mais", "e", "a"): pode corromper pontos errados.
 *
 * Estratégia conservadora:
 * - Conta ocorrências de `from` no texto atual.
 * - count === 1: aplica. Substituição é determinística.
 * - count > 1: SKIP — surface no gate humano pra review manual.
 * - count === 0: SKIP — `from` não está no texto (sugestão stale ou
 *   já aplicada por suggestion anterior).
 *
 * Uso (CLI):
 *   npx tsx scripts/clarice-apply.ts \
 *     --text-file <path-do-md> \
 *     --suggestions <path-do-json-com-sugestoes> \
 *     --out <path-de-saida> \
 *     [--report <path-do-json-de-relatorio>]
 *
 * Input do JSON de sugestões (formato emitido pelo Clarice MCP):
 *   [{ "from": "manter", "to": "manter a", "rule": "...", "explanation": "..." }, ...]
 *
 * Output:
 *   - Arquivo em --out com texto patched (substituições aplicadas)
 *   - JSON de relatório em --report (ou stderr se omitido):
 *     {
 *       "applied": 5,
 *       "skipped": 2,
 *       "applied_details": [...],
 *       "skipped_details": [{ from, to, reason, count, sample? }, ...]
 *     }
 *
 * Exit codes:
 *   0  Success (com ou sem skips — skips não são erro, são para review humano)
 *   1  Args inválidos
 *   2  Erro de I/O (text-file ou suggestions não lidos)
 */

import { readFileSync, writeFileSync } from "node:fs";

export interface ClariceSuggestion {
  from: string;
  to: string;
  rule?: string;
  explanation?: string;
}

export interface SkippedSuggestion extends ClariceSuggestion {
  reason: "ambiguous" | "not_found" | "empty_from";
  count: number;
}

export interface ApplyResult {
  patched: string;
  applied: ClariceSuggestion[];
  skipped: SkippedSuggestion[];
}

/**
 * Conta ocorrências exatas (substring match, case-sensitive) de `needle` em
 * `haystack`. Pulando ocorrências sobrepostas avançando por `needle.length`.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

/**
 * Aplica sugestões do Clarice ao texto, uma de cada vez, em ordem.
 * Cada sugestão é avaliada contra o estado ATUAL do texto (já com applies
 * anteriores) — então "manter" → "manter a" pode tornar uma sugestão
 * subsequente unique ou ambiguous.
 *
 * Skips:
 *   - empty_from: from vazio/whitespace-only (sugestão malformada)
 *   - not_found:  count === 0 (from não aparece no texto)
 *   - ambiguous:  count > 1 (from aparece múltiplas vezes)
 */
export function applyClariceSuggestions(
  text: string,
  suggestions: ClariceSuggestion[],
): ApplyResult {
  let patched = text;
  const applied: ClariceSuggestion[] = [];
  const skipped: SkippedSuggestion[] = [];

  for (const s of suggestions) {
    if (!s.from || !s.from.trim()) {
      skipped.push({ ...s, reason: "empty_from", count: 0 });
      continue;
    }
    const count = countOccurrences(patched, s.from);
    if (count === 1) {
      patched = patched.replace(s.from, s.to);
      applied.push(s);
    } else if (count === 0) {
      skipped.push({ ...s, reason: "not_found", count });
    } else {
      skipped.push({ ...s, reason: "ambiguous", count });
    }
  }

  return { patched, applied, skipped };
}

interface CliArgs {
  textFile: string;
  suggestions: string;
  out: string;
  report?: string;
}

function parseArgs(argv: string[]): CliArgs | null {
  const out: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith("--") || value === undefined) continue;
    const key = flag.slice(2);
    if (key === "text-file") out.textFile = value;
    else if (key === "suggestions") out.suggestions = value;
    else if (key === "out") out.out = value;
    else if (key === "report") out.report = value;
    i++;
  }
  if (!out.textFile || !out.suggestions || !out.out) return null;
  return out as CliArgs;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      "Uso: clarice-apply.ts --text-file <path> --suggestions <path> --out <path> [--report <path>]",
    );
    process.exit(1);
  }

  let text: string;
  let suggestions: ClariceSuggestion[];
  try {
    text = readFileSync(args.textFile, "utf8");
  } catch (e) {
    console.error(`[clarice-apply] erro lendo --text-file: ${(e as Error).message}`);
    process.exit(2);
  }
  try {
    const raw = readFileSync(args.suggestions, "utf8");
    suggestions = JSON.parse(raw) as ClariceSuggestion[];
    if (!Array.isArray(suggestions)) {
      throw new Error("suggestions JSON deve ser array");
    }
  } catch (e) {
    console.error(`[clarice-apply] erro lendo/parseando --suggestions: ${(e as Error).message}`);
    process.exit(2);
  }

  const result = applyClariceSuggestions(text, suggestions);
  writeFileSync(args.out, result.patched, "utf8");

  const report = {
    applied: result.applied.length,
    skipped: result.skipped.length,
    applied_details: result.applied,
    skipped_details: result.skipped,
  };

  const reportJson = JSON.stringify(report, null, 2);
  if (args.report) {
    writeFileSync(args.report, reportJson, "utf8");
  } else {
    console.error(reportJson);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
