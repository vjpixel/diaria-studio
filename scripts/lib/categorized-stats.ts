/**
 * categorized-stats.ts (#477, #592)
 *
 * Helpers determinísticos para extrair métricas do `01-categorized.json` /
 * `01-approved.json` consumidos por `render-categorized-md.ts` e
 * `apply-gate-edits.ts` (linha de cobertura).
 *
 * Extraído pra `lib/` evitando ciclo de imports (render-categorized-md
 * depende de apply-gate-edits, e ambos precisam dessa métrica).
 */

import { existsSync, readFileSync } from "node:fs";

export interface CategorizedLikeJson {
  total_considered?: number;
  lancamento?: unknown[];
  pesquisa?: unknown[];
  noticias?: unknown[];
  tutorial?: unknown[];
  video?: unknown[];
}

/**
 * Calcula o total de artigos "considerados" antes da filtragem do scorer.
 *
 * Estratégia (compartilhada com render-categorized-md):
 *  1. Campo explícito `total_considered` no JSON (mais preciso).
 *  2. Auto-descoberta via `_internal/tmp-categorized.json` adjacente ao JSON
 *     de input — esse arquivo tem os artigos pós-dedup e pós-categorize,
 *     antes do filtro de score.
 *  3. Fallback: somar buckets do JSON corrente (post-filter — menos preciso
 *     mas estável).
 *
 * Retorna `null` se nenhuma das estratégias retornar valor positivo.
 */
export function computeTotalConsidered(
  inputPath: string,
  data: CategorizedLikeJson,
): number | null {
  if (typeof data.total_considered === "number" && data.total_considered > 0) {
    return data.total_considered;
  }

  const tmpCategorizedPath = inputPath
    .replace("01-categorized.json", "tmp-categorized.json")
    .replace("01-approved.json", "tmp-categorized.json");

  if (existsSync(tmpCategorizedPath)) {
    try {
      const tmpData: Record<string, unknown[]> = JSON.parse(
        readFileSync(tmpCategorizedPath, "utf8"),
      );
      const total =
        (tmpData.lancamento?.length ?? 0) +
        (tmpData.pesquisa?.length ?? 0) +
        (tmpData.noticias?.length ?? 0) +
        (tmpData.tutorial?.length ?? 0) +
        (tmpData.video?.length ?? 0);
      if (total > 0) return total;
    } catch {
      // Non-fatal — tmp-categorized.json may be malformed
    }
  }

  // Fallback: sum buckets do JSON corrente
  const fallback =
    (data.lancamento?.length ?? 0) +
    (data.pesquisa?.length ?? 0) +
    (data.noticias?.length ?? 0) +
    (data.tutorial?.length ?? 0) +
    (data.video?.length ?? 0);
  return fallback > 0 ? fallback : null;
}
