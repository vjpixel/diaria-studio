/**
 * coverage-bonus.ts (#3920)
 *
 * Bônus de score determinístico por cobertura ampla: quando várias fontes
 * cobrem a MESMA história (cluster same-story detectado no dedup, ver
 * `scripts/lib/cluster-sources.ts`), cada fonte ALÉM da primeira soma pontos
 * ao score do conteúdo. Cobertura ampla = sinal de relevância.
 *
 * Aplicado mecanicamente em TS (nunca pelo rubrico do scorer LLM), no
 * `merge-scored-chunks.ts` (antes da seleção de destaques, pra empurrar
 * histórias muito cobertas pra seleção) e registrado como campo auditável
 * `score_bonus_coverage` separado do score base.
 *
 * Decisão do editor (260722, issue #3920): **+5 por fonte extra, SEM TETO**.
 * O parâmetro `cap` existe pra facilitar reintroduzir um teto no futuro sem
 * mudar call sites — default `Infinity` (sem teto).
 */

/** Pontos somados por cada fonte ALÉM da primeira num cluster same-story. */
export const COVERAGE_BONUS_PER_SOURCE = 5;

/**
 * Bônus de cobertura para um cluster com `extraSourceCount` fontes além da
 * primeira (= `cluster_sources.length` do artigo vencedor).
 *
 * @param extraSourceCount número de fontes extras (perdedores do cluster).
 *   Valores negativos/NaN/fracionários são tratados como 0 (defensivo).
 * @param cap teto opcional do bônus. Default `Infinity` (sem teto — decisão
 *   do editor #3920).
 */
export function coverageBonus(
  extraSourceCount: number,
  cap: number = Infinity,
): number {
  if (!Number.isFinite(extraSourceCount) || extraSourceCount <= 0) return 0;
  const extras = Math.floor(extraSourceCount);
  const raw = extras * COVERAGE_BONUS_PER_SOURCE;
  return Math.min(raw, cap);
}
