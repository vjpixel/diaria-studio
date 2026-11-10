/**
 * Regras de bloqueio por link da auditoria de intake de newsletters (#12188, #12593).
 *
 * Fonte única para os dois lados que precisam concordar: o script de auditoria
 * (`scripts/audit-newsletter-intake.ts`, exit 1 no `--require-scores`) e o
 * invariante `newsletter-intake` do Stage 4 (`scripts/lib/invariant-checks/stage-4.ts`),
 * que relê o relatório gravado. Ficam aqui, num lib, para o invariante não
 * importar um script CLI.
 */

/** Forma mínima de um link do relatório (o JSON gravado pode vir de versão antiga). */
export interface IntakeLinkLike {
  score?: number | null;
  title?: string;
  fetch_error?: string;
  /** false = removido antes do pool (dedup/data); null/ausente = pool desconhecido. */
  in_pool?: boolean | null;
  destino?: string;
}

/** Destino de link que não está no `02-reviewed.md` (nem no `01-approved.json`). */
export const OUT_OF_EDITION = "fora da edição";

export function linkMissingScore(l: Pick<IntakeLinkLike, "score">): boolean {
  return typeof l.score !== "number" || !Number.isFinite(l.score);
}
export function linkMissingTitle(l: Pick<IntakeLinkLike, "title">): boolean {
  return !l.title?.trim() || l.title.startsWith("(newsletter:");
}
export function linkMissing(l: Pick<IntakeLinkLike, "score" | "title">): boolean {
  return linkMissingScore(l) || linkMissingTitle(l);
}

/**
 * #12188: só bloqueia quando NINGUÉM tentou — falha de fetch/enrich registrada
 * (paywall, 403, challenge) e link removido antes do pool (dedup/data) viram warning.
 */
export function linkAttemptedOrOutOfPool(l: Pick<IntakeLinkLike, "fetch_error" | "in_pool">): boolean {
  return (typeof l.fetch_error === "string" && l.fetch_error.length > 0) || l.in_pool === false;
}
/** Score ausente bloqueia? */
export function linkScoreBlocks(l: Pick<IntakeLinkLike, "score" | "fetch_error" | "in_pool">): boolean {
  return !linkAttemptedOrOutOfPool(l) && linkMissingScore(l);
}
/**
 * Título placeholder bloqueia? #12593: só para link NA edição. Link pontuado e fora
 * da edição já foi avaliado; o título ali é só exibição da tabela (warning). Relatório
 * sem `destino` (formato antigo) conta como na edição: na dúvida, bloqueia como antes.
 */
export function linkTitleBlocks(l: Pick<IntakeLinkLike, "score" | "title" | "fetch_error" | "in_pool" | "destino">): boolean {
  return !linkAttemptedOrOutOfPool(l) && linkMissingTitle(l) && (linkMissingScore(l) || l.destino !== OUT_OF_EDITION);
}
export function linkMissingBlocks(l: Pick<IntakeLinkLike, "score" | "title" | "fetch_error" | "in_pool" | "destino">): boolean {
  return linkScoreBlocks(l) || linkTitleBlocks(l);
}
