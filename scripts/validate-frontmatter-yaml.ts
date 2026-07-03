#!/usr/bin/env tsx
/**
 * validate-frontmatter-yaml.ts (#2553)
 *
 * Guard pós-title-picker: valida que o frontmatter YAML de `02-reviewed.md`
 * está bem-formado e tem `intentional_error` com as 5 chaves obrigatórias.
 *
 * Problema original (edição 260625): o agente `title-picker` reescreveu
 * `02-reviewed.md` com o `intentional_error` colapsado numa única linha com
 * prefixo `## ` em vez do YAML multi-linha válido. A corrupção passou pelo
 * `check-stage2-invariants.ts` (que só checa presença da chave `intentional_error:`)
 * e pelo `validate-section-structure.ts` (que compara contagem de seções, não YAML).
 * O `render-erro-intencional.ts` da próxima edição quebraria ao tentar ler
 * `intentional_error.reveal`.
 *
 * Este script:
 *   1. Extrai o frontmatter YAML via `extractFrontmatter` (parser canônico CRLF-safe).
 *   2. Faz parse simples do bloco `intentional_error` como mapping YAML.
 *   3. Verifica que as 5 chaves estão presentes: description, location, category,
 *      correct_value, reveal.
 *   4. Detecta formato colapsado (ausência de indented sub-chaves → single-line).
 *
 * Uso:
 *   npx tsx scripts/validate-frontmatter-yaml.ts \
 *     --md data/editions/AAMMDD/02-reviewed.md
 *
 * Exit codes:
 *   0  OK — frontmatter parseável e intentional_error completo (ou absent/placeholder)
 *   1  FAIL — frontmatter corrompido / intentional_error malformado (chaves faltando)
 *   2  Erro de uso (argumento ausente, arquivo não encontrado)
 *
 * Output JSON em stdout: `{ ok, checked, message, missing_fields, collapsed }`.
 *
 * NOTE: este script não exige que `intentional_error` esteja PREENCHIDO (valores
 * {PREENCHER} são aceitos) — a validação de preenchimento fica no Stage 5
 * (`--check intentional-error-flagged`). Aqui só validamos estrutura YAML.
 * Também aceita `intentional_error: none` (#2016) como OK.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractFrontmatter } from "./lib/lint-checks/intentional-error.ts";
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
  /** true = frontmatter OK (ou ausente — sem penalidade aqui) */
  ok: boolean;
  /** true = script rodou e inspecionou o frontmatter */
  checked: boolean;
  message: string;
  /** Campos faltando no mapping (apenas quando ok=false e collapsed=false) */
  missing_fields: RequiredIEField[];
  /** true = intentional_error encontrado mas colapsado em 1 linha (sem indentação) */
  collapsed: boolean;
}

/**
 * Pure: valida o frontmatter YAML de `mdContent`.
 *
 * Retorna `{ ok: true }` quando:
 *   - Sem frontmatter (check não se aplica — outro guard cobre ausência)
 *   - `intentional_error: none` (#2016)
 *   - `intentional_error` com as 5 chaves (valores placeholder OK)
 *
 * Retorna `{ ok: false }` quando:
 *   - `intentional_error` presente mas colapsado (sem sub-chaves indentadas)
 *   - `intentional_error` presente mas com chaves faltando
 *
 * Também detecta a corrupção real da edição 260625: o agente title-picker
 * colapsou o bloco YAML e o escreveu de volta com prefixo `## ` no corpo
 * do MD (fora dos delimitadores `---`). Nesses casos o frontmatter canônico
 * não existe, mas o conteúdo corrompido está visível no corpo.
 */
export function validateFrontmatterYaml(mdContent: string): FrontmatterYamlResult {
  // Normalizar line endings para LF para simplificar regexes internos.
  // extractFrontmatter é CRLF-safe nativamente (usa \r?\n), mas os regexes
  // de parsing do ieBlock usam \n — normalizar evita falsos negativos no Windows.
  const md = mdContent.replace(/\r\n/g, "\n");

  // Detectar corrupção real 260625: intentional_error colapsado no corpo do MD
  // com prefixo `## ` ou sem frontmatter (agent escreveu fora do bloco YAML).
  // Precede a extração de frontmatter porque quando isso acontece o bloco YAML
  // pode não existir mais como tal.
  const collapsedInBody =
    /^##\s+intentional_error\s*:.*description\s*:/im.test(md) ||
    /^intentional_error\s*:.*description\s*:.*location\s*:/im.test(md);

  if (collapsedInBody) {
    return {
      ok: false,
      checked: true,
      message:
        "intentional_error corrompido: encontrado colapsado no corpo do MD (fora do frontmatter YAML). " +
        "Provável causa: title-picker reescreveu 02-reviewed.md colapsando o bloco YAML multi-linha. " +
        "Restaurar 02-reviewed.md do snapshot `_internal/02-pre-title-picker.md`.",
      missing_fields: [],
      collapsed: true,
    };
  }

  const fmBody = extractFrontmatter(md, 60);

  if (!fmBody) {
    // Sem frontmatter — check-stage2-invariants já cobre isso
    return {
      ok: true,
      checked: false,
      message: "frontmatter ausente — check-stage2-invariants detecta isso; sem ação aqui",
      missing_fields: [],
      collapsed: false,
    };
  }

  // Sem chave intentional_error → check-stage2-invariants já cobre
  if (!/intentional_error\s*:/i.test(fmBody)) {
    return {
      ok: true,
      checked: false,
      message: "intentional_error ausente no frontmatter — check-stage2-invariants detecta isso",
      missing_fields: [],
      collapsed: false,
    };
  }

  // Aceitar `intentional_error: none` (#2016)
  if (/intentional_error\s*:\s*(none|null)\s*(\n|$)/i.test(fmBody)) {
    return {
      ok: true,
      checked: true,
      message: "intentional_error: none — edição sem erro intencional declarado",
      missing_fields: [],
      collapsed: false,
    };
  }

  // Detectar formato colapsado DENTRO do frontmatter: linha com `intentional_error:`
  // seguida de conteúdo na mesma linha.
  // Corrupção: `intentional_error: description: "..." location: "..." ...`
  const collapsedOneLiner = /intentional_error\s*:.*description\s*:/i.test(fmBody);

  // Extrair bloco mapping: linhas indentadas após `intentional_error:`
  // O regex captura 1+ linhas com indentação (espaço ou tab) contendo `key: value`.
  // Nota: fmBody já está normalizado para LF (md.replace acima).
  const ieBlockMatch = fmBody.match(
    /intentional_error\s*:\s*\n((?:[ \t]+[\w-]+\s*:[ \t]*.+\n?)+)/,
  );

  if (collapsedOneLiner) {
    // Collapsed no frontmatter: intentional_error numa única linha
    return {
      ok: false,
      checked: true,
      message:
        "intentional_error corrompido no frontmatter: não está no formato mapping YAML (chaves indentadas). " +
        "Provável causa: title-picker colapsou o bloco multi-linha numa única linha. " +
        "Restaurar 02-reviewed.md do snapshot `_internal/02-pre-title-picker.md`.",
      missing_fields: [],
      collapsed: true,
    };
  }

  if (!ieBlockMatch) {
    // intentional_error existe mas sem sub-chaves indentadas (bloco vazio ou corrompido)
    return {
      ok: false,
      checked: true,
      message:
        "intentional_error sem sub-chaves: bloco mapping vazio ou corrompido no frontmatter. " +
        "Esperado: 5 campos indentados (description, location, category, correct_value, reveal).",
      missing_fields: [...REQUIRED_IE_FIELDS],
      collapsed: false,
    };
  }

  // Parse campos presentes no mapping
  const presentFields = new Set<string>();
  for (const line of ieBlockMatch[1].split("\n")) {
    const m = line.match(/^[ \t]+([\w-]+)\s*:/);
    if (m) presentFields.add(m[1]);
  }

  const missing = REQUIRED_IE_FIELDS.filter((f) => !presentFields.has(f));

  if (missing.length > 0) {
    return {
      ok: false,
      checked: true,
      message: `intentional_error incompleto: campos faltando — ${missing.join(", ")}`,
      missing_fields: missing,
      collapsed: false,
    };
  }

  return {
    ok: true,
    checked: true,
    message: "frontmatter intentional_error válido e completo",
    missing_fields: [],
    collapsed: false,
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
  const md = readFileSync(mdPath, "utf8");
  const result = validateFrontmatterYaml(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n[validate-frontmatter-yaml] FAIL: ${result.message}`);
    if (result.collapsed) {
      console.error(
        "  → Ação: restaurar 02-reviewed.md do snapshot _internal/02-pre-title-picker.md",
      );
    } else if (result.missing_fields.length > 0) {
      console.error(`  → Campos faltando: ${result.missing_fields.join(", ")}`);
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
