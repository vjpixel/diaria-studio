#!/usr/bin/env tsx
/**
 * validate-frontmatter-yaml.ts (#2553; #3222 repurposed — JSON em vez de YAML frontmatter)
 *
 * Guard pré-gate: valida que `_internal/intentional-error.json` da edição é
 * JSON bem-formado e tem as 5 chaves esperadas: description, location,
 * category, correct_value, reveal.
 *
 * **Histórico (#3205/#3222):** até 260710 este script detectava colapso de
 * YAML multi-linha no frontmatter de `02-reviewed.md` (edição 260625: o
 * agente `title-picker` reescreveu o arquivo com `intentional_error` numa
 * única linha `## intentional_error: description: "..." ...` em vez de
 * mapping YAML válido). A causa raiz era o round-trip via Google Docs:
 * `02-reviewed.md` sincroniza com o Drive (o editor revisa/edita lá) e o
 * exportador do Docs não preserva indentação/quebras de linha dentro de
 * blocos `---...---`, reconstruindo o YAML como texto solto — reproduzido
 * 4x (#3205).
 *
 * A correção (#3222) move os campos estruturados pra
 * `_internal/intentional-error.json`, que nunca sincroniza com o Drive
 * (convenção `_internal/*`, #959) — elimina a classe de corrupção "colapso de
 * YAML via Google Docs" na origem, não só a detecta depois. Este script foi
 * repurposed: continua útil como guard de schema (JSON malformado por edição
 * manual, campos faltando), mas não há mais "colapso de bloco multi-linha"
 * pra detectar — não existe mais YAML aqui.
 *
 * Uso:
 *   npx tsx scripts/validate-frontmatter-yaml.ts \
 *     --md data/editions/AAMMDD/02-reviewed.md
 *
 * (deriva `_internal/intentional-error.json` como sibling de `--md` — mesmo
 * padrão de `checkIntentionalError` em `lib/lint-checks/intentional-error.ts`,
 * que mantém a assinatura `--md` estável pros callers existentes.)
 *
 * Exit codes:
 *   0  OK — JSON parseável e intentional_error completo (ou ausente/no_error —
 *      ausência é responsabilidade de check-stage2-invariants, não deste script)
 *   1  FAIL — JSON malformado ou campos faltando/placeholder
 *   2  Erro de uso (argumento ausente, arquivo não encontrado)
 *
 * Output JSON em stdout: `{ ok, checked, message, missing_fields }`.
 *
 * NOTE: este script não exige que `intentional_error` esteja PREENCHIDO se o
 * arquivo simplesmente não existir ainda (`checked: false`) — a validação de
 * ausência fica no Stage 2 (`check-stage2-invariants.ts`); a validação de
 * preenchimento fica no Stage 5 (`--check intentional-error-flagged`). Aqui
 * só validamos estrutura/schema do JSON quando ele existe.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadIntentionalErrorJson, intentionalErrorJsonPath } from "./lib/intentional-errors.ts";
import { parseArgsSimple as parseArgs } from "./lib/cli-args.ts";

export const REQUIRED_IE_FIELDS = [
  "description",
  "location",
  "category",
  "correct_value",
  "reveal",
] as const;

export type RequiredIEField = (typeof REQUIRED_IE_FIELDS)[number];

export interface FrontmatterYamlResult {
  /** true = record OK (ou ausente — sem penalidade aqui) */
  ok: boolean;
  /** true = script encontrou e inspecionou o JSON */
  checked: boolean;
  message: string;
  /** Campos faltando/placeholder (apenas quando ok=false) */
  missing_fields: RequiredIEField[];
}

/**
 * Pure: valida o record de `_internal/intentional-error.json` (#3222).
 *
 * Retorna `{ ok: true }` quando:
 *   - `record` é `null` (arquivo ausente — outro guard cobre isso, `checked: false`)
 *   - `record.no_error === true` (#2016/#2037 — edição sem erro intencional declarado)
 *   - `record` tem as 5 chaves preenchidas (nenhuma vazia ou placeholder `{PREENCHER}`)
 *
 * Retorna `{ ok: false }` quando `record` existe mas tem chaves faltando,
 * vazias, ou com valor placeholder não preenchido.
 */
export function validateIntentionalErrorJson(
  record: ReturnType<typeof loadIntentionalErrorJson>,
): FrontmatterYamlResult {
  if (record === null) {
    return {
      ok: true,
      checked: false,
      message:
        "_internal/intentional-error.json ausente — check-stage2-invariants.ts detecta isso; sem ação aqui",
      missing_fields: [],
    };
  }

  if (record.no_error === true) {
    return {
      ok: true,
      checked: true,
      message: "no_error: true — edição sem erro intencional declarado",
      missing_fields: [],
    };
  }

  const isMissingOrPlaceholder = (field: RequiredIEField): boolean => {
    const val = record[field];
    if (typeof val !== "string") return true;
    const trimmed = val.trim();
    return trimmed.length === 0 || /^\{PREENCHER/i.test(trimmed);
  };

  const missing = REQUIRED_IE_FIELDS.filter(isMissingOrPlaceholder);
  if (missing.length > 0) {
    return {
      ok: false,
      checked: true,
      message: `intentional_error incompleto: campos faltando ou não preenchidos — ${missing.join(", ")}`,
      missing_fields: missing,
    };
  }

  return {
    ok: true,
    checked: true,
    message: "_internal/intentional-error.json válido e completo",
    missing_fields: [],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.md) {
    console.error(
      "Uso: validate-frontmatter-yaml.ts --md data/editions/AAMMDD/02-reviewed.md",
    );
    process.exit(2);
  }
  const mdPath = resolve(process.cwd(), args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não encontrado: ${mdPath}`);
    process.exit(2);
  }
  const jsonPath = intentionalErrorJsonPath(dirname(mdPath));
  const record = loadIntentionalErrorJson(jsonPath);
  const result = validateIntentionalErrorJson(record);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n[validate-frontmatter-yaml] FAIL: ${result.message}`);
    if (result.missing_fields.length > 0) {
      console.error(`  → Campos faltando: ${result.missing_fields.join(", ")}`);
      console.error(`  → Corrija ${jsonPath}`);
    }
    process.exit(1);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
