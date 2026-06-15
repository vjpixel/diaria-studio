/**
 * lint-checks/intentional-error.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Verifica que `02-reviewed.md` tem `intentional_error` declarado no
 * frontmatter (#754). Editor adiciona manualmente após revisar a edição.
 *
 * Convenção editorial Diar.ia: cada edição inclui 1 erro proposital pros
 * assinantes acharem (concurso mensal). Sem declaração, `review-test-email`
 * não consegue distinguir erro intencional de erro real, e o concurso
 * mensal precisa lembrar manualmente o que era cada erro.
 *
 * Frontmatter esperado:
 * ```yaml
 * intentional_error:
 *   description: "..."
 *   location: "..."
 *   category: "factual|attribution|numeric|ortografico|data|version_inconsistency|factual_synthetic"
 *   correct_value: "..."
 * ```
 *
 * Roda no Stage 5 (publish-newsletter) ANTES de criar o draft no Beehiiv.
 * Falha bloqueia publicação.
 */

import { existsSync, readFileSync } from "node:fs";

export interface IntentionalErrorCheckResult {
  ok: boolean;
  label?: string;
  /** `no_error: true` when frontmatter is `intentional_error: none` (#2016) */
  no_error?: boolean;
  parsed?: {
    description?: string;
    location?: string;
    category?: string;
    correct_value?: string;
  };
}

const REQUIRED_INTENTIONAL_ERROR_FIELDS = [
  "description",
  "location",
  "category",
  "correct_value",
] as const;

/**
 * #1378: extrai conteúdo de bloco frontmatter YAML, aceitando posição
 * line-1 (canonical) ou inside first ~30 lines (caso editor adicione
 * manual após insert-titulo-subtitulo já ter colocado TÍTULO no topo).
 *
 * Retorna o body do frontmatter (entre os `---`) ou null se não houver.
 *
 * Pure helper — exportado pra teste.
 *
 * Implementação: itera todos os pares de `---` no topo do MD e retorna o
 * primeiro que tenha conteúdo não-vazio (line com `key:` ou similar).
 * Evita falso positivo com `---` separadores (ex: o `---` que fecha o
 * bloco TÍTULO/SUBTÍTULO).
 */
export function extractFrontmatter(md: string, scanLines = 30): string | null {
  // Tentar canonical primeiro (line 1) — fast path para o caso normal
  // \r?\n handles both LF (Unix) and CRLF (Windows) line endings (#2304).
  const canonical = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (canonical && canonical[1].trim().length > 0) return canonical[1];

  // Fallback (#1378): iterar pares de `---` dentro das primeiras N linhas
  // e retornar o primeiro com body não-vazio (qualquer linha com texto).
  const lines = md.split("\n");
  const fenceIndices: number[] = [];
  const scanLimit = Math.min(lines.length, scanLines + 10);
  for (let i = 0; i < scanLimit; i++) {
    if (lines[i].trim() === "---") fenceIndices.push(i);
  }
  for (let k = 0; k < fenceIndices.length - 1; k++) {
    const open = fenceIndices[k];
    const close = fenceIndices[k + 1];
    if (open >= scanLines) break;
    const body = lines.slice(open + 1, close).join("\n");
    if (body.trim().length > 0) return body;
  }
  return null;
}

export function checkIntentionalError(
  mdPath: string,
): IntentionalErrorCheckResult {
  if (!existsSync(mdPath)) {
    return {
      ok: false,
      label: `intentional_error_missing: ${mdPath} not found`,
    };
  }
  const md = readFileSync(mdPath, "utf8");

  // #1378: aceitar frontmatter em linha 1 OU dentro das primeiras 30 linhas.
  // Razão: insert-titulo-subtitulo.ts roda em Stage 2 e coloca bloco TÍTULO no
  // topo. Editor adiciona intentional_error via Drive em Stage 4 — sem reordenar
  // o MD, frontmatter cai DEPOIS do TÍTULO. Antes do #1378 isso quebrava o lint
  // silenciosamente; agora aceitamos qualquer posição razoável no topo.
  const fmMatch = extractFrontmatter(md);
  if (!fmMatch) {
    return {
      ok: false,
      label:
        "intentional_error_missing: 02-reviewed.md sem frontmatter — adicione bloco YAML com intentional_error",
    };
  }

  const fmBody = fmMatch;
  if (!/intentional_error\s*:/i.test(fmBody)) {
    return {
      ok: false,
      label:
        "intentional_error_missing: frontmatter sem chave intentional_error — adicione description/location/category/correct_value",
    };
  }

  // #2016: aceitar escalar `intentional_error: none` — editor declara
  // explicitamente que a edição não tem erro intencional (resposta válida do
  // leitor: "não há erro"). Lint passa; sync grava entry com no_error=true.
  const noneScalarMatch = fmBody.match(/intentional_error\s*:\s*(none|null)\s*(\n|$)/i);
  if (noneScalarMatch) {
    return { ok: true, no_error: true };
  }

  // Parse simple YAML — intentional_error is a mapping with 4 string fields.
  const parsed: IntentionalErrorCheckResult["parsed"] = {};
  const ieBlockMatch = fmBody.match(
    /intentional_error\s*:\s*\n((?:[ \t]+[\w-]+\s*:\s*.+\n?)+)/,
  );
  if (!ieBlockMatch) {
    return {
      ok: false,
      label:
        "intentional_error_missing: chave intentional_error não está no formato mapping (4 campos indentados)",
    };
  }
  for (const line of ieBlockMatch[1].split("\n")) {
    const m = line.match(/^[ \t]+(\w+)\s*:\s*"?(.*?)"?\s*$/);
    if (!m) continue;
    const key = m[1] as keyof typeof parsed;
    const value = m[2].trim();
    if (value.length > 0) parsed[key] = value;
  }

  const missing = REQUIRED_INTENTIONAL_ERROR_FIELDS.filter(
    (f) => !parsed[f as keyof typeof parsed],
  );
  if (missing.length > 0) {
    return {
      ok: false,
      label: `intentional_error_incomplete: campos faltando — ${missing.join(", ")}`,
      parsed,
    };
  }

  // P1 fix (#2300): reject placeholder values — ensureIntentionalErrorFrontmatter
  // inserts "{PREENCHER — ...}" strings that are non-empty and would otherwise pass
  // the completeness check above. If the editor forgets to fill them in,
  // sync-intentional-error.ts would record literal placeholders into intentional-errors.jsonl.
  const placeholderFields = REQUIRED_INTENTIONAL_ERROR_FIELDS.filter(
    (f) => /^\{PREENCHER/i.test(parsed[f as keyof typeof parsed] ?? ""),
  );
  if (placeholderFields.length > 0) {
    return {
      ok: false,
      label: `intentional_error_incomplete: campos com valor placeholder não preenchido — ${placeholderFields.join(", ")}`,
      parsed,
    };
  }

  return { ok: true, parsed };
}

/**
 * Categorias que requerem revisão manual (#2149 — regras do concurso "ache o erro"):
 * numeric, factual e data só são válidas como erro intencional se forem
 * inconsistência interna evidente (ex: título × corpo com valor diferente).
 * Quando usadas como "fato plausível mas errado", violam a Regra 2 (desinformação).
 *
 * Seguras por design: attribution, version_inconsistency, ortografico, factual_synthetic.
 */
const DESINFORMATION_RISK_CATEGORIES = new Set(["numeric", "factual", "data"]);

/** Discriminated union: safe=false garantia que warn está presente (#2149 F6). */
export type IntentionalErrorSafetyResult =
  | { safe: true; warn?: never }
  | { safe: false; warn: string };

/**
 * Verifica se a categoria declarada no frontmatter pertence ao grupo de risco
 * de desinformação (#2149, Regra 2). Emite warn (não bloqueia — a verificação
 * se é inconsistência interna é editorial, não computacional).
 *
 * Usado no lint do Stage 5 (--check intentional-error-flagged) após `checkIntentionalError`.
 * Chamado por `scripts/lint-newsletter-md.ts`.
 */
export function checkIntentionalErrorSafety(
  category: string | undefined,
): IntentionalErrorSafetyResult {
  if (!category) return { safe: true };
  if (DESINFORMATION_RISK_CATEGORIES.has(category.toLowerCase().trim())) {
    return {
      safe: false,
      warn:
        `intentional_error.category="${category.toLowerCase().trim()}" é categoria de risco (#2149). ` +
        `Verificar antes de publicar: (1) é inconsistência interna evidente no próprio email? ` +
        `(2) se não pego, o leitor passa a acreditar no fato/estatística falso? ` +
        `Se violar a regra 2, trocar por attribution/version_inconsistency/factual_synthetic.`,
    };
  }
  return { safe: true };
}
