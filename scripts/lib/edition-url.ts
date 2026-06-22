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
 * Este módulo também expõe `validateNoPlaceholders` para o guard
 * anti-placeholder: garante que {edition_url} e {outros_count} nunca
 * chegam à fila de publicação do social.
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

/** Padrão de placeholders que não devem sobreviver ao Stage 5. */
const PLACEHOLDER_RE = /\{edition_url\}|\{outros_count\}/g;

/**
 * Valida que o texto não contém placeholders não-resolvidos.
 *
 * Retorna array com os placeholders encontrados (vazio = ok).
 * Caller deve abortar o dispatch se o array não estiver vazio.
 *
 * @param text - Conteúdo a validar (03-social.md ou trecho dele)
 * @returns Array de placeholders encontrados, ex: ["{edition_url}", "{outros_count}"]
 */
export function findUnresolvedPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    found.add(match[0]);
  }
  return [...found];
}
