/**
 * scripts/lib/site-page-staleness.ts (#10190, #10207)
 *
 * Detecção de página do site DEFASADA, compartilhada entre a trava do Stage 6
 * (`scripts/check-site-page-pr-gate.ts`, exit 5) e o invariante
 * `site-page-pr-merged` (`scripts/lib/invariant-checks/stage-6.ts`) — o
 * backstop do sentinel `.step-6-done.json` caso o §6c-site seja pulado.
 *
 * Até o #10207 só a trava conferia defasagem; o invariante aprovava qualquer
 * state com `merged: true`, então PR de `/p/A` mergeado + D1 retitulado pra B
 * + §6c-site pulado passava pelo sentinel e o e-mail saía linkando `/p/B` (404).
 * Uma única função pura aqui é o que garante que as duas superfícies não
 * divirjam de novo.
 */

/**
 * Campo do state file (`_internal/site-page-published.json`) onde a trava
 * registra o slug que recebeu por `--expected-slug` (#10207). O invariante lê
 * este campo antes de cair no `seoSlug` do D1 — sem ele, uma página publicada
 * com `--slug` explícito (fallback Beehiiv) seria acusada de defasada no
 * sentinel mesmo com a trava aprovando. Uma republicação (`writeSitePageState`)
 * reescreve o state e apaga o registro; a trava o grava de novo na chamada
 * seguinte com `--expected-slug`.
 */
export const SITE_PAGE_EXPECTED_SLUG_FIELD = "expectedSlug";

/**
 * Pura: a página registrada no state ainda corresponde ao que o e-mail vai
 * linkar? Devolve o motivo da defasagem, ou `null`.
 *
 * `expectedSlug` `undefined` = não deu pra derivar (sem `02-reviewed.md`/D1):
 * a checagem de slug é pulada — o D1 ilegível já é falha de outro guard, e
 * travar o Schedule por isso aqui seria bloquear sem ter o que republicar.
 * `currentDigest`/`state.sourceDigest` ausentes (state anterior ao #10190, ou
 * insumo sumido) pulam só a checagem de conteúdo.
 */
export function sitePageStaleness(
  state: Record<string, unknown>,
  expectedSlug: string | undefined,
  currentDigest: string | undefined,
): string | null {
  const stateSlug = typeof state.slug === "string" ? state.slug : undefined;
  if (expectedSlug !== undefined && stateSlug !== expectedSlug) {
    return (
      `slug da página publicada (${stateSlug ?? "ausente"}) difere do slug que o e-mail linka ` +
      `(${expectedSlug}) — o título do D1 mudou depois do §5b-site; /p/${expectedSlug} daria 404`
    );
  }
  const stateDigest = typeof state.sourceDigest === "string" ? state.sourceDigest : undefined;
  if (stateDigest !== undefined && currentDigest !== undefined && stateDigest !== currentDigest) {
    return (
      "insumos da página (newsletter-final.html / TÍTULO / SUBTÍTULO) mudaram depois da publicação — " +
      "a página no PR é anterior a uma correção do Stage 5"
    );
  }
  return null;
}

/** Slug explícito registrado pela trava no state (#10207), ou `undefined`. */
export function recordedExpectedSlug(state: Record<string, unknown>): string | undefined {
  const v = state[SITE_PAGE_EXPECTED_SLUG_FIELD];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
