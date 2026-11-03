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
 *
 * #11954: `currentReviewedDigest` é o digest do `02-reviewed.md` atual
 * (`sitePageReviewedDigest`). O `sourceDigest` sozinho não vê edição no corpo
 * do `02-reviewed.md` (box, destaque, Radar): a página é gerada de
 * `newsletter-final.html`, que só o pré-render do Stage 4 regera, e o
 * publisher do Kit monta o e-mail direto do `.md`. Editar o `.md` depois da
 * publicação deixava HTML e digest iguais, e a trava devolvia `merged` com a
 * página antiga. Ausente no state (anterior ao #11954) ou no disco → pula só
 * esta checagem.
 */
export function sitePageStaleness(
  state: Record<string, unknown>,
  expectedSlug: string | undefined,
  currentDigest: string | undefined,
  currentReviewedDigest?: string,
  currentReviewedSha256?: string,
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
  const stateReviewed = typeof state[SITE_PAGE_REVIEWED_DIGEST_FIELD] === "string"
    ? (state[SITE_PAGE_REVIEWED_DIGEST_FIELD] as string)
    : undefined;
  if (stateReviewed !== undefined && currentReviewedDigest !== undefined && stateReviewed !== currentReviewedDigest) {
    return (
      "02-reviewed.md mudou depois da publicação da página (#11954) — re-renderizar " +
      "_internal/newsletter-final.html (render-newsletter-html.ts + substitute-image-urls.ts) " +
      "ANTES de republicar, senão a página sai de novo com o texto antigo"
    );
  }
  // #11987: o `reviewedDigest` acima é o `.md` do MOMENTO da publicação, não o
  // que gerou o HTML. Republicar sem re-render (fallback do §6b-site) grava o
  // `.md` editado e a página antiga, e a checagem acima volta a passar. O
  // carimbo do render (`_internal/newsletter-render-source.json`, #10258)
  // registra o sha256 dos bytes do `.md` que o render leu; copiado pro state
  // na publicação, ele diz de qual `.md` a página publicada veio.
  const stateRenderedFrom = typeof state[SITE_PAGE_HTML_RENDERED_FROM_FIELD] === "string"
    ? (state[SITE_PAGE_HTML_RENDERED_FROM_FIELD] as string)
    : undefined;
  if (
    stateRenderedFrom !== undefined &&
    currentReviewedSha256 !== undefined &&
    stateRenderedFrom !== currentReviewedSha256
  ) {
    return (
      "a página publicada saiu de um newsletter-final.html renderizado de outra versão do 02-reviewed.md " +
      "(#11987: republicação sem re-render) — re-renderizar _internal/newsletter-final.html " +
      "(render-newsletter-html.ts + substitute-image-urls.ts) e só então republicar"
    );
  }
  return null;
}

/**
 * Campo do state file com o digest do `02-reviewed.md` no momento da
 * publicação da página (#11954). Gravado por `writeSitePageState`.
 */
export const SITE_PAGE_REVIEWED_DIGEST_FIELD = "reviewedDigest";

/**
 * Campo do state file com o sha256 do `02-reviewed.md` que GEROU o
 * `newsletter-final.html` publicado (#11987), copiado do carimbo do render
 * (`_internal/newsletter-render-source.json`, #10258) na publicação. Ausente
 * quando não havia carimbo (render anterior ao #10258) — a checagem é pulada.
 */
export const SITE_PAGE_HTML_RENDERED_FROM_FIELD = "htmlRenderedFromReviewedSha256";

/** Slug explícito registrado pela trava no state (#10207), ou `undefined`. */
export function recordedExpectedSlug(state: Record<string, unknown>): string | undefined {
  const v = state[SITE_PAGE_EXPECTED_SLUG_FIELD];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
