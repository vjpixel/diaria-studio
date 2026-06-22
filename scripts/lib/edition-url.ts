/**
 * edition-url.ts (#2454)
 *
 * Shared helpers para derivar a URL pública de uma edição Beehiiv
 * a partir do título (via seoSlug) sem precisar de post publicado.
 *
 * A URL pública do Beehiiv é determinística:
 *   https://diar.ia.br/p/{slug}
 * onde {slug} = seoSlug(title) — mesmo algoritmo usado em 4a-bis do
 * beehiiv-playbook.md para setar o campo SEO/URL slug do post draft.
 *
 * Este módulo também expõe `findUnresolvedPlaceholders` para o guard
 * anti-placeholder: garante que {edition_url} não chega à fila de
 * publicação do social com valor não-resolvido.
 *
 * Nota: {outros_count} é placeholder DEFERRED — resolvido pelo
 * publish-linkedin.ts durante o dispatch (não aqui). O guard NÃO
 * rejeita {outros_count} presente em 03-social.md antes do dispatch.
 */

import { seoSlug } from "./slug.ts";

/** Base URL pública da Diar.ia no Beehiiv. Não inclui trailing slash. */
export const BEEHIIV_BASE_URL = "https://diar.ia.br";

/**
 * Deriva a URL pública de uma edição a partir do título do post draft.
 *
 * Algoritmo: seoSlug(title) — mesmo usado em beehiiv-playbook.md §4a-bis
 * pra setar o campo SEO/URL slug. A URL pública do Beehiiv para um post
 * cujo slug é S é `https://diar.ia.br/p/{S}`.
 *
 * @param title - Título do post (D1 title da edição, ex: "Empregos e automação: pânico vs dados")
 * @returns URL pública completa, ex: "https://diar.ia.br/p/empregos-e-automacao-panico-vs-dados"
 */
export function deriveEditionUrl(title: string): string {
  const slug = seoSlug(title);
  return `${BEEHIIV_BASE_URL}/p/${slug}`;
}

/**
 * Placeholders que NÃO devem sobreviver ao guard anti-placeholder do Stage 5.
 *
 * Somente {edition_url} — resolvido por resolve-edition-url.ts antes do dispatch.
 * {outros_count} é DEFERRED: resolvido por publish-linkedin.ts no dispatch e
 * portanto sempre presente em 03-social.md neste ponto. Não deve ser rejeitado aqui.
 */
const UNRESOLVED_PLACEHOLDER_RE = /\{edition_url\}/g;

/**
 * Valida que o texto não contém {edition_url} não-resolvido.
 *
 * {outros_count} é intencionalmente ignorado — é resolvido pelo dispatch
 * (publish-linkedin.ts) e estará presente em 03-social.md neste ponto.
 * Rejeitar {outros_count} aqui causaria exit 3 em toda edição (regressão #2454).
 *
 * Retorna array com os placeholders não-resolvidos encontrados (vazio = ok).
 * Caller deve abortar o dispatch se o array não estiver vazio.
 *
 * @param text - Conteúdo a validar (03-social.md ou trecho dele)
 * @returns Array de placeholders encontrados, ex: ["{edition_url}"]
 */
export function findUnresolvedPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(UNRESOLVED_PLACEHOLDER_RE)) {
    found.add(match[0]);
  }
  return [...found];
}
