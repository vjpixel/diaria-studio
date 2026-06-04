/**
 * lang-detect.ts (#1790 — unifica as 2 implementações divergentes de looksEnglish)
 *
 * Antes havia duas cópias divergentes de `looksEnglish`:
 *  - `categorize.ts`: bilíngue (EN_STOP + PT_STOP), Unicode (`\p{L}`), min 10
 *    palavras, threshold `en>15% && pt<8%`.
 *  - `stitch-newsletter.ts`: só EN (set menor), ASCII (`[^a-z]`), min 4 palavras,
 *    threshold `en>25%`.
 *
 * Esta é a versão canônica (a robusta do categorize), com `minWords`
 * parametrizável pra cobrir o caso de TÍTULO (curto → min 4) usado pelo filtro
 * de USE MELHOR do stitch, sem perder o bar de SUMMARY (min 10) do categorize.
 *
 * #1473: detecta se um texto está em inglês (vs português) por contagem de stop
 * words. Conservador — textos mistos ou curtos retornam false.
 */

const EN_STOP = new Set([
  "the", "is", "are", "was", "were", "be", "been", "being", "have", "has",
  "had", "do", "does", "did", "will", "would", "shall", "should", "may",
  "might", "must", "can", "could", "a", "an", "and", "but", "or", "nor",
  "for", "yet", "so", "in", "on", "at", "to", "of", "by", "with", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "not", "only", "same", "than", "too", "very", "that", "this", "these",
  "those", "it", "its", "which", "who", "whom", "what",
]);

const PT_STOP = new Set([
  "o", "a", "os", "as", "um", "uma", "uns", "umas", "de", "do", "da", "dos",
  "das", "em", "no", "na", "nos", "nas", "por", "para", "com", "sem", "sob",
  "sobre", "entre", "até", "após", "ante", "e", "ou", "mas", "nem", "que",
  "se", "como", "quando", "onde", "porque", "pois", "já", "não", "mais",
  "muito", "também", "ainda", "só", "foi", "são", "ser", "ter", "está",
  "há", "seu", "sua", "seus", "suas", "este", "esta", "esse", "essa",
  "isso", "isto", "aqui", "ali", "lá", "ela", "ele", "eles", "elas", "me",
  "te", "lhe", "nós", "vós",
]);

export interface LooksEnglishOpts {
  /** Mínimo de palavras pra avaliar (abaixo disso → false). Default 10
   * (apropriado pra summaries). Use 4 pra títulos curtos. */
  minWords?: number;
}

/**
 * `true` se o texto parece inglês: >15% das palavras são stop words inglesas
 * E <8% são portuguesas. Unicode-aware (`\p{L}`), case-insensitive.
 */
export function looksEnglish(text: string, opts: LooksEnglishOpts = {}): boolean {
  const minWords = opts.minWords ?? 10;
  if (!text) return false;
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, "")
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (words.length < minWords) return false;
  let en = 0;
  let pt = 0;
  for (const w of words) {
    if (EN_STOP.has(w)) en++;
    if (PT_STOP.has(w)) pt++;
  }
  const total = words.length;
  return en / total > 0.15 && pt / total < 0.08;
}
