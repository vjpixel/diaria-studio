#!/usr/bin/env npx tsx
/**
 * lint-contest-entries.ts (#954)
 *
 * Validador de integridade pro `data/contest-entries.jsonl`. Roda em CI
 * via `npm test` (precisa ser invocado como check separado) ou manual.
 *
 * Valida:
 *   1. Cada linha não-vazia parseia como JSON
 *   2. Cada entry tem campos obrigatórios (schema completo)
 *   3. `number` é positivo e único dentro de cada `draw_month`
 *   4. `draw_month` formato YYYY-MM
 *   5. `edition` formato AAMMDD (6 dígitos, ano 25-29)
 *   6. `confirmed_at` parseable como ISO 8601 com timezone
 *   7. `reader_email` aparenta formato válido
 *   8. `error_type` ∈ KNOWN_ERROR_TYPES (importado de lib/contest-entries) — warn se desconhecido
 *
 * Não-validações intencionais:
 *   - `reply_thread_id` vazio é tolerado: bootstrap retroativo (#948, #953)
 *     pode ter perdido rastro de algumas threads. Schema check confere
 *     presença, não conteúdo.
 *   - `detail` formato livre — texto descritivo, sem estrutura imposta.
 *
 * Uso:
 *   npx tsx scripts/lint-contest-entries.ts
 *   npx tsx scripts/lint-contest-entries.ts --in path/to/file.jsonl
 *
 * Exit:
 *   0 — todas validações passaram
 *   1 — erros bloqueantes (schema/duplicação/parse)
 *   2 — args inválidos
 *
 * Warnings em stderr (error_type desconhecido) não bloqueiam exit 0.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "./lib/cli-args.ts";
import { KNOWN_ERROR_TYPES } from "./lib/contest-entries.ts";

const DEFAULT_PATH = "data/contest-entries.jsonl";

const REQUIRED_FIELDS = [
  "draw_month",
  "number",
  "reader_email",
  "reader_name",
  "edition",
  "error_type",
  "detail",
  "reply_thread_id",
  "confirmed_at",
] as const;

const DRAW_MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/;
const EDITION_RE = /^2[5-9]\d{4}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LintResult {
  errors: string[];
  warnings: string[];
  total_lines: number;
  valid_entries: number;
}

export function lintContestEntries(content: string): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let validEntries = 0;
  const numberByMonth = new Map<string, Set<number>>();
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    const lineNum = i + 1;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      errors.push(`linha ${lineNum}: JSON inválido — ${err instanceof Error ? err.message : "parse error"}`);
      continue;
    }

    // Schema completo
    const missing = REQUIRED_FIELDS.filter((f) => !(f in parsed));
    if (missing.length > 0) {
      errors.push(`linha ${lineNum}: campos ausentes — ${missing.join(", ")}`);
      continue;
    }

    // draw_month
    if (typeof parsed.draw_month !== "string" || !DRAW_MONTH_RE.test(parsed.draw_month)) {
      errors.push(`linha ${lineNum}: draw_month inválido — esperado YYYY-MM, recebido ${JSON.stringify(parsed.draw_month)}`);
    }

    // number positivo
    if (typeof parsed.number !== "number" || parsed.number <= 0 || !Number.isInteger(parsed.number)) {
      errors.push(`linha ${lineNum}: number inválido — esperado inteiro positivo, recebido ${JSON.stringify(parsed.number)}`);
    } else if (typeof parsed.draw_month === "string") {
      // Unicidade dentro de draw_month
      const month = parsed.draw_month;
      if (!numberByMonth.has(month)) numberByMonth.set(month, new Set());
      const nums = numberByMonth.get(month)!;
      if (nums.has(parsed.number)) {
        errors.push(`linha ${lineNum}: number duplicado — ${parsed.number} já apareceu em draw_month ${month}`);
      } else {
        nums.add(parsed.number);
      }
    }

    // edition
    if (typeof parsed.edition !== "string" || !EDITION_RE.test(parsed.edition)) {
      errors.push(`linha ${lineNum}: edition inválida — esperado AAMMDD (ano 25-29), recebido ${JSON.stringify(parsed.edition)}`);
    }

    // confirmed_at ISO 8601
    if (typeof parsed.confirmed_at !== "string") {
      errors.push(`linha ${lineNum}: confirmed_at deve ser string ISO`);
    } else {
      const d = new Date(parsed.confirmed_at);
      if (Number.isNaN(d.getTime())) {
        errors.push(`linha ${lineNum}: confirmed_at não-parseable — ${parsed.confirmed_at}`);
      }
    }

    // reader_email formato
    if (typeof parsed.reader_email !== "string" || !EMAIL_RE.test(parsed.reader_email)) {
      errors.push(`linha ${lineNum}: reader_email inválido — ${JSON.stringify(parsed.reader_email)}`);
    }

    // error_type warn-only
    if (typeof parsed.error_type === "string" && !KNOWN_ERROR_TYPES.has(parsed.error_type)) {
      warnings.push(`linha ${lineNum}: error_type desconhecido "${parsed.error_type}" (esperado: ${[...KNOWN_ERROR_TYPES].join("|")})`);
    }

    // Se não acumulou erro nessa linha, conta como válida
    if (!errors.some((e) => e.startsWith(`linha ${lineNum}:`))) {
      validEntries++;
    }
  }

  return {
    errors,
    warnings,
    total_lines: lines.filter((l) => l.trim().length > 0).length,
    valid_entries: validEntries,
  };
}

function main(): number {
  const { values } = parseArgs(process.argv.slice(2));
  const inPath = (typeof values["in"] === "string" ? values["in"] : null) ?? DEFAULT_PATH;
  const path = resolve(process.cwd(), inPath);

  if (!existsSync(path)) {
    process.stderr.write(`[lint-contest-entries] arquivo não existe: ${path}\n`);
    return 0; // ausência não é erro — bootstrap manual posterior
  }

  const content = readFileSync(path, "utf8");
  const result = lintContestEntries(content);

  for (const w of result.warnings) {
    process.stderr.write(`⚠️  ${w}\n`);
  }

  if (result.errors.length > 0) {
    process.stderr.write(`\n❌ ${result.errors.length} erro(s) em ${path}:\n`);
    for (const e of result.errors) {
      process.stderr.write(`  ${e}\n`);
    }
    return 1;
  }

  process.stdout.write(
    `✓ ${result.valid_entries}/${result.total_lines} entries válidas em ${inPath}\n`,
  );
  if (result.warnings.length > 0) {
    process.stdout.write(`  (${result.warnings.length} warning(s) em stderr)\n`);
  }
  return 0;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  process.exit(main());
}
