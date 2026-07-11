/**
 * edition-url.ts (#2454, write-then-validate #3223)
 *
 * Shared helpers para derivar a URL pública de uma edição Beehiiv
 * a partir do título (via seoSlug) sem precisar de post publicado.
 *
 * A URL pública do Beehiiv é determinística:
 *   https://diar.ia.br/p/{slug}
 * onde {slug} = seoSlug(title) — mesmo algoritmo usado em 4a-bis do
 * beehiiv-playbook.md para setar o campo SEO/URL slug do post draft.
 *
 * Este módulo também expõe:
 *   - `substituteEditionUrl` — substitui {edition_url} pela URL real num texto.
 *     Usado por resolve-edition-url.ts (#3223) para reescrever 03-social.md
 *     ANTES de validar, e por publish-linkedin.ts como resolução independente
 *     em memória no dispatch (defesa dupla — não depende deste helper).
 *   - `findUnresolvedPlaceholders` — guard anti-placeholder: detecta
 *     placeholder {snake_case} não-resolvido que chegaria à fila de publicação
 *     do social, EXCETO os deferred (ver DEFERRED_PLACEHOLDERS). Não-fatal
 *     desde #3277 — o caller (resolve-edition-url.ts) apenas avisa, não
 *     bloqueia o dispatch (ver docstring da função para o porquê).
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
 * Placeholders {snake_case} que são DEFERRED — resolvidos apenas no momento
 * do dispatch (publish-linkedin.ts), portanto SEMPRE presentes em 03-social.md
 * neste ponto do pipeline. Nunca rejeitados pelo guard.
 */
const DEFERRED_PLACEHOLDERS = new Set<string>(["{outros_count}"]);

/**
 * Padrão genérico de placeholder — qualquer token `{algum_nome}` (letras/
 * dígitos/underscore). Generalizado a partir do literal `{edition_url}` em
 * #3223: com resolve-edition-url.ts agora reescrevendo 03-social.md antes de
 * validar (write-then-validate), {edition_url} está SEMPRE resolvido nesse
 * ponto — um guard hardcoded a esse único literal ficaria toothless (sempre
 * passa, não detecta mais nada). Detectar qualquer placeholder remanescente
 * (exceto os deferred) mantém o guard útil como defesa contra placeholders
 * futuros que escapem da substituição.
 */
const PLACEHOLDER_RE = /\{[a-zA-Z][a-zA-Z0-9_]*\}/g;

/**
 * Detecta placeholders {snake_case} não-resolvidos no texto.
 *
 * {outros_count} (e demais DEFERRED_PLACEHOLDERS) é intencionalmente ignorado
 * — é resolvido pelo dispatch (publish-linkedin.ts) e estará presente em
 * 03-social.md neste ponto. Rejeitá-lo aqui causaria exit 3 em toda edição
 * (regressão #2454).
 *
 * Retorna array com os placeholders não-resolvidos encontrados (vazio = ok).
 *
 * Não-fatal por design (#3277): um placeholder {snake_case} genérico é
 * ambíguo — pode ser um bug real (template esqueceu de substituir) ou prosa
 * legítima citando um exemplo entre chaves (ex: nome de campo de API/prompt
 * numa newsletter de IA). Como a função não pode distinguir os dois casos de
 * forma confiável, ela apenas DETECTA — o caller (resolve-edition-url.ts)
 * decide o que fazer com o resultado. Desde #3277, o caller trata resultado
 * não-vazio como warning (log + segue o dispatch), não mais como abort fatal
 * — travar o dispatch social inteiro por um falso positivo tinha blast
 * radius desproporcional ao risco (issue #3277).
 *
 * @param text - Conteúdo a validar (03-social.md ou trecho dele)
 * @returns Array de placeholders encontrados, ex: ["{edition_url}"]
 */
export function findUnresolvedPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    if (!DEFERRED_PLACEHOLDERS.has(match[0])) found.add(match[0]);
  }
  return [...found];
}

/**
 * Substitui todas as ocorrências literais de `{edition_url}` por `editionUrl`
 * num texto. Extraído para reuso (#3223) — resolve-edition-url.ts usa isso
 * para reescrever 03-social.md ANTES de rodar o guard anti-placeholder
 * (write-then-validate), garantindo que `findUnresolvedPlaceholders` valide
 * o conteúdo JÁ substituído em vez do original intocado.
 *
 * publish-linkedin.ts mantém sua PRÓPRIA chamada `replaceAll("{edition_url}", ...)`
 * independente no dispatch (defesa dupla, redundante mas inofensiva) — não
 * foi migrada para usar este helper.
 *
 * Usa replacer FUNCTION (`() => editionUrl`), não string literal (#3314).
 * `String.prototype.replaceAll(str, replacement)` interpreta padrões especiais
 * (`$&`, `$$`, `` $` ``, `$'`) dentro do argumento `replacement` mesmo quando a
 * busca é uma string simples (algoritmo GetSubstitution do ECMA-262) — se
 * `editionUrl` contivesse um desses tokens, o resultado seria corrompido
 * (ex: `$&` seria expandido para o próprio match, `$$` viraria `$`). Uma
 * função replacer devolve o valor sempre como literal, sem essa interpretação.
 * Mesmo bug corrigido em `scripts/apply-factcheck-autofix.ts` (#3292/#3275) —
 * este call site é o irmão que ficou de fora daquele fix.
 *
 * @param text - Conteúdo original (pode ou não conter {edition_url})
 * @param editionUrl - URL resolvida a substituir
 * @returns Texto com {edition_url} substituído (idêntico ao original se ausente)
 */
export function substituteEditionUrl(text: string, editionUrl: string): string {
  return text.replaceAll("{edition_url}", () => editionUrl);
}
