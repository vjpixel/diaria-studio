/**
 * fact-check-protection.ts (#11798, extraído no #12257)
 *
 * Lê `_internal/fact-check-autofix.json` da edição e devolve os trechos que o
 * fact-check do Stage 4 corrigiu (`suggested_fix` das entradas `applied`). É a
 * proteção que `filterClariceSuggestions` usa para a Clarice não desfazer a
 * revisão factual. Consumido por `scripts/clarice-filter.ts --edition-dir` e
 * pelo `resume` de `scripts/lib/clarice-pending.ts`.
 *
 * - log ausente → `{ present: false, correctedTexts: [] }`;
 * - log com `dry_run` → presente, sem trechos;
 * - log ilegível ou com `entries` que não é array → lança (o chamador aborta
 *   sem aplicar nada, fail-closed).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FACT_CHECK_AUTOFIX_REL = join("_internal", "fact-check-autofix.json");

export interface FactCheckProtection {
  /** O log existe (o fact-check do Stage 4 já rodou nesta edição). */
  present: boolean;
  /** `suggested_fix` das entradas aplicadas. */
  correctedTexts: string[];
}

export function readFactCheckProtection(editionDir: string): FactCheckProtection {
  const path = join(editionDir, FACT_CHECK_AUTOFIX_REL);
  if (!existsSync(path)) return { present: false, correctedTexts: [] };
  const log = JSON.parse(readFileSync(path, "utf8")) as { dry_run?: unknown; entries?: unknown };
  if (!Array.isArray(log.entries)) throw new Error(`${FACT_CHECK_AUTOFIX_REL}: entries deve ser array`);
  const correctedTexts: string[] = [];
  if (!log.dry_run) {
    for (const entry of log.entries as Array<{ status?: unknown; suggested_fix?: unknown }>) {
      if (entry.status === "applied" && typeof entry.suggested_fix === "string" && entry.suggested_fix.trim()) {
        correctedTexts.push(entry.suggested_fix);
      }
    }
  }
  return { present: true, correctedTexts };
}
