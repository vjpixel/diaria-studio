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

import { readFileSync, existsSync } from "node:fs";

export type ErrorType =
  | "version_inconsistency"
  | "numeric"
  | "factual"
  | "factual_synthetic"
  | "ortografico"
  | "attribution";

export interface IntentionalError {
  edition: string;
  error_type: ErrorType | string;
  /** 1|2|3 (destaque numbered) ou "outras_noticias", "tutorial", "header", etc. */
  destaque?: number | string;
  is_feature: boolean;
  detail?: string;
  source?: string;
  detected_by?: string;
  resolution?: string;
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
