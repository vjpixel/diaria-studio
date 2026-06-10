/**
 * word-joiner.ts (#2018 — extraído de newsletter-render-html.ts e monthly-render.ts)
 *
 * Helper compartilhado: WORD JOINER U+2060 anti auto-linkify de domínios
 * como "Clarice.ai" em clientes de email (Gmail, Apple Mail, Outlook).
 *
 * O WORD JOINER é inserido entre "." e o sufixo TLD — invisível para o leitor,
 * mas quebra o pattern-match de domínio do cliente de email. Links markdown
 * reais (`[Clarice.ai](https://...)`) não passam por aqui — só texto puro.
 *
 * #2018: refatorado como helper único consumido por BOTH renderers
 * (`newsletter-render-html.ts` e `monthly-render.ts`), eliminando a
 * duplicação das duas implementações quase-idênticas.
 *
 * refs #2048 (item 7)
 */

/**
 * Domínios que devem ser protegidos do auto-linkify.
 * Cada entrada é o sufixo após o ponto (case-insensitive, word boundary).
 *
 * Manter lista pequena e deliberada — só domínios que aparecem no conteúdo
 * editorial e são conhecidos por triggerar linkify nos clients de email.
 * "ai" é o caso canônico (Clarice.ai). Outros podem ser adicionados aqui.
 */
export const GUARDED_DOMAINS = ["ai"] as const;

/**
 * Regex que faz match de `word.domain` onde:
 * - `word` é uma palavra alfanumérica com possível maiúscula inicial
 * - `domain` é um dos GUARDED_DOMAINS
 * - Lookbehind negativo `(?<!\/|\w)` evita tocar URLs cruas (http://..., https://...)
 *   e domínios já dentro de uma sequência de palavras/hifens.
 *
 * O lookbehind `(?<!\/)` protege contra `/clarice.ai` (URLs cruas sem scheme
 * que ainda começam com `/`). O lookbehind `(?<![a-zA-Z0-9\-])` protege
 * `sub.clarice.ai` (subdomínio real — não é auto-linkify do cliente).
 *
 * Nota: a entidade `&#8288;` (WORD JOINER) é usada em vez do char U+2060
 * direto para compatibilidade com parsers HTML — ambos são invisíveis ao leitor.
 */
const GUARDED_PATTERN = new RegExp(
  `(?<![a-zA-Z0-9\\-\\/])\\b([A-Za-z][A-Za-z0-9]*)\\.(${GUARDED_DOMAINS.join("|")})\\b`,
  "gi",
);

/**
 * Aplica WORD JOINER entre "." e o TLD em domínios protegidos, mas **somente
 * em texto puro** — não dentro de URLs cruas (ex: href de um link com clarice.ai) nem
 * em atributos HTML. Destinado a segmentos de texto já HTML-escapados ou
 * texto raw (&#8288; é entity HTML segura nos dois contextos).
 *
 * Uso correto: chamar APÓS htmlEscape, em segmentos de texto puro.
 * Nunca chamar no `href` de um `<a>` — quebraria a URL.
 *
 * @example
 *   applyWordJoiner("Isso é Clarice.ai em texto puro")
 *   // → "Isso é Clarice.&#8288;ai em texto puro"
 *
 *   applyWordJoiner('<a href="https://clarice.ai/?via=diaria">Clarice.ai</a>')
 *   // ⚠️ Não fazer — href seria corrompido. Chamar só nos segmentos de texto.
 */
export function applyWordJoiner(s: string): string {
  // Reset lastIndex — a regex é global (tem flag `g`), estado compartilhado
  // em chamadas sucessivas. Reset garante comportamento idêntico a cada call.
  GUARDED_PATTERN.lastIndex = 0;
  return s.replace(GUARDED_PATTERN, "$1.&#8288;$2");
}
