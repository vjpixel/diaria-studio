/**
 * coverage-words.ts (#5314 review)
 *
 * Extração do padrão de pluralização PT-BR duplicado em 3 lugares
 * independentes: `scripts/lib/inbox-stats.ts` (`formatCoverageLine`),
 * `scripts/render-categorized-md.ts` (`formatCoverageLineUnknownTotal`),
 * `scripts/sync-coverage-line.ts` (`buildWelcomeCoverageSentence`).
 *
 * Histórico do duplicado (3 rodadas sem endereçar a causa raiz): #3696 criou
 * o 2º produtor; #3731 corrigiu o mesmo bug de concordância em cada um
 * independentemente; #5314 trocou "artigo"→"conteúdo" em cada um
 * independentemente (achado no code review da PR — 3ª rodada do mesmo gap).
 * Extraído aqui pra que a próxima mudança de wording precise editar só 1
 * lugar. `render-categorized-md.ts` não importava de `inbox-stats.ts` antes
 * (e não deveria passar a importar dali só por isso — módulo mais pesado,
 * puxa `CLARICE_SEED_EMAIL`); este módulo é standalone pelos 3.
 */

/** Escolhe singular/plural conforme `n === 1`. Genérico — qualquer par PT-BR. */
export function pluralPtBr(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

/**
 * Frase de seleção da coverage line ("selecionei o conteúdo mais relevante" /
 * "selecionei os N mais relevantes") — concordância singular/plural (#701).
 *
 * 260814 (#5314): trocado "artigo"→"conteúdo" no singular, espelhando o
 * totalWord — o pool selecionável já inclui newsletters capturadas
 * (#1541/#3696), não só links, então "artigo" era impreciso também aqui, não
 * só no total (achado de review: antes desta troca, uma edição com
 * `selected === 1` misturava "N conteúdos (...) e selecionei o artigo mais
 * relevante" na mesma frase).
 */
export function coverageSelPhrase(z: number): string {
  return z === 1 ? "selecionei o conteúdo mais relevante" : `selecionei os ${z} mais relevantes`;
}
