/**
 * lint-checks/intentional-error.ts (#1737 item 2 — extraído de lint-newsletter-md.ts;
 * #3222 — migrado de frontmatter YAML pra `_internal/intentional-error.json`)
 *
 * Verifica que a edição tem `intentional_error` declarado em
 * `_internal/intentional-error.json` (#754). Editor fornece os campos (via chat,
 * não mais editando o Drive) após revisar a edição.
 *
 * Convenção editorial Diar.ia: cada edição inclui 1 erro proposital pros
 * assinantes acharem (concurso mensal). Sem declaração, `review-test-email`
 * não consegue distinguir erro intencional de erro real, e o concurso
 * mensal precisa lembrar manualmente o que era cada erro.
 *
 * **Histórico (#3205/#3222):** até 260710 esses campos viviam em um bloco de
 * frontmatter YAML no topo de `02-reviewed.md`. Esse arquivo sincroniza com o
 * Google Drive/Docs (o editor revisa/edita lá) — e o round-trip de export do
 * Google Docs não preserva indentação/quebras de linha dentro de blocos `---`,
 * colapsando o YAML numa única linha corrompida (reproduzido 4x, #3205). A
 * correção move os campos estruturados pra `_internal/intentional-error.json`,
 * que nunca sincroniza com o Drive (convenção `_internal/*`, #959) — elimina a
 * classe de corrupção na fonte em vez de detectá-la/consertá-la depois.
 * A prosa "Nessa edição, …"/"Na última edição, …" (texto lido pelos assinantes)
 * continua em `02-reviewed.md` — só a estrutura machine-readable saiu de lá.
 *
 * JSON esperado (`_internal/intentional-error.json`):
 * ```json
 * {
 *   "description": "...",
 *   "location": "...",
 *   "category": "factual|attribution|numeric|ortografico|data|version_inconsistency|factual_synthetic",
 *   "correct_value": "...",
 *   "reveal": "..."
 * }
 * ```
 *
 * Roda no Stage 5 (publish-newsletter) ANTES de criar o draft no Beehiiv.
 * Falha bloqueia publicação.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadIntentionalErrorJson } from "../intentional-errors.ts";

export interface IntentionalErrorCheckResult {
  ok: boolean;
  label?: string;
  /** `no_error: true` when o JSON declara `{ "no_error": true }` (#2016, migrado #3222) */
  no_error?: boolean;
  parsed?: {
    description?: string;
    location?: string;
    category?: string;
    correct_value?: string;
    reveal?: string;
  };
}

const REQUIRED_INTENTIONAL_ERROR_FIELDS = [
  "description",
  "location",
  "category",
  "correct_value",
] as const;

/**
 * (#3222) Deriva o path de `_internal/intentional-error.json` a partir do path
 * de `02-reviewed.md` da mesma edição — sibling `_internal/` do mesmo diretório.
 * Mantém a assinatura de `checkIntentionalError(mdPath)` inalterada pros
 * callers (todos já passam o path do `02-reviewed.md`).
 */
export function intentionalErrorJsonPathFromMd(mdPath: string): string {
  return join(dirname(mdPath), "_internal", "intentional-error.json");
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

  const jsonPath = intentionalErrorJsonPathFromMd(mdPath);
  const record = loadIntentionalErrorJson(jsonPath);
  if (!record) {
    return {
      ok: false,
      label:
        `intentional_error_missing: ${jsonPath} ausente ou inválido — rode ` +
        `render-erro-intencional.ts (insere o placeholder) e peça ao editor a ` +
        `descrição do erro (description/location/category/correct_value/reveal)`,
    };
  }

  // #2016 (migrado #3222): `{ "no_error": true }` — editor declara explicitamente
  // que a edição não tem erro intencional (resposta válida do leitor: "não há
  // erro"). Lint passa; sync grava entry com no_error=true.
  if (record.no_error === true) {
    return { ok: true, no_error: true };
  }

  const parsed: IntentionalErrorCheckResult["parsed"] = {
    description: record.description,
    location: record.location,
    category: record.category,
    correct_value: record.correct_value,
    reveal: record.reveal,
  };

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

  // P1 fix (#2300): reject placeholder values — ensureIntentionalErrorJson insere
  // "{PREENCHER — ...}" strings não-vazias que passariam o check de completude acima.
  // Se o editor esquecer de preencher, sync-intentional-error.ts gravaria os
  // placeholders literais em intentional-errors.jsonl.
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
