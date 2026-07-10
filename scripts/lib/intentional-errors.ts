/**
 * intentional-errors.ts (#630, #754)
 *
 * Loader + matcher pra `data/intentional-errors.jsonl` (concurso mensal de
 * erro intencional). Permite que lints determinísticos distinguam:
 *   - **blocker**: erro real, deve bloquear publicação
 *   - **info**: erro intencional declarado, contagem mas não bloqueia
 *   - **ok**: nada detectado
 *
 * Schema da linha (1 JSON por linha):
 * ```
 * {
 *   "edition": "260506",
 *   "error_type": "version_inconsistency" | "numeric" | "factual" | "ortografico" | "attribution",
 *   "destaque": 1 | 2 | 3 | "outras_noticias" | "tutorial",
 *   "is_feature": true,
 *   "detail": "V4 no título, V5/V6/V7 nos parágrafos do D2",
 *   ...
 * }
 * ```
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type ErrorType =
  | "version_inconsistency"
  | "numeric"
  | "factual"
  | "factual_synthetic"
  | "ortografico"
  | "attribution"
  | "data";

export interface IntentionalError {
  edition: string;
  error_type: ErrorType | string;
  /** 1|2|3 (destaque numbered) ou "outras_noticias", "tutorial", "header", etc. */
  destaque?: number | string;
  is_feature: boolean;
  detail?: string;
  /** Narrativa livre "Nessa edição, …" (#1860) — gravada por entries source=
   * "prose_block" (publicação manual / declaração só na prosa). Preserva o
   * texto que o editor escreveu pra `composeRevealText` aplicar a lógica de
   * correção do #1443 ("o correto é Y") em vez de cair no `detail` cru. */
  narrative?: string;
  /** (#2419) Campo de reveal dedicado — prosa FIRST-PERSON, gramatical, pública,
   * que vira o texto do reveal publicado na edição SEGUINTE.
   * Ex: "Na última edição, escrevi 1990 onde o correto é 1998."
   * Separado de `description` (catálogo 3ª pessoa) e de `narrative` (legado).
   * Quando presente, composeRevealText usa este campo VERBATIM.
   * Fonte: `_internal/intentional-error.json.reveal` (#3222 — antes frontmatter YAML). */
  reveal?: string;
  /** Valor correto (#1443) — vem de `_internal/intentional-error.json.correct_value`
   * (#3222 — antes frontmatter YAML) e é usado pelo render-erro-intencional pra
   * garantir que o reveal da edição seguinte inclui "o correto é Y". */
  correct_value?: string;
  source?: string;
  detected_by?: string;
  resolution?: string;
  /** #2016: true when editor explicitly declared no intentional error for this edition.
   * Valid reader answer is "não há erro". list-month-errors shows this as "sem erro
   * intencional (resposta válida: 'não há erro')". lint-test-email skips body checks. */
  no_error?: boolean;
}

/**
 * Pure: parsifica JSONL, ignorando linhas vazias ou inválidas (tolerante a
 * arquivos parcialmente escritos durante append).
 */
export function parseIntentionalErrorsJsonl(content: string): IntentionalError[] {
  const out: IntentionalError[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as IntentionalError;
      if (parsed && typeof parsed.edition === "string") out.push(parsed);
    } catch {
      // linha corrompida → skip
      continue;
    }
  }
  return out;
}

/**
 * Carrega o JSONL do disco. Path ausente retorna [] (sem crash) — comportamento
 * por design: se o arquivo não existe ainda, presume zero erros intencionais.
 */
export function loadIntentionalErrors(path: string): IntentionalError[] {
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, "utf8");
    return parseIntentionalErrorsJsonl(content);
  } catch {
    return [];
  }
}

/**
 * Pure: filtra erros declarados pra uma edição específica.
 */
export function intentionalErrorsForEdition(
  errors: IntentionalError[],
  edition: string,
): IntentionalError[] {
  return errors.filter((e) => e.edition === edition);
}

/**
 * Pure: dado uma detecção (com `error_type` e opcionalmente `destaque`),
 * retorna `true` se há um erro intencional declarado que cobre essa detecção
 * pra essa edição. Match exige error_type igual; destaque match é opcional —
 * se a detecção não especifica destaque, qualquer entry do mesmo error_type
 * conta.
 */
export function isIntentionalError(
  detection: { error_type: string; destaque?: number | string },
  edition: string,
  errors: IntentionalError[],
): boolean {
  const candidates = intentionalErrorsForEdition(errors, edition);
  for (const e of candidates) {
    if (e.error_type !== detection.error_type) continue;
    // Se a detecção declara destaque, exige match (com normalização numérica)
    if (detection.destaque !== undefined && e.destaque !== undefined) {
      if (normalizeDestaque(detection.destaque) !== normalizeDestaque(e.destaque)) continue;
    }
    return true;
  }
  return false;
}

/**
 * Pure: normaliza destaque pra comparação string. "DESTAQUE 2", 2, "2" → "2".
 */
export function normalizeDestaque(d: number | string): string {
  const s = String(d).toLowerCase().trim();
  const m = s.match(/(\d+)/);
  return m ? m[1] : s;
}

/**
 * Pure: extrai número do destaque a partir de uma string `location` do
 * frontmatter (#754). Aceita formatos como "DESTAQUE 2, parágrafo 2",
 * "destaque 1", "OUTRAS NOTÍCIAS, item 3", etc.
 *
 * Retorna: 1|2|3 (destaque numerado), "outras_noticias", "lancamentos",
 * "pesquisas", "header", ou string vazia se não bate em nenhum padrão.
 */
export function destaqueFromLocation(location: string): number | string {
  if (typeof location !== "string") return "";
  const lower = location.toLowerCase();

  const dMatch = lower.match(/destaque\s*(\d+)/);
  if (dMatch) {
    const n = parseInt(dMatch[1], 10);
    if (n === 1 || n === 2 || n === 3) return n;
  }

  if (/outras\s*not[íi]cias/i.test(lower)) return "outras_noticias";
  if (/lan[çc]amentos/i.test(lower)) return "lancamentos";
  if (/pesquisas/i.test(lower)) return "pesquisas";
  if (/é\s*ia|eia|header|cabe[çc]alho/i.test(lower)) return "header";

  return "";
}

/**
 * Pure: converte frontmatter `intentional_error` (#754) pra entry compatível
 * com `data/intentional-errors.jsonl` (#630). Faz mapping de campos:
 *   description → detail
 *   category → error_type
 *   location → destaque (parsed via destaqueFromLocation)
 *   correct_value → preserved como campo adicional
 *
 * `is_feature: true` sempre — frontmatter declarado pelo editor é por
 * definição erro intencional.
 */
export interface IntentionalErrorFrontmatter {
  description?: string;
  location?: string;
  category?: string;
  correct_value?: string;
  /** (#2419) Campo de primeira pessoa, gramatical, público — fonte canônica do reveal.
   * Separado de `description` (catálogo 3ª pessoa, alimenta /diaria-mes-erros + lint).
   * Quando presente, o reveal usa este campo verbatim.
   * Ex: "Na última edição, escrevi 1990 onde o correto é 1998." */
  reveal?: string;
  /** (#3222) Editor declarou explicitamente que a edição não tem erro intencional —
   * mesma semântica do antigo escalar `intentional_error: none` no frontmatter YAML. */
  no_error?: boolean;
}

/**
 * (#3222) Alias — mesmo shape de `IntentionalErrorFrontmatter`, framing pós-migração.
 * `intentional_error` deixou de viver como frontmatter YAML em `02-reviewed.md`
 * (round-trip via Google Docs colapsava o bloco — #3205/#3222) e passou a viver em
 * `_internal/intentional-error.json`, arquivo local-only que nunca sincroniza com o
 * Drive (convenção `_internal/*`, #959). O nome do tipo é mantido por compat — os
 * campos são idênticos.
 */
export type IntentionalErrorJson = IntentionalErrorFrontmatter;

/**
 * (#3222) Path canônico do JSON estruturado do erro intencional, dado o diretório
 * da edição (`data/editions/{AAMMDD}/`).
 */
export function intentionalErrorJsonPath(editionDir: string): string {
  return join(editionDir, "_internal", "intentional-error.json");
}

/**
 * (#3222) Carrega + parseia `_internal/intentional-error.json`. Tolerante a arquivo
 * ausente ou corrompido — retorna `null` (equivalente ao antigo "frontmatter ausente"),
 * nunca lança.
 */
export function loadIntentionalErrorJson(path: string): IntentionalErrorJson | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as IntentionalErrorJson;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * (#3222) Grava `_internal/intentional-error.json` (pretty JSON, determinístico).
 * Cria `_internal/` se ausente.
 */
export function writeIntentionalErrorJson(path: string, record: IntentionalErrorJson): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", "utf8");
}

export function frontmatterToEntry(
  fm: IntentionalErrorFrontmatter,
  edition: string,
): IntentionalError {
  const destaque = fm.location ? destaqueFromLocation(fm.location) : "";
  return {
    edition,
    error_type: fm.category ?? "unknown",
    destaque: destaque || undefined,
    is_feature: true,
    detail: fm.description ?? "",
    correct_value: fm.correct_value,
    // (#2419) Campo reveal: quando presente no frontmatter, propagado para o JSONL
    // para que composeRevealText use verbatim em vez de sintetizar a partir de catálogo.
    ...(fm.reveal ? { reveal: fm.reveal } : {}),
    source: "frontmatter_02_reviewed",
    detected_by: "lint-newsletter-md.ts intentional-error-flagged",
    resolution: "published_intentionally",
  };
}

/**
 * #1589: compara dois entries pra detectar drift. Retorna `true` se os campos
 * derivados do frontmatter (error_type, destaque, detail, correct_value)
 * diverem.
 */
export function entryDiffersFromFrontmatter(
  existing: IntentionalError,
  fm: IntentionalErrorFrontmatter,
): boolean {
  const candidate = frontmatterToEntry(fm, existing.edition);
  return (
    existing.error_type !== candidate.error_type ||
    String(existing.destaque ?? "") !== String(candidate.destaque ?? "") ||
    (existing.detail ?? "") !== (candidate.detail ?? "") ||
    (existing.correct_value ?? "") !== (candidate.correct_value ?? "") ||
    // (#2419) Campo reveal — detectar drift quando editor edita o reveal no frontmatter
    (existing.reveal ?? "") !== (candidate.reveal ?? "")
  );
}

/**
 * Sync one-way (#1589): MD frontmatter é fonte autoritativa. Se já existe
 * entry pra `edition` com `source: "frontmatter_02_reviewed"`:
 *   - bate com o frontmatter atual → no-op
 *   - difere → substitui (mantém entries de outras editions intactas)
 * Se não existe entry, append.
 *
 * Pré-#1589: entry existente bloqueava qualquer sync, então editor que
 * editava o frontmatter pós-publish via stale data no JSONL → reveal
 * Frankenstein na próxima edição (260528 → 260529).
 */
export function syncFrontmatterToEntries(
  fm: IntentionalErrorFrontmatter,
  edition: string,
  existing: IntentionalError[],
): {
  added: boolean;
  updated: boolean;
  entries: IntentionalError[];
} {
  const idx = existing.findIndex(
    (e) => e.edition === edition && e.source === "frontmatter_02_reviewed",
  );
  if (idx === -1) {
    const newEntry = frontmatterToEntry(fm, edition);
    return { added: true, updated: false, entries: [...existing, newEntry] };
  }
  if (!entryDiffersFromFrontmatter(existing[idx], fm)) {
    return { added: false, updated: false, entries: existing };
  }
  const updatedEntry = frontmatterToEntry(fm, edition);
  const next = [...existing];
  next[idx] = updatedEntry;
  return { added: false, updated: true, entries: next };
}
