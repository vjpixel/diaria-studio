/**
 * roundup-detect.ts (#2691 item 1)
 *
 * Fonte única para detecção de conteúdo "roundup/newsletter" (compilação de
 * links, não tutorial acionável) — usado pra bloquear promoção ao bucket
 * USE MELHOR (precedência: roundup > how-to, #2663/#2666).
 *
 * Antes desta extração, a mesma heurística conservadora vivia DUPLICADA em 2
 * arquivos, sincronizada só por comentário ("Espelha ROUNDUP_SLUG_RE em
 * categorize.ts — manter em sincronia ao editar"):
 *   - `ROUNDUP_SLUG_RE` em categorize.ts (usado por `isRoundupSlug`)
 *   - `ROUNDUP_GUARD_RE` em use-melhor-curation.ts (usado por `isRadarHowToEligible`)
 *
 * Um 3º regex relacionado, mais AMPLO de propósito (aceita sinais mais fracos
 * porque roda em contexto warn-only), continua definido separadamente:
 *   - `NEWSLETTER_ROUNDUP_RE` em review-use-melhor.ts — inclui "weekly digest",
 *     "monthly recap", "and more" terminal. Não migrado pra cá pois é
 *     deliberadamente mais permissivo (ver docstring de `isNewsletterRoundup`).
 *
 * Não pode ser importado por `categorize.ts` nem `use-melhor-curation.ts`
 * criando dependência circular — este módulo é standalone (zero imports de
 * outros módulos do repo) de propósito, pra poder ser importado por ambos
 * (categorize.ts JÁ importa use-melhor-curation.ts — ver #2276).
 */

/**
 * Termos de ALTÍSSIMA precisão que indicam roundup/newsletter no slug ou
 * título. Conservador: "weekly" sozinho não entra (FP em "weekly-reports",
 * "build-weekly-digest-in-python"). "newsletter" e "roundup" são
 * suficientemente específicos como token isolado.
 */
export const ROUNDUP_GUARD_RE = /\b(newsletter|roundup|this[- ]week[- ]in)\b/i;

/**
 * #2691 item 3: exceção pra how-to GENUÍNO sobre criar/montar uma newsletter
 * — ex: "Como montar sua newsletter", "How to build a newsletter with Claude".
 * Sem esta exceção, `ROUNDUP_GUARD_RE` trata qualquer menção a "newsletter"
 * como compilação de links, mesmo quando o artigo ENSINA a construir uma.
 *
 * Escopo estreito de propósito: só a combinação verbo-de-criação (build/creat/
 * montar/criar) IMEDIATAMENTE antes de "newsletter"/"roundup" (com artigo/
 * possessivo opcional entre os dois) desativa o guard. Roundups reais nunca
 * têm esse padrão — "june-2026-langchain-newsletter", "weekly-ai-roundup"
 * não casam porque não há verbo de criação antes do substantivo.
 *
 * Caso real documentado (test/categorize.test.ts, antes do fix #2691 item 3):
 * "how-to-build-a-newsletter-with-claude" era aceito como FALSO-POSITIVO
 * conhecido — agora corretamente excluído.
 */
export const ROUNDUP_HOWTO_EXCEPTION_RE =
  /\b(?:build(?:ing)?|creat(?:e|ing)|montar|criar)[\s-]+(?:a|an|sua|uma)?[\s-]*(?:newsletter|roundup)\b/i;

/**
 * Detecta sinal de roundup/newsletter em um texto (slug OU título), com a
 * exceção de how-to genuíno sobre criar newsletter (#2691 item 3).
 */
export function hasRoundupSignal(text: string): boolean {
  if (!ROUNDUP_GUARD_RE.test(text)) return false;
  if (ROUNDUP_HOWTO_EXCEPTION_RE.test(text)) return false;
  return true;
}

/**
 * Extrai o "slug" textual de uma URL pra teste de regex de palavra — path
 * decodificado (percent-encoding resolvido) com separadores (`-`, `_`, `/`)
 * virando espaço. Usado consistentemente por todo detector de roundup/launch
 * baseado em slug (#2691 item 4 — antes uma rota decodificava e outra não).
 *
 * Retorna string vazia pra URL inválida (sem lançar).
 */
export function urlSlugText(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " ");
  } catch {
    return "";
  }
}

/**
 * Detecta sinal de roundup no slug da URL OU no título — consistente entre
 * os consumidores (#2691 item 2: antes `isRoundupSlug` em categorize.ts só
 * checava o slug, deixando escapar roundups cujo ÚNICO sinal está no título;
 * `isRadarHowToEligible`/`isNewsletterRoundup` já checavam ambos).
 */
export function hasRoundupSignalInUrlOrTitle(url: string, title: string): boolean {
  return hasRoundupSignal(urlSlugText(url)) || hasRoundupSignal(title);
}
