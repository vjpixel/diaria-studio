/**
 * ctr-utils.ts — helpers puros compartilhados entre analyze-h4.ts e
 * update-audience.ts. Extraído para quebrar o ciclo de importação ESM
 * entre os dois módulos (#1619).
 */

/**
 * Strip Aprofunde rows (#1564): destaques pré-mar/2026 usavam anchor "Aprofunde"
 * (link secundário com CTR estruturalmente mais alto ~1.5×). Pós-mar/2026 todos
 * usam título como anchor. Misturar os 2 regimes infla CTR de categorias com
 * muitos rows antigos.
 *
 * Pure: retorna true se anchor começa com "Aprofunde" (case-insensitive).
 */
export function isAprofundeAnchor(anchor: string): boolean {
  return /^aprofunde\b/i.test((anchor || "").trim());
}
