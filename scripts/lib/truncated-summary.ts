/**
 * truncated-summary.ts (#2596)
 *
 * Helper para detectar `summary` truncado vindo de `og:description`.
 *
 * Muitos veículos (ex: Exame) truncam sua og:description com "…" no servidor,
 * produzindo frases incompletas que chegam até o render da newsletter. Este
 * helper identifica de forma conservadora quando um summary termina em reticências
 * de truncamento (distinguindo de reticências intencionais de estilo).
 *
 * Heurística (conservadora — falso-negativo é preferível a falso-positivo):
 *
 *   FLAG como truncado se:
 *     1. O texto (após trim) termina em `…` (U+2026) ou em `...` (3 pontos ASCII).
 *     2. A palavra imediatamente antes do ellipsis NÃO é uma conjunção/preposição/
 *        advérbio de lista, pois nesses casos o truncamento é evidente.
 *        OU a palavra indica fim-de-frase incompleto (conjunção pendente, preposição,
 *        artigo, pronome relativo — palavra que não fecha ideia).
 *
 *   NÃO flag (reticências intencionais) se:
 *     - A palavra antes do ellipsis fecha ideia: verbo, substantivo, adjetivo,
 *       numeral ou qualquer palavra que não seja gatilho claro de incompletude.
 *     - Ou seja: só flagra quando a palavra-gatilho antes do ellipsis indica
 *       que a frase foi cortada no meio de um sintagma pendente.
 *
 * Exemplos:
 *   "...conformidade…"      → TRUNCADO (última palavra "conformidade" + "…": parece cortado?)
 *   "e por aí vai..."       → NÃO truncado ("vai" é verbo, fecha ideia)
 *   "crescimento, inovação e..." → TRUNCADO ("e" é conjunção pendente)
 *   "regulação de..."        → TRUNCADO ("de" é preposição pendente)
 *   "tudo isso..."           → NÃO truncado ("isso" é pronome, fecha ideia)
 *
 * NOTA: A heurística é conservadora: só dispara quando há evidência clara de frase
 * incompleta. Reticências ao final de substantivo ou verbo = intencional → não flag.
 */

/**
 * Conjunções, preposições, artigos e pronomes relativos que, ao aparecer imediatamente
 * antes de "…"/"...", indicam truncamento involuntário (a frase foi cortada no meio
 * de um sintagma).
 *
 * Atenção: mantemos esta lista pequena e focada — palavras que sozinhas não fecham
 * ideia alguma. Ampliar com cautela.
 */
const PENDING_WORDS_PT = new Set([
  // conjunções coordenativas
  "e", "ou", "mas", "porém", "contudo", "todavia", "entretanto",
  "nem", "seja", "quer",
  // conjunções subordinativas comuns (cortadas no início do próximo termo)
  "que", "se", "como", "quando", "porque", "pois", "embora", "para",
  // preposições simples
  "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas",
  "a", "ao", "à", "às", "por", "pelo", "pela", "pelos", "pelas",
  "com", "sem", "sob", "sobre", "ante", "após", "até", "contra", "desde",
  "entre", "perante", "segundo", "trás",
  // artigos
  "o", "a", "os", "as", "um", "uma", "uns", "umas",
  // pronomes relativos / demonstrativos "pendurados"
  "cujo", "cuja", "cujos", "cujas", "cujo", "onde", "quem",
]);

const PENDING_WORDS_EN = new Set([
  "and", "or", "but", "nor", "so", "yet", "for",
  "that", "which", "who", "whom", "whose", "where", "when",
  "of", "in", "on", "at", "to", "by", "for", "with", "from",
  "the", "a", "an", "its", "their", "our", "your", "his", "her",
  "as", "if", "than", "because", "since", "though", "although",
]);

/** Combina ambos os conjuntos de palavras pendentes. */
const PENDING_WORDS = new Set([...PENDING_WORDS_PT, ...PENDING_WORDS_EN]);

/**
 * Retorna `true` se o summary parece truncado involuntariamente.
 *
 * Critérios:
 *   1. Termina em `…` (U+2026) ou `...` (3 ASCII dots).
 *   2. A palavra imediatamente anterior ao ellipsis é uma conjunção, preposição,
 *      artigo ou pronome relativo (indica que a frase foi cortada no meio de
 *      um sintagma — a palavra não fecha ideia).
 *
 * Casos que retornam `false` (não truncado):
 *   - Não termina em ellipsis.
 *   - Termina em ellipsis mas a palavra antes é substantivo, verbo ou adjetivo
 *     (reticências intencionais de estilo).
 */
export function isTruncatedSummary(summary: string): boolean {
  const trimmed = summary.trim();
  if (!trimmed) return false;

  // 1. Detectar sufixo de ellipsis (U+2026 ou 3 ASCII dots)
  let withoutEllipsis: string;
  if (trimmed.endsWith("…")) {
    withoutEllipsis = trimmed.slice(0, -1).trimEnd();
  } else if (trimmed.endsWith("...")) {
    withoutEllipsis = trimmed.slice(0, -3).trimEnd();
  } else {
    return false;
  }

  // 2. Extrair a última palavra antes do ellipsis
  const lastWordMatch = withoutEllipsis.match(/[\wÀ-ÿ]+(?:['''][\wÀ-ÿ]+)*$/u);
  if (!lastWordMatch) {
    // Sem palavra antes do ellipsis (só pontuação) → não flagrar
    return false;
  }

  const lastWord = lastWordMatch[0].toLowerCase();

  // 3. Flag apenas se a última palavra é conjunção/preposição/artigo pendente
  return PENDING_WORDS.has(lastWord);
}
